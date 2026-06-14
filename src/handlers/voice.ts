import { Context, InputFile, InlineKeyboard } from 'grammy';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { transcribeAudio } from '../services/whisper.js';
import { analyzeTranscript } from '../services/analysis.js';
import { scheduleReminders } from '../services/scheduler.js';
import { savePlan, detectTimeConflicts, getPlan } from '../services/planStore.js';
import { setUserLocation, getUserConfig } from '../services/userConfig.js';
import { geocodeCity, searchPlace, getWeatherForecast, getDirections, generateLocationAdvice } from '../services/location.js';
import { savePending } from '../services/pendingStore.js';
import { buildConflictMessage, getConflictKeyboard } from '../services/messages.js';
import { startDeliveryFlow } from '../services/delivery.js';
import { AnalysisResult } from '../types/analysis.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

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
  if (!ctx.message?.voice) return;
  if (!userId) return;
  if (config.allowedUserId && userId !== config.allowedUserId) { await ctx.reply('Access denied.'); return; }

  const statusMsg = await ctx.reply('Transcribing...');
  let tempFile = '', transcript = '';

  try {
    const f = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`;
    const tmpDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFile = path.join(tmpDir, `v_${Date.now()}.ogg`);
    await downloadFile(url, tempFile);

    transcript = await transcribeAudio(tempFile);
    if (!transcript?.trim()) { 
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Could not recognize speech.'); 
      return; 
    }

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Analyzing...');
    let analysis: AnalysisResult;
    try { 
      analysis = await analyzeTranscript(transcript); 
    } catch (e) {
      logger.error(e, '[Voice] Analysis failed:');
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `Analysis failed.\n\n${transcript}`);
      return;
    }

    // --- Intent handling from HEAD ---
    if (analysis.intent === 'social') {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Got it.');
      return;
    }

    if (analysis.intent === 'reschedule') {
      const lang = analysis.language || 'ru';
      const msg = lang === 'ru' ? 'Чтобы перенести задачу, напишите: "перенеси [задача] на [время]"'
        : lang === 'kk' ? 'Тапсырманы ауыстыру үшін: "перенеси [тапсырма] на [уақыт]" деп жазыңыз'
        : 'To reschedule a task, write: "move [task] to [time]"';
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, msg);
      return;
    }

    if (analysis.intent === 'query') {
      const date = analysis.query_date;
      const chatId = ctx.chat!.id;
      const plan = getPlan(chatId);
      const lang = analysis.language || 'ru';

      if (!plan || !plan.todos || plan.todos.length === 0) {
        const msg = date
          ? (lang === 'ru' ? `На ${date} задач нет.`
            : lang === 'kk' ? `${date} күніне тапсырмалар жоқ.`
            : `Nothing planned for ${date}.`)
          : (lang === 'ru' ? 'Нет активных задач.'
            : lang === 'kk' ? 'Белсенді тапсырмалар жоқ.'
            : 'No active tasks.');
        await ctx.api.editMessageText(chatId, statusMsg.message_id, msg);
        return;
      }

      const tasksOnDate = date
        ? plan.todos.filter((t: any) => t.date === date && !t.done)
        : plan.todos.filter((t: any) => !t.done);

      if (tasksOnDate.length === 0) {
        const msg = date
          ? (lang === 'ru' ? `На ${date} задач нет.`
            : lang === 'kk' ? `${date} күніне тапсырмалар жоқ.`
            : `Nothing planned for ${date}.`)
          : (lang === 'ru' ? 'Нет активных задач.'
            : lang === 'kk' ? 'Белсенді тапсырмалар жоқ.'
            : 'No active tasks.');
        await ctx.api.editMessageText(chatId, statusMsg.message_id, msg);
        return;
      }

      const lines = tasksOnDate.map((t: any) => {
        let suffix = '';
        if (t.time) suffix = ` · ${t.time}`;
        const priorityLabel = t.priority.toUpperCase();
        return `— ${t.task}${suffix} · ${priorityLabel}`;
      });

      const header = date ? `${date.toUpperCase()}` : (lang === 'ru' ? 'АКТИВНЫЕ ЗАДАЧИ'
        : lang === 'kk' ? 'БЕЛСЕНДІ ТАПСЫРМАЛАР'
        : 'ACTIVE TASKS');

      const footer = lang === 'ru'
        ? `\n\n${tasksOnDate.length} ${tasksOnDate.length === 1 ? 'задача' : 'задач'}`
        : lang === 'kk' ? `\n\n${tasksOnDate.length} тапсырма`
        : `\n\n${tasksOnDate.length} task${tasksOnDate.length === 1 ? '' : 's'}`;

      await ctx.api.editMessageText(chatId, statusMsg.message_id, `${header}\n\n${lines.join('\n')}${footer}`);
      return;
    }

    // --- Action intent processing from origin/main ---

    // Save user city if detected
    if (analysis.user_city) {
      try {
        const coords = await geocodeCity(analysis.user_city);
        if (coords) {
          setUserLocation(userId, analysis.user_city, coords.lat, coords.lng);
        }
      } catch {}
    }

    // Location Assistant logic
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
        logger.error(err, '[Voice] Location assistant error:');
      }
    }

    // Conflict detection
    const conflicts = detectTimeConflicts(userId, analysis.todos);

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

    // If conflict detected, show buttons
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

    // If Location Advice exists, send it
    if (locationAdvice) {
      const locationHeader = analysis.language === 'ru' ? 'ЛОКАЦИЯ\n\n' : analysis.language === 'kk' ? 'ЛОКАЦИЯ\n\n' : 'LOCATION\n\n';
      await ctx.reply(locationHeader + locationAdvice);
    }

    // Delegate remaining output to delivery helper
    await startDeliveryFlow(ctx, { ...pendingData, id: pendingId, createdAt: Date.now() });

    logger.info(`[Voice] Processed: "${analysis.title}" [${analysis.language}]`);

  } catch (error) {
    logger.error(error, '[Voice] Error:');
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
