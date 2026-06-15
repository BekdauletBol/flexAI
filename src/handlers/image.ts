import { Context } from 'grammy';
import { config } from '../config.js';
import OpenAI from 'openai';
import { v4 as uuid } from 'uuid';
import { AnalysisResult } from '../types/analysis.js';
import { savePlan, getConflicts } from '../services/planStore.js';
import { savePending } from '../services/pendingStore.js';
import { startDeliveryFlow } from '../services/delivery.js';
import { buildCombinedConflictMessage, getCombinedConflictKeyboard, getNavKeyboard } from '../services/messages.js';
import { getUserConfig } from '../services/userConfig.js';
import { scheduleReminders } from '../services/scheduler.js';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  timeout: 60000,
  maxRetries: 1,
});

async function downloadFile(url: string, dest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject); return;
      }
      if (res.statusCode !== 200) { file.close(); fs.unlinkSync(dest); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
      file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
    }).on('error', (e) => { fs.unlinkSync(dest); reject(e); });
  });
}

function imageToBase64(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return data.toString('base64');
}

export async function handleImage(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!ctx.message?.photo) return;
  if (config.allowedUserId && userId !== config.allowedUserId) {
    await ctx.reply('Access denied.');
    return;
  }

  const userLang = getUserConfig(userId).language || 'en';
  const analyzeMsg = userLang === 'ru' ? 'Анализирую скриншот...' : userLang === 'kk' ? 'Скриншотты талдау...' : 'Analyzing screenshot...';
  const statusMsg = await ctx.reply(analyzeMsg);
  let tempFile = '';

  try {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const f = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`;
    const tmpDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFile = path.join(tmpDir, `img_${Date.now()}.jpg`);
    await downloadFile(url, tempFile);

    const base64Image = imageToBase64(tempFile);
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'high' }
            },
            {
              type: 'text',
              text: `You are analyzing a screenshot to extract tasks and schedule items. Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

Identify the type of screenshot (Teams meeting, Notion, calendar, task list, email, etc.)

Extract ALL visible tasks, meetings, events, or to-do items.

Return ONLY this JSON:
{
  "source_type": "Teams calendar / Notion / Task list / Email / Other",
  "tasks": [
    {
      "task": "task name in the same language as the screenshot",
      "date": "YYYY-MM-DD or null",
      "time": "HH:MM or null",
      "duration_minutes": 30,
      "priority": "high/medium/low"
    }
  ]
}

If you see no tasks or schedule items, return { "source_type": "Unknown", "tasks": [] }`
            }
          ] as any
        }
      ],
      max_tokens: 2048,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty vision response');

    const result = JSON.parse(content);
    if (!result.tasks || result.tasks.length === 0) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id,
        userLang === 'ru' ? 'Не вижу задач на этом скриншоте.'
        : userLang === 'kk' ? 'Бұл скриншотта тапсырмалар көрінбейді.'
        : 'I don\'t see any tasks in this screenshot.');
      return;
    }

    const lang = userLang;
    const todos = result.tasks.map((t: any) => ({
      id: uuid(),
      task: t.task || '',
      priority: (['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium') as any,
      done: false,
      time: t.time || undefined,
      date: t.date || undefined,
      duration: t.duration_minutes || 30,
      location: t.location || undefined,
    }));

    const analysis: AnalysisResult = {
      intent: 'action',
      title: `From ${result.source_type}`,
      summary: `Extracted ${todos.length} tasks from ${result.source_type} screenshot.`,
      key_points: [],
      todos,
      tags: [`#${result.source_type.split(' ')[0].toLowerCase()}`],
      raw_transcript: '[from image]',
      language: lang,
      timeframe: 'day',
      needs_location_check: false,
    };

    const taskList = todos
      .map((t: any) => `— ${t.task}${t.time ? ' · ' + t.time : ''}`)
      .join('\n');

    const header = lang === 'ru' ? 'СКРИНШОТ' : lang === 'kk' ? 'СКРИНШОТ' : 'SCREENSHOT';
    const confirmText = lang === 'ru' ? 'Добавить в план?' : lang === 'kk' ? 'Жоспарға қосу?' : 'Add to plan?';
    
    const messageText = `${header} — ${result.source_type}\n\n${taskList}\n\n${confirmText}`;

    const pendingData = {
      userId,
      chatId: ctx.chat!.id,
      analysis,
      conflicts: [] as any[],
      phase: 'reminder' as const,
      resolvedTodos: todos,
      reminderIndex: 0,
    };
    const pendingId = savePending(pendingData);

    const confirmKb = new (await import('grammy')).InlineKeyboard()
      .text(lang === 'ru' ? 'Добавить всё' : lang === 'kk' ? 'Бәрін қосу' : 'Add all', `img_confirm_${pendingId}`)
      .text(lang === 'ru' ? 'Отмена' : lang === 'kk' ? 'Болдырмау' : 'Cancel', `img_cancel_${pendingId}`);

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, messageText, { reply_markup: confirmKb });

  } catch (error) {
    console.error('[Image] Error:', error);
    try {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Failed to analyze image.');
    } catch {}
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}
