import { Context, InputFile } from 'grammy';
import { config } from '../config.js';
import { transcribeAudio } from '../services/whisper.js';
import { analyzeTranscript } from '../services/analysis.js';
import { scheduleReminders, cancelReminderByTaskId } from '../services/scheduler.js';
import { savePlan, getConflicts, deleteTaskById, findTaskByText, deletePlansByDate, getUserTasks, getAllPlansForLLM, getAllPlans, getWeeklyPlans, archiveCompletedTasks } from '../services/planStore.js';
import { getUserConfig, setUserLanguage } from '../services/userConfig.js';
import { searchPlace, getWeatherForecast, getDirections, generateLocationAdvice } from '../services/location.js';
import { savePending } from '../services/pendingStore.js';
import { buildConflictMessage, getConflictKeyboard, getNavKeyboard } from '../services/messages.js';
import { startDeliveryFlow } from '../services/delivery.js';
import { detectIntent, askQuestion, chatReply, extractRescheduleInfo, extractDeleteInfo, extractViewInfo, extractMemoryUpdate } from '../services/intent.js';
import { getUserMemory, updateUserMemory, formatMemoryForDisplay } from '../services/memoryStore.js';
import { generateReportPdf } from '../services/pdf.js';
import { generateFullReport, generateWeeklyReport } from '../services/reporter.js';
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

function formatViewDate(date: Date, lang: string): string {
  return date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : lang === 'kk' ? 'kk-KZ' : 'en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function formatViewPlans(plans: any[], lang: string): string {
  if (plans.length === 0) {
    return lang === 'ru' ? 'Нет планов на этот период.' : lang === 'kk' ? 'Бұл кезеңге жоспарлар жоқ.' : 'No plans for this period.';
  }
  const lines: string[] = [];
  for (const plan of plans) {
    const date = formatViewDate(new Date(plan.createdAt), lang);
    lines.push('');
    lines.push(date);
    lines.push('');
    for (const t of plan.todos) {
      const pMark = t.priority === 'high' ? 'HIGH' : t.priority === 'medium' ? 'MED' : 'LOW';
      const timeStr = t.time ? `${t.time} ` : '';
      const locStr = t.location ? ` [${t.location}]` : '';
      lines.push(`  ${timeStr}${t.task} · ${pMark}${locStr}`);
    }
  }
  return lines.join('\n');
}

export async function handleVoice(ctx: Context) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || '?';
  if (!ctx.message?.voice) return;
  if (!userId) return;
  if (config.allowedUserId && userId !== config.allowedUserId) { await ctx.reply('Access denied.'); return; }

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

    // 3. Intent detection
    try { await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Analyzing...'); } catch {}
    const intentResult = await detectIntent(transcript);
    const lang = getUserConfig(userId).language || 'en';

    // Auto-update memory
    try {
      const currentMem = JSON.stringify(getUserMemory(userId));
      const memUpdateRaw = await extractMemoryUpdate(transcript, currentMem);
      if (memUpdateRaw) {
        const parsed = JSON.parse(memUpdateRaw);
        if (parsed.should_update) {
          updateUserMemory(userId, parsed.memory_update);
        }
      }
    } catch (e) { console.error('[Voice] Memory update error:', e); }

    // Low confidence → ask clarification
    if (intentResult.confidence < 0.6 && intentResult.intent !== 'plan') {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id,
        lang === 'ru' ? 'Вы хотите запланировать это или просто спросить?'
        : lang === 'kk' ? 'Сіз мұны жоспарлағыңыз келе ме, әлде сұрағыңыз келе ме?'
        : 'Did you want to schedule this or were you just asking?');
      return;
    }

    // Route by intent
    if (intentResult.intent === 'plan') {
      await handlePlanIntent(ctx, userId, transcript, statusMsg, lang);
    } else if (intentResult.intent === 'question') {
      await handleQuestionIntent(ctx, userId, transcript, statusMsg, lang);
    } else if (intentResult.intent === 'memory_query') {
      await handleMemoryQueryIntent(ctx, userId, statusMsg, lang);
    } else if (intentResult.intent === 'reschedule') {
      await handleRescheduleIntent(ctx, userId, transcript, statusMsg, lang);
    } else if (intentResult.intent === 'delete') {
      await handleDeleteIntent(ctx, userId, transcript, statusMsg, lang);
    } else if (intentResult.intent === 'view') {
      await handleViewIntent(ctx, userId, transcript, statusMsg, lang);
    } else if (intentResult.intent === 'chat') {
      await handleChatIntent(ctx, userId, transcript, statusMsg, lang);
    } else if (intentResult.intent === 'command') {
      await handleCommandIntent(ctx, userId, intentResult, statusMsg, lang);
    }

    console.log(`[Voice] Done: ${intentResult.intent} from @${username}`);

  } catch (error) {
    console.error('[Voice] Error:', error);
    const msg = error instanceof Error ? error.message : '';
    try {
      if (msg.includes('Failed to transcribe')) {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Could not recognize speech.');
      } else if (msg.startsWith('TRANSCRIPT_FALLBACK:')) {
        const t = msg.substring('TRANSCRIPT_FALLBACK:'.length);
        const text = t.length > 3900 ? t.substring(0, 3900) + '...' : t;
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `Analysis failed. Transcript:\n\n${text}`);
      } else {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Something went wrong.');
      }
    } catch {} 
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}

// ─── Intent Handlers ──────────────────────────────────────────────────────────

async function handlePlanIntent(ctx: Context, userId: number, transcript: string, statusMsg: any, defaultLang: string) {
  try { await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Processing...'); } catch {}

  let analysis;
  try {
    analysis = await analyzeTranscript(transcript);
  } catch (e) {
    console.error('[Voice] Analysis failed:', e);
    const msg = e instanceof Error ? e.message : '';
    if (msg.startsWith('TRANSCRIPT_FALLBACK:')) {
      const t = msg.substring('TRANSCRIPT_FALLBACK:'.length);
      const text = t.length > 3900 ? t.substring(0, 3900) + '...' : t;
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `Analysis failed. Transcript:\n\n${text}`);
    } else {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Analysis failed.');
    }
    return;
  }

  const lang = analysis.language || defaultLang;

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

  const pendingData = {
    userId,
    chatId: ctx.chat!.id,
    analysis,
    conflicts,
    phase: conflicts.length > 0 ? 'conflict' as const : 'reminder' as const,
    resolvedTodos: analysis.todos,
    reminderIndex: 0,
  };

  const pendingId = savePending(pendingData);

  if (conflicts.length > 0) {
    const conflictMsg = buildConflictMessage(conflicts, analysis.language);
    const keyboard = getConflictKeyboard(pendingId, analysis.language);
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, conflictMsg, { reply_markup: keyboard });
    return;
  }

  try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

  if (ctx.chat) {
    savePlan(ctx.chat.id, userId, analysis);
    if (analysis.timeframe === 'day') {
      const timedTasks = analysis.todos.filter(t => t.time);
      if (timedTasks.length > 0) {
        scheduleReminders(ctx.chat.id, userId, analysis.todos, analysis.language);
      }
    }
  }

  if (locationAdvice) {
    const locationHeader = analysis.language === 'ru' ? 'LOCATION\n\n' : analysis.language === 'kk' ? 'LOCATION\n\n' : 'LOCATION\n\n';
    await ctx.reply(locationHeader + locationAdvice);
  }

  // Long-term plans: simple confirmation, no delivery flow
  if (analysis.timeframe !== 'day') {
    const tfLabel = analysis.timeframe === 'week' ? 'week' : analysis.timeframe === 'month' ? 'month' : 'year';
    const msg = lang === 'ru'
      ? `Готово! Сохранил план на ${tfLabel}: "${analysis.title}"`
      : lang === 'kk'
      ? `Дайын! ${tfLabel} жоспары сақталды: "${analysis.title}"`
      : `Done! Saved ${tfLabel} plan: "${analysis.title}"`;
    await ctx.reply(msg);
    console.log(`[Voice] Long-term plan saved: "${analysis.title}" [${analysis.timeframe}]`);
    return;
  }

  await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  await startDeliveryFlow(ctx, { ...pendingData, id: pendingId, createdAt: Date.now() });

  console.log(`[Voice] Plan processed: "${analysis.title}" [${analysis.language}]`);
}

async function handleQuestionIntent(ctx: Context, userId: number, transcript: string, statusMsg: any, lang: string) {
  await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  const plansData = getAllPlansForLLM(userId);
  const memoryData = JSON.stringify(getUserMemory(userId));
  const answer = await askQuestion(transcript, plansData, memoryData, lang);
  try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
  await ctx.reply(answer);
}

async function handleMemoryQueryIntent(ctx: Context, userId: number, statusMsg: any, lang: string) {
  await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  const formatted = formatMemoryForDisplay(userId, lang);
  try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
  await ctx.reply(formatted);
}

async function handleRescheduleIntent(ctx: Context, userId: number, transcript: string, statusMsg: any, lang: string) {
  await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  const info = await extractRescheduleInfo(transcript);
  if (!info || !info.task || !info.newTime) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
    await ctx.reply(lang === 'ru' ? 'Не удалось определить задачу или новое время. Попробуйте: "Перенеси встречу на 17:00"'
      : lang === 'kk' ? 'Тапсырманы немесе жаңа уақытты анықтау мүмкін болмады.'
      : 'Could not identify the task or new time. Try: "Move my meeting to 5pm"');
    return;
  }

  const found = findTaskByText(userId, info.task, info.date);
  if (!found) {
    const allTasks = getUserTasks(userId).filter(t => !t.done);
    const suggestions = allTasks.slice(0, 5).map(t => `"${t.task}"`).join(', ');
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
    await ctx.reply(lang === 'ru'
      ? `Задача не найдена. Возможно, вы имели в виду: ${suggestions}`
      : lang === 'kk'
      ? `Тапсырма табылмады. Мүмкін: ${suggestions}`
      : `Task not found. Did you mean: ${suggestions}`);
    return;
  }

  // Update time
  const oldTime = found.todo.time;
  found.todo.time = info.newTime;
  if (info.date) found.todo.date = info.date;

  // Cancel old reminder, schedule new one
  if (found.todo.id) {
    cancelReminderByTaskId(found.todo.id);
    if (ctx.chat) {
      scheduleReminders(ctx.chat.id, userId, [found.todo], lang);
    }
  }

  try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

  const offset = getUserConfig(userId).reminder_offset_minutes || 30;
  const triggerTime = getTriggerTimeStr(info.newTime, offset);
  await ctx.reply(lang === 'ru'
    ? `Moved "${found.todo.task}" to ${info.newTime}. I'll remind you at ${triggerTime}`
    : lang === 'kk'
    ? `"${found.todo.task}" ${info.newTime} ауыстырылды. ${triggerTime} еске саламын`
    : `Moved "${found.todo.task}" to ${info.newTime}. I'll remind you at ${triggerTime}`);
}

async function handleDeleteIntent(ctx: Context, userId: number, transcript: string, statusMsg: any, lang: string) {
  await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  const info = await extractDeleteInfo(transcript);
  if (!info) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
    await ctx.reply(lang === 'ru' ? 'Не удалось понять, что удалить.' : lang === 'kk' ? 'Нені өшіру керектігін түсінбедім.' : 'Could not understand what to delete.');
    return;
  }

  if (info.type === 'day') {
    const dateStr = info.date || new Date().toISOString().substring(0, 10);
    const formattedDate = formatViewDate(new Date(dateStr + 'T12:00:00'), lang);
    const count = deletePlansByDate(userId, dateStr);
    if (count > 0) {
      // Cancel all reminders for tasks on that date
      const allTasks = getUserTasks(userId);
      for (const t of allTasks) {
        if (t.id) cancelReminderByTaskId(t.id);
      }
    }
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
    await ctx.reply(lang === 'ru'
      ? `Deleted plan for ${formattedDate}`
      : lang === 'kk'
      ? `${formattedDate} жоспары жойылды`
      : `Deleted plan for ${formattedDate}`);
  } else if (info.type === 'task' && info.task) {
    const found = findTaskByText(userId, info.task);
    if (found && found.todo.id) {
      const removed = deleteTaskById(userId, found.todo.id);
      cancelReminderByTaskId(found.todo.id);
      try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
      const taskTime = removed?.time ? ` at ${removed.time}` : '';
      await ctx.reply(lang === 'ru'
        ? `Removed: ${found.todo.task}${taskTime}`
        : lang === 'kk'
        ? `Жойылды: ${found.todo.task}${taskTime}`
        : `Removed: ${found.todo.task}${taskTime}`);
    } else {
      try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
      await ctx.reply(lang === 'ru' ? 'Задача не найдена.' : lang === 'kk' ? 'Тапсырма табылмады.' : 'Task not found.');
    }
  }
}

async function handleViewIntent(ctx: Context, userId: number, transcript: string, statusMsg: any, lang: string) {
  await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  const info = await extractViewInfo(transcript);
  if (!info) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
    await ctx.reply(lang === 'ru' ? 'Не удалось определить период.' : lang === 'kk' ? 'Кезеңді анықтау мүмкін болмады.' : 'Could not determine the period.');
    return;
  }

  let dateFilter: string | null = null;
  const now = new Date();

  if (info.date) {
    dateFilter = info.date;
  } else if (info.period === 'today') {
    dateFilter = now.toISOString().substring(0, 10);
  } else if (info.period === 'tomorrow') {
    const tom = new Date(now); tom.setDate(tom.getDate() + 1);
    dateFilter = tom.toISOString().substring(0, 10);
  }

  const allPlans = getAllPlansForLLM(userId);
  try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

  if (!allPlans || allPlans === 'No plans recorded.') {
    const emptyMsg = lang === 'ru' ? 'Нет планов на этот период.' : lang === 'kk' ? 'Бұл кезеңге жоспарлар жоқ.' : 'No plans for this period.';
    await ctx.reply(emptyMsg);
    return;
  }

  const data = allPlans.length > 3500 ? allPlans.substring(0, 3500) + '...' : allPlans;
  await ctx.reply(data);
}

async function handleChatIntent(ctx: Context, userId: number, transcript: string, statusMsg: any, lang: string) {
  await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  const memoryData = JSON.stringify(getUserMemory(userId));
  const answer = await chatReply(transcript, memoryData, lang);
  try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
  await ctx.reply(answer);
}

function getTriggerTimeStr(time: string, offsetMinutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m - offsetMinutes, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function handleCommandIntent(ctx: Context, userId: number, intentResult: any, statusMsg: any, lang: string) {
  try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
  const command = intentResult.command;
  
  if (command === 'report') {
    const tasks = getUserTasks(userId);
    if (tasks.length === 0) {
      await ctx.reply(lang === 'ru' ? 'Задач пока нет.' : lang === 'kk' ? 'Тапсырмалар жоқ.' : 'No tasks recorded yet.');
      return;
    }
    const waitMsg = await ctx.reply(lang === 'ru' ? 'Загрузка задач...' : lang === 'kk' ? 'Тапсырмалар жүктелуде...' : 'Loading tasks...');
    try {
      const pdfBuf = await generateReportPdf(tasks, lang);
      try { await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id); } catch {}
      await ctx.replyWithDocument(new InputFile(pdfBuf, `report_${userId}_${Date.now()}.pdf`), { caption: 'Report', reply_markup: getNavKeyboard(lang) });
    } catch (err) {
      const report = generateFullReport(tasks, lang);
      await ctx.api.editMessageText(ctx.chat!.id, waitMsg.message_id, report, { reply_markup: getNavKeyboard(lang) });
    }
  } else if (command === 'weekly') {
    const plans = getWeeklyPlans(userId);
    if (plans.length === 0) {
      await ctx.reply(lang === 'ru' ? 'За последние 7 дней записей нет.' : lang === 'kk' ? 'Соңғы 7 күнде жазбалар жоқ.' : 'No notes in the past 7 days.');
      return;
    }
    const waitMsg = await ctx.reply(lang === 'ru' ? 'Загрузка задач...' : lang === 'kk' ? 'Тапсырмалар жүктелуде...' : 'Loading tasks...');
    try {
      const tasks = plans.flatMap(p => p.todos);
      const pdfBuf = await generateReportPdf(tasks, lang);
      try { await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id); } catch {}
      await ctx.replyWithDocument(new InputFile(pdfBuf, `weekly_${userId}_${Date.now()}.pdf`), { caption: 'Weekly Report', reply_markup: getNavKeyboard(lang) });
    } catch (err) {
      const report = generateWeeklyReport(plans, lang);
      await ctx.api.editMessageText(ctx.chat!.id, waitMsg.message_id, report, { reply_markup: getNavKeyboard(lang) });
    }
  } else if (command === 'clear') {
    const archived = archiveCompletedTasks(userId);
    if (archived === 0) {
      await ctx.reply(lang === 'ru' ? 'Выполненных задач нет.' : lang === 'kk' ? 'Мұрағатталатын орындалған тапсырма жоқ.' : 'No completed tasks to archive.', { reply_markup: getNavKeyboard(lang) });
    } else {
      const msg = lang === 'ru' ? `Архивировано задач: ${archived}.` : lang === 'kk' ? `Мұрағатталды: ${archived} тапсырма.` : `Archived: ${archived} task${archived === 1 ? '' : 's'}.`;
      await ctx.reply(msg, { reply_markup: getNavKeyboard(lang) });
    }
  } else if (command === 'language') {
    const newLang = intentResult.command_arg;
    if (['ru', 'en', 'kk'].includes(newLang)) {
      setUserLanguage(userId, newLang as 'ru' | 'en' | 'kk');
      const msg = newLang === 'ru' ? 'Язык изменен на русский.' : newLang === 'kk' ? 'Тіл қазақшаға өзгертілді.' : 'Language set to English.';
      await ctx.reply(msg);
    } else {
      await ctx.reply('Invalid language. Valid: ru, en, kk.');
    }
  }
}

