import { Context, InputFile } from 'grammy';
import { config } from '../config.js';
import { transcribeAudio } from '../services/whisper.js';
import { analyzeTranscript } from '../services/analysis.js';
import { scheduleReminders } from '../services/scheduler.js';
import { savePlan, getConflicts } from '../services/planStore.js';
import { getUserConfig } from '../services/userConfig.js';
import { searchPlace, getWeatherForecast, getDirections, generateLocationAdvice } from '../services/location.js';
import { savePending } from '../services/pendingStore.js';
import { buildConflictMessage, getConflictKeyboard } from '../services/messages.js';
import { startDeliveryFlow } from '../services/delivery.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const SEP = '———————————————';

async function downloadFile(url: string, dest: string): Promise<void> {
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
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
    }).on('error', (e) => { fs.unlinkSync(dest); reject(e); });
  });
}



export async function handleVoice(ctx: Context) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || '?';
  if (!ctx.message?.voice) return;
  if (!userId) return;
  if (config.allowedUserId && userId !== config.allowedUserId) { await ctx.reply('Access denied.'); return; }

  const recordedAt = new Date();
  const statusMsg = await ctx.reply('Transcribing...');
  let tempFile = '', transcript = '';

  try {
    // 1. Download voice message
    const f = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`;
    const tmpDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFile = path.join(tmpDir, `v_${Date.now()}.ogg`);
    await downloadFile(url, tempFile);

    // 2. Transcribe
    transcript = await transcribeAudio(tempFile);
    if (!transcript?.trim()) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Could not recognize speech.');
      return;
    }

    // 3. Analyze
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Analyzing...');
    let analysis;
    try {
      analysis = await analyzeTranscript(transcript);
    } catch (e) {
      console.error('[Voice] Analysis failed:', e);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `Analysis failed.\n\n${transcript}`);
      return;
    }

    // Location Assistant
    let locationAdvice = '';
    if (analysis.location_query) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Checking location...');
      const userSettings = getUserConfig(userId);
      const hasCoords = userSettings.lat !== undefined && userSettings.lng !== undefined;
      const targetTime = analysis.visit_datetime || new Date().toISOString();
      try {
        const placePromise = searchPlace(analysis.location_query);
        const weatherPromise = hasCoords ? getWeatherForecast(userSettings.lat!, userSettings.lng!, targetTime, analysis.language) : Promise.resolve(null);
        const directionsPromise = hasCoords ? getDirections(userSettings.lat!, userSettings.lng!, analysis.location_query) : Promise.resolve(null);
        const [place, weather, directions] = await Promise.all([placePromise, weatherPromise, directionsPromise]);
        locationAdvice = await generateLocationAdvice(analysis.location_query, targetTime, place, weather, directions, analysis.language);
      } catch (err) {
        console.error('[Voice] Location assistant error:', err);
      }
    }

    // Conflict detection
    const conflicts = ctx.from ? getConflicts(userId, analysis.todos) : [];

    // Prepare pending note state
    const pendingData = {
      userId,
      chatId: ctx.chat!.id,
      analysis,
      conflicts,
      phase: conflicts.length > 0 ? 'conflict' as const : 'reminder' as const,
      resolvedTodos: analysis.todos,
      reminderIndex: 0
    };
    
    const pendingId = savePending(pendingData);

    // If conflict detected, STOP flow and show buttons
    if (conflicts.length > 0) {
      const conflictMsg = buildConflictMessage(conflicts, analysis.language);
      const keyboard = getConflictKeyboard(pendingId, analysis.language);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, conflictMsg, { reply_markup: keyboard });
      return; 
    }

    // Delete status message if no conflict
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

    // Save plan and schedule initial reminders
    if (ctx.chat) {
      savePlan(ctx.chat.id, userId, analysis);
      const timedTasks = analysis.todos.filter(t => t.time);
      if (timedTasks.length > 0) {
        scheduleReminders(ctx.chat.id, userId, analysis.todos, analysis.language);
      }
    }

    // If Location Advice exists, send it first
    if (locationAdvice) {
      const locationHeader = analysis.language === 'ru' ? 'ЛОКАЦИЯ\n\n' : analysis.language === 'kk' ? 'ЛОКАЦИЯ\n\n' : 'LOCATION\n\n';
      await ctx.reply(locationHeader + locationAdvice);
    }

    // Delegate remaining output to delivery helper
    await startDeliveryFlow(ctx, { ...pendingData, id: pendingId, createdAt: Date.now() });

    console.log(`[Voice] Processed: "${analysis.title}" [${analysis.language}]`);

  } catch (error) {
    console.error('[Voice] Error:', error);
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('Failed to transcribe')) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Could not recognize speech.');
    } else if (transcript) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `Error during processing.\n\n${transcript.substring(0, 4000)}`);
    } else {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Something went wrong.');
    }
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}
