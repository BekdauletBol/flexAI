import fs from 'fs';
import path from 'path';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { config } from './config.js';
import { handleVoice, handlePlanIntent, handleQuestionIntent, routeByIntent, continueFlow } from './handlers/voice.js';
import { handleImage } from './handlers/image.js';
import { initScheduler } from './services/scheduler.js';
import { createServer } from './server.js';
import { setUserLanguage, getUserConfig, setUserLocation, setReminderOffset } from './services/userConfig.js';
import { getUserTasks, getWeeklyPlans, archiveCompletedTasks, savePlan, deleteAllUserPlans, updateTaskDateTime } from './services/planStore.js';
import { generateFullReport, generateWeeklyReport } from './services/reporter.js';
import { geocodeCity } from './services/location.js';
import { generateReportPdf } from './services/pdf.js';

import { getNavKeyboard, buildConflictMessage, buildCombinedConflictMessage, getCombinedConflictKeyboard, getSingleConflictKeyboard, buildRescheduleDatePicker, getRescheduleDateKeyboard, buildRescheduleTimePicker, getRescheduleTimeKeyboard, buildRescheduleConfirm } from './services/messages.js';
import { getPending, deletePending, getUserFlowState, setUserFlowState, clearUserFlowState, setRescheduleState, getRescheduleState, clearRescheduleState, getUserState } from './services/pendingStore.js';
import { startDeliveryFlow, advanceReminderLoop } from './services/delivery.js';
import { scheduleReminders, cancelReminderByTaskId, snoozeReminder, snoozeReminderUntilMorning } from './services/scheduler.js';
import { detectIntent } from './services/intent.js';
import { db } from './services/db.js';

const bot = new Bot(config.telegramToken);

const SEP = '———————————————';

// ─── Localised strings ────────────────────────────────────────────────────────

const i18n = {
  ru: {
    start: [
      'flex — голосовой ассистент для задач.',
      '',
      'Отправь голосовое сообщение. Я транскрибирую его, извлеку задачи и сгенерирую PDF-отчет.',
      '',
      SEP,
      '',
      'КОМАНДЫ',
      '',
      '— /report   все текущие задачи',
      '— /weekly   отчет за 7 дней',
      '— /clear    архивировать выполненные',
      '— /language сменить язык',
    ].join('\n'),

    lang_set: 'Язык изменен на русский.',
    ping: 'понг',

    wait_report: 'Загрузка задач...',
    no_tasks: 'Задач пока нет. Отправьте голосовое сообщение.',

    no_weekly: 'За последние 7 дней записей нет.',
    cleared: (n: number) => `Архивировано задач: ${n}.`,
    cleared_none: 'Выполненных задач нет.',

    voice_only: 'Отправьте голосовое сообщение.',
    audio_note: 'Отправьте голосовое сообщение (зажмите микрофон), а не аудиофайл.',
  },
  en: {
    start: [
      'flex — a voice note assistant for tasks.',
      '',
      'Send a voice message. I will transcribe it, extract tasks, and generate a PDF report.',
      '',
      SEP,
      '',
      'COMMANDS',
      '',
      '— /report   all current tasks',
      '— /weekly   report for the past 7 days',
      '— /clear    archive completed tasks',
      '— /language change language',
    ].join('\n'),

    lang_set: 'Language set to English.',
    ping: 'pong',

    wait_report: 'Loading tasks...',
    no_tasks: 'No tasks recorded yet. Send a voice message.',

    no_weekly: 'No notes in the past 7 days.',
    cleared: (n: number) => `Archived: ${n} task${n === 1 ? '' : 's'}.`,
    cleared_none: 'No completed tasks to archive.',

    voice_only: 'Send a voice message.',
    audio_note: 'Send a voice message (hold the mic button), not an audio file.',
  },
  kk: {
    start: [
      'flex — тапсырмаларға арналған дауыстық жазба көмекшісі.',
      '',
      'Дауыстық хабарлама жібер. Мен оны мәтінге айналдырамын, тапсырмаларды бөліп аламын және PDF-есеп жасаймын.',
      '',
      SEP,
      '',
      'КОМАНДАЛАР',
      '',
      '— /report   барлық ағымдағы тапсырмалар',
      '— /weekly   7 күндік есеп',
      '— /clear    орындалғандарды мұрағаттау',
      '— /language тілді өзгерту',
    ].join('\n'),

    lang_set: 'Тіл қазақшаға өзгертілді.',
    ping: 'понг',

    wait_report: 'Тапсырмалар жүктелуде...',
    no_tasks: 'Тапсырмалар жоқ. Дауыстық хабарлама жіберіңіз.',

    no_weekly: 'Соңғы 7 күнде жазбалар жоқ.',
    cleared: (n: number) => `Мұрағатталды: ${n} тапсырма.`,
    cleared_none: 'Мұрағатталатын орындалған тапсырма жоқ.',

    voice_only: 'Дауыстық хабарлама жіберіңіз.',
    audio_note: 'Аудиофайл емес, дауыстық хабарлама жіберіңіз (микрофон батырмасын ұстап тұр).',
  }
} as const;

type Lang = keyof typeof i18n;

function getLang(userId: number): Lang {
  const lang = getUserConfig(userId).language || 'en';
  return (['ru', 'en', 'kk'].includes(lang) ? lang : 'en') as Lang;
}

// ─── Access control ───────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (config.allowedUserId && ctx.from?.id !== config.allowedUserId) {
    console.warn(`[Bot] Access denied for user ${ctx.from?.id}`);
    await ctx.reply('Access denied.');
    return;
  }
  await next();
});

// ─── Debug middleware ─────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  console.log(`[DEBUG] RAW UPDATE #${ctx.update.update_id}:`, JSON.stringify(ctx.update, null, 2));
  await next();
});

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('ping', async (ctx) => {
  const lang = getLang(ctx.from!.id);
  await ctx.reply(i18n[lang].ping);
});

bot.command('start', async (ctx) => {
  const lang = getLang(ctx.from!.id);
  // Ensure user exists in DB before any task operations
  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, language)
    VALUES (?, 'ru')
  `).run(ctx.from!.id);
  // Remove any lingering reply keyboard (e.g. old "Share Location" button)
  const navKeyboard = getNavKeyboard(lang);
  await ctx.reply(i18n[lang].start, { reply_markup: navKeyboard });
});

bot.command('help', async (ctx) => {
  const lang = getLang(ctx.from!.id);
  await ctx.reply(i18n[lang].start);
});

bot.command('language', async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text('Русский', 'lang_ru')
    .text('English', 'lang_en')
    .text('Казакша', 'lang_kk');

  await ctx.reply('Select language / Выберите язык / Тілді таңдаңыз:', {
    reply_markup: keyboard
  });
});

bot.callbackQuery(/lang_(ru|en|kk)/, async (ctx) => {
  const lang = ctx.match[1] as Lang;
  setUserLanguage(ctx.from.id, lang);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(i18n[lang].lang_set);
});

bot.command('report', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = getLang(userId);
  const tasks = getUserTasks(userId);

  if (tasks.length === 0) {
    await ctx.reply(i18n[lang].no_tasks);
    return;
  }

  const statusMsg = await ctx.reply(i18n[lang].wait_report);

  try {
    const pdfBuf = await generateReportPdf(tasks, lang);
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

    const fn = `report_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: 'Report', reply_markup: getNavKeyboard(lang) });
  } catch (err) {
    console.error('[Bot] Report generation failed:', err);
    const report = await generateFullReport(tasks, lang);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { reply_markup: getNavKeyboard(lang) });
  }
});

bot.command('weekly', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !ctx.chat) return;

  const lang = getLang(userId);
  const plans = getWeeklyPlans(userId);

  if (plans.length === 0) {
    await ctx.reply(i18n[lang].no_weekly);
    return;
  }

  const statusMsg = await ctx.reply(i18n[lang].wait_report);

  try {
    const tasks = plans.flatMap(p => p.todos);
    const pdfBuf = await generateReportPdf(tasks, lang);
    try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}

    const fn = `weekly_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: 'Weekly Report', reply_markup: getNavKeyboard(lang) });
  } catch (err) {
    console.error('[Bot] Weekly PDF failed:', err);
    const report = generateWeeklyReport(plans, lang);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { reply_markup: getNavKeyboard(lang) });
  }
});

bot.command('clear', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = getLang(userId);
  const archived = archiveCompletedTasks(userId);

  if (archived === 0) {
    await ctx.reply(i18n[lang].cleared_none, { reply_markup: getNavKeyboard(lang) });
  } else {
    await ctx.reply(i18n[lang].cleared(archived), { reply_markup: getNavKeyboard(lang) });
  }
});

// Hidden — nuke all tasks for testing
bot.command('nuke', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  deleteAllUserPlans(userId);
  await ctx.reply('All tasks deleted.');
});

// Hidden — kept for backward compat but not surfaced in /start
bot.command('setcity', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = getLang(userId);
  const cityName = ctx.match;

  if (!cityName) {
    await ctx.reply('Provide a city name: /setcity Almaty');
    return;
  }

  const statusMsg = await ctx.reply(`Searching for "${cityName}"...`);

  try {
    const coords = await geocodeCity(cityName);
    if (!coords) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `City not found: ${cityName}`);
      return;
    }

    setUserLocation(userId, cityName, coords.lat, coords.lng);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Location set.\n\n— ${cityName}\n— ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
    );
  } catch (err) {
    console.error('[Bot] Failed to set city:', err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, 'Error setting location.');
  }
});

// ─── Callback handlers ────────────────────────────────────────────────────────

bot.callbackQuery('nav_report', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const tasks = getUserTasks(userId);
  if (tasks.length === 0) {
    await ctx.reply(i18n[lang].no_tasks);
    return;
  }
  try {
    const pdfBuf = await generateReportPdf(tasks, lang);
    const fn = `report_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: 'Report', reply_markup: getNavKeyboard(lang) });
  } catch (err) {
    console.error('[Bot] Report generation failed:', err);
    const report = await generateFullReport(tasks, lang);
    await ctx.reply(report, { reply_markup: getNavKeyboard(lang) });
  }
});

bot.callbackQuery('nav_weekly', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const plans = getWeeklyPlans(userId);
  if (!ctx.chat) return;
  if (plans.length === 0) {
    await ctx.reply(i18n[lang].no_weekly);
    return;
  }
  const statusMsg = await ctx.reply(i18n[lang].wait_report);
  try {
    const tasks = plans.flatMap(p => p.todos);
    const pdfBuf = await generateReportPdf(tasks, lang);
    try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
    const fn = `weekly_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: 'Weekly Report', reply_markup: getNavKeyboard(lang) });
  } catch (err) {
    console.error('[Bot] Weekly PDF failed:', err);
    const report = generateWeeklyReport(plans, lang);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { reply_markup: getNavKeyboard(lang) });
  }
});

function handleClearCompleted(ctx: any, userId: number, lang: Lang) {
  const archived = archiveCompletedTasks(userId);
  if (archived === 0) {
    ctx.reply(i18n[lang].cleared_none, { reply_markup: getNavKeyboard(lang) });
  } else {
    ctx.reply(i18n[lang].cleared(archived), { reply_markup: getNavKeyboard(lang) });
  }
}

bot.callbackQuery('nav_clear', async (ctx) => {
  await ctx.answerCallbackQuery();
  handleClearCompleted(ctx, ctx.from.id, getLang(ctx.from.id));
});

bot.callbackQuery('menu_clear', async (ctx) => {
  await ctx.answerCallbackQuery();
  handleClearCompleted(ctx, ctx.from.id, getLang(ctx.from.id));
});

bot.callbackQuery('nav_language', async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text('Русский', 'lang_ru')
    .text('English', 'lang_en')
    .text('Казакша', 'lang_kk');
  await ctx.reply('Select language / Выберите язык / Тілді таңдаңыз:', { reply_markup: keyboard });
});

// ─── Combined Conflict Callbacks ──────────────────────────────────────────────

bot.callbackQuery(/^conflict_keep_all_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }

  await ctx.answerCallbackQuery();

  if (ctx.chat) {
    savePlan(ctx.chat.id, pending.userId, pending.analysis);
  }

  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }

  await startDeliveryFlow(ctx, pending);
});

bot.callbackQuery(/^conflict_skip_all_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }

  await ctx.answerCallbackQuery();

  const conflictedIds = new Set(pending.conflicts.map(c => c.newTodo.id));
  pending.resolvedTodos = pending.analysis.todos.filter(t => !conflictedIds.has(t.id));

  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }

  await startDeliveryFlow(ctx, pending);
});

bot.callbackQuery(/^conflict_one_by_one_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }

  await ctx.answerCallbackQuery();

  pending.conflictIndex = 0;

  const conflict = pending.conflicts[0];
  const conflictMsg = buildConflictMessage([conflict], pending.analysis.language);
  const keyboard = getSingleConflictKeyboard(pendingId, 0, pending.analysis.language);

  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }
  await ctx.reply(conflictMsg, { reply_markup: keyboard });
});

bot.callbackQuery(/^conflict_keep_idx_(.+)_(\d+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const conflictIndex = parseInt(ctx.match[2], 10);
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }

  await ctx.answerCallbackQuery();

  const nextIndex = conflictIndex + 1;

  if (nextIndex >= pending.conflicts.length) {
    if (ctx.chat) {
      savePlan(ctx.chat.id, pending.userId, pending.analysis);
    }
    if (ctx.callbackQuery.message) {
      try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
    }
    await startDeliveryFlow(ctx, pending);
  } else {
    pending.conflictIndex = nextIndex;
    const conflict = pending.conflicts[nextIndex];
    const conflictMsg = buildConflictMessage([conflict], pending.analysis.language);
    const keyboard = getSingleConflictKeyboard(pendingId, nextIndex, pending.analysis.language);

    if (ctx.callbackQuery.message) {
      try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
    }
    await ctx.reply(conflictMsg, { reply_markup: keyboard });
  }
});

bot.callbackQuery(/^conflict_reschedule_idx_(.+)_(\d+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const conflictIndex = parseInt(ctx.match[2], 10);
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }

  await ctx.answerCallbackQuery();

  const conflict = pending.conflicts[conflictIndex];
  const task = conflict.newTodo;
  const lang = pending.analysis.language;

  setRescheduleState(ctx.from.id, {
    taskId: task.id!,
    taskName: task.task,
    currentDate: task.date || new Date().toISOString().substring(0, 10),
    currentTime: task.time || '09:00',
    pendingId,
    conflictIndex,
    chatId: ctx.chat!.id,
    lang,
    createdAt: Date.now(),
  });

  const dateMsg = buildRescheduleDatePicker(task.task, lang);
  const dateKb = getRescheduleDateKeyboard(lang);
  if (ctx.callbackQuery.message) {
    await ctx.editMessageText(dateMsg, { reply_markup: dateKb });
  } else {
    await ctx.reply(dateMsg, { reply_markup: dateKb });
  }
});

bot.callbackQuery(/^conflict_skip_idx_(.+)_(\d+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const conflictIndex = parseInt(ctx.match[2], 10);
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }

  await ctx.answerCallbackQuery();

  const skipTask = pending.conflicts[conflictIndex].newTodo;
  pending.analysis.todos = pending.analysis.todos.filter(t => t.id !== skipTask.id);
  pending.resolvedTodos = pending.resolvedTodos.filter(t => t.id !== skipTask.id);

  const nextIndex = conflictIndex + 1;

  if (nextIndex >= pending.conflicts.length) {
    if (ctx.chat) {
      savePlan(ctx.chat.id, pending.userId, pending.analysis);
    }
    if (ctx.callbackQuery.message) {
      try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
    }
    await startDeliveryFlow(ctx, pending);
  } else {
    pending.conflictIndex = nextIndex;
    const conflict = pending.conflicts[nextIndex];
    const conflictMsg = buildConflictMessage([conflict], pending.analysis.language);
    const keyboard = getSingleConflictKeyboard(pendingId, nextIndex, pending.analysis.language);

    if (ctx.callbackQuery.message) {
      try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
    }
    await ctx.reply(conflictMsg, { reply_markup: keyboard });
  }
});

// ─── Interactive Reschedule Picker ─────────────────────────────────────────────

bot.callbackQuery(/^rs_d_(today|tomorrow|plus2|custom)$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  await ctx.answerCallbackQuery();

  const option = ctx.match[1];
  const now = new Date();

  if (option === 'custom') {
    const prompt = state.lang === 'ru' ? 'Введите дату в формате DD.MM (например 15.06)'
      : state.lang === 'kk' ? 'DD.MM форматында күнді енгізіңіз (мысалы 15.06)'
      : 'Enter date in DD.MM format (e.g. 15.06)';
    await ctx.editMessageText(prompt);
    setUserFlowState(userId, { type: 'awaiting_reschedule', pendingId: '', customField: 'date' });
    return;
  }

  let dateObj: Date;
  if (option === 'today') dateObj = now;
  else if (option === 'tomorrow') { dateObj = new Date(now); dateObj.setDate(dateObj.getDate() + 1); }
  else { dateObj = new Date(now); dateObj.setDate(dateObj.getDate() + 2); }

  const dateStr = dateObj.toISOString().substring(0, 10);
  state.selectedDate = dateStr;

  const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeMsg = buildRescheduleTimePicker(state.taskName, dateLabel, state.lang);
  const timeKb = getRescheduleTimeKeyboard(state.lang);

  await ctx.editMessageText(timeMsg, { reply_markup: timeKb });
});

bot.callbackQuery(/^rs_t_custom$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  await ctx.answerCallbackQuery();

  const prompt = state.lang === 'ru' ? 'Введите время в формате HH:MM (например 14:30)'
    : state.lang === 'kk' ? 'HH:MM форматында уақытты енгізіңіз (мысалы 14:30)'
    : 'Enter time in HH:MM format (e.g. 14:30)';
  await ctx.editMessageText(prompt);
  setUserFlowState(userId, { type: 'awaiting_reschedule', pendingId: '', customField: 'time' });
});

bot.callbackQuery(/^rs_t_(\d{2}:\d{2})$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state || !state.selectedDate) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  await ctx.answerCallbackQuery();

  state.selectedTime = ctx.match[1];

  const confirmMsg = buildRescheduleConfirm(
    state.taskName, state.currentDate, state.currentTime,
    state.selectedDate, state.selectedTime, state.lang
  );
  const confirmKb = new InlineKeyboard().text(
    state.lang === 'ru' ? 'Подтвердить' : state.lang === 'kk' ? 'Растау' : 'Confirm',
    'rs_confirm'
  );
  await ctx.editMessageText(confirmMsg, { reply_markup: confirmKb });
});

bot.callbackQuery('rs_confirm', async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state || !state.selectedDate || !state.selectedTime) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  await ctx.answerCallbackQuery();

  const { taskId, selectedDate, selectedTime, currentDate, currentTime, lang, pendingId, conflictIndex } = state;

  // Bug 4: Check if new datetime is same as old datetime
  if (selectedDate === currentDate && selectedTime === currentTime) {
    const timeMsg = lang === 'ru' ? 'Это то же самое время. Выберите другое.'
      : lang === 'kk' ? 'Бұл сол уақыт. Басқасын таңдаңыз.'
      : 'This is the same time. Pick another.';
    await ctx.editMessageText(timeMsg);
    // Re-show date picker
    const dateMsg = buildRescheduleDatePicker(state.taskName, lang);
    const dateKb = getRescheduleDateKeyboard(lang);
    await ctx.reply(dateMsg, { reply_markup: dateKb });
    return;
  }

  // Check if new time conflicts with another task
  const allUserTasks = getUserTasks(userId);
  const otherTasks = allUserTasks.filter(t => t.id !== taskId && !t.done && t.time && t.date);
  const conflict = otherTasks.find(t => t.time === selectedTime && t.date === selectedDate);
  if (conflict) {
    const conflictMsg = lang === 'ru'
      ? `КОНФЛИКТ\n\nВ ${selectedTime} уже запланировано:\n— ${conflict.task}\n\nВыберите другое время.`
      : lang === 'kk'
      ? `ҚАЙШЫЛЫҚ\n\n${selectedTime} уақытында жоспарланған:\n— ${conflict.task}\n\nБасқа уақыт таңдаңыз.`
      : `CONFLICT\n\nAt ${selectedTime} you already have:\n— ${conflict.task}\n\nPick a different time.`;
    await ctx.editMessageText(conflictMsg);
    const timeMsg = buildRescheduleTimePicker(state.taskName, selectedDate, lang);
    const timeKb = getRescheduleTimeKeyboard(lang);
    await ctx.reply(timeMsg, { reply_markup: timeKb });
    return;
  }

  clearRescheduleState(userId);
  clearUserFlowState(userId);

  // Cancel old reminder
  cancelReminderByTaskId(taskId);

  // Update task in database
  const updated = updateTaskDateTime(userId, taskId, selectedDate, selectedTime);
  if (updated && ctx.chat) {
    scheduleReminders(ctx.chat.id, userId, [updated], lang);
  }

  // If batch mode (one by one), advance to next conflict
  if (pendingId && conflictIndex !== undefined) {
    const pending = getPending(pendingId);
    if (pending) {
      const nextIndex = conflictIndex + 1;
      if (nextIndex >= pending.conflicts.length) {
        if (ctx.chat) savePlan(ctx.chat.id, userId, pending.analysis);
        await ctx.editMessageText(
          lang === 'ru' ? 'Все конфликты разрешены.' : lang === 'kk' ? 'Барлық қайшылықтар шешілді.' : 'All conflicts resolved.'
        );
        await startDeliveryFlow(ctx, pending);
      } else {
        pending.conflictIndex = nextIndex;
        const conflict = pending.conflicts[nextIndex];
        const conflictMsg = buildConflictMessage([conflict], lang);
        const keyboard = getSingleConflictKeyboard(pendingId, nextIndex, lang);
        try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message!.message_id); } catch {}
        await ctx.reply(conflictMsg, { reply_markup: keyboard });
      }
      return;
    }
  }

  // Single conflict mode
  const confirmMsg = buildRescheduleConfirm(
    state.taskName, currentDate, currentTime,
    selectedDate, selectedTime, lang
  );
  try { await ctx.editMessageText(confirmMsg); } catch {}
  await ctx.reply(lang === 'ru' ? 'Готово.' : lang === 'kk' ? 'Дайын.' : 'Done.', { reply_markup: getNavKeyboard(lang) });
});

// ─── Single Conflict Callbacks ─────────────────────────────────────────────────

bot.callbackQuery(/^conflict_keep_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  
  await ctx.answerCallbackQuery();
  
  if (ctx.chat) {
    savePlan(ctx.chat.id, pending.userId, pending.analysis);
  }
  
  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }
  
  await startDeliveryFlow(ctx, pending);
});

// Note: conflict_reschedule_ is handled above (single conflict) and
// conflict_reschedule_idx_ is in the combined conflict section

bot.callbackQuery(/^conflict_skip_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }

  await ctx.answerCallbackQuery();

  const skipTask = pending.conflicts[0].newTodo;
  pending.analysis.todos = pending.analysis.todos.filter(t => t.id !== skipTask.id);
  pending.resolvedTodos = pending.resolvedTodos.filter(t => t.id !== skipTask.id);

  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }

  await startDeliveryFlow(ctx, pending);
});

bot.callbackQuery(/^srem_(10|30|60|none|custom)_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const pendingId = ctx.match[2];
  
  await ctx.answerCallbackQuery();
  
  const pending = getPending(pendingId);
  if (!pending) {
    if (ctx.callbackQuery.message) {
      try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
    }
    return;
  }
  
  const todos = pending.resolvedTodos || pending.analysis.todos;
  const currentTaskIndex = pending.reminderIndex;
  
  if (currentTaskIndex >= todos.length) return;
  const currentTask = todos[currentTaskIndex];
  
  if (action === 'custom') {
    const lang = pending.analysis.language;
    const prompt = lang === 'ru' ? `Введите время (и дату) для:\n"${currentTask.task}"\nФормат: HH:MM или DD.MM HH:MM`
                 : lang === 'kk' ? `Уақытты (және күнді) енгізіңіз:\n"${currentTask.task}"\nФормат: HH:MM немесе DD.MM HH:MM`
                 : `Enter time (and date) for:\n"${currentTask.task}"\nFormat: HH:MM or DD.MM HH:MM`;
                 
    if (ctx.callbackQuery.message) {
      await ctx.editMessageText(prompt);
    } else {
      await ctx.reply(prompt);
    }
    setUserFlowState(pending.userId, { type: 'awaiting_custom_reminder', pendingId, taskIndex: currentTaskIndex });
    return;
  }
  
  const offsetMinutes = action === 'none' ? -1 : parseInt(action, 10);
  
  // Set default (if not none, update their default)
  if (offsetMinutes !== -1) {
    setReminderOffset(ctx.from.id, offsetMinutes);
  }
  
  // Schedule if not none and has a time
  if (offsetMinutes !== -1 && ctx.chat) {
    // If it doesn't have a time, we can't schedule an offset reminder, 
    // but we just skip scheduling. 
    if (currentTask.time) {
      scheduleReminders(ctx.chat.id, pending.userId, [currentTask], pending.analysis.language, offsetMinutes);
    }
  }
  
  // Move to next task
  pending.reminderIndex++;
  
  // Loop again by calling delivery (it handles editing the message if we passed ctx, but it actually replies right now)
  // Since delivery uses ctx.reply, we should delete the old inline message
  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }
  
  await advanceReminderLoop(ctx, pending);
});

// ─── Snooze Callbacks ──────────────────────────────────────────────────────────

bot.callbackQuery(/^snz_(\d+|tmrw|done)_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const taskId = ctx.match[2];
  const userId = ctx.from.id;
  const lang = getLang(userId);
  
  await ctx.answerCallbackQuery();

  if (action === 'done') {
    const { markTaskDone } = await import('./services/planStore.js');
    markTaskDone(userId, taskId);
    const msg = lang === 'ru' ? 'Отмечено как выполненное.' : lang === 'kk' ? 'Орындалды деп белгіленді.' : 'Marked as done.';
    if (ctx.callbackQuery.message) {
      try { await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, msg); } catch {}
    }
    cancelReminderByTaskId(taskId);
    return;
  }

  let minutes: number;
  let snoozedUntilStr: string | null = null;

  if (action === 'tmrw') {
    const tomorrow9am = new Date();
    tomorrow9am.setDate(tomorrow9am.getDate() + 1);
    tomorrow9am.setHours(9, 0, 0, 0);
    minutes = Math.round((tomorrow9am.getTime() - Date.now()) / 60000);
    snoozedUntilStr = tomorrow9am.toISOString();
  } else {
    minutes = parseInt(action, 10);
    snoozedUntilStr = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }

  const reminder = action === 'tmrw'
    ? snoozeReminderUntilMorning(taskId, lang)
    : snoozeReminder(taskId, minutes);

  if (!reminder) {
    if (ctx.callbackQuery.message) {
      try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
    }
    return;
  }

  // Update DB
  const { updateSnooze } = await import('./services/db.js');
  updateSnooze(taskId, snoozedUntilStr);

  const msg = action === 'tmrw'
    ? (lang === 'ru' ? 'Напомню завтра в 09:00.' : lang === 'kk' ? 'Ертең 09:00-де еске саламын.' : 'I\'ll remind you tomorrow at 09:00.')
    : (lang === 'ru' ? `Напомню через ${minutes} мин.` : lang === 'kk' ? `${minutes} миннен кейін еске саламын.` : `I\'ll remind you in ${minutes} min.`);

  if (ctx.callbackQuery.message) {
    try { await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, msg); } catch {}
  }
});

// ─── Image Confirmation Callbacks ──────────────────────────────────────────────

bot.callbackQuery(/^img_confirm_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const { getPending, deletePending } = await import('./services/pendingStore.js');
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  await ctx.answerCallbackQuery();

  const lang = pending.analysis.language;
  if (ctx.chat) {
    savePlan(ctx.chat.id, pending.userId, pending.analysis);
    const timedTasks = pending.analysis.todos.filter(t => t.time);
    if (timedTasks.length > 0) {
      scheduleReminders(ctx.chat.id, pending.userId, pending.analysis.todos, lang);
    }
  }

  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }

  await startDeliveryFlow(ctx, pending);
});

bot.callbackQuery(/^img_cancel_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const { getPending, deletePending } = await import('./services/pendingStore.js');
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  await ctx.answerCallbackQuery();

  const lang = pending.analysis.language;
  const msg = lang === 'ru' ? 'Отменено.' : lang === 'kk' ? 'Болдырылмады.' : 'Cancelled.';

  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id, msg); } catch {}
  }
});

// ─── Message handlers ─────────────────────────────────────────────────────────

bot.on('message:voice', handleVoice);

bot.on('message:photo', handleImage);

bot.on('message:audio', async (ctx) => {
  const lang = getLang(ctx.from?.id ?? 0);
  await ctx.reply(i18n[lang].audio_note);
});

bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const userId = ctx.from?.id ?? 0;
  
  const flow = getUserFlowState(userId);
  
  if (flow && flow.type === 'awaiting_reschedule') {
    const text = ctx.message.text.trim();
    const state = getRescheduleState(userId);

    // Custom date input: DD.MM[.YYYY]
    if (flow.customField === 'date') {
      const match = text.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
      if (match && state) {
        const day = match[1].padStart(2, '0');
        const month = match[2].padStart(2, '0');
        let year = match[3];
        if (!year) year = String(new Date().getFullYear());
        else if (year.length === 2) year = '20' + year;
        const dateStr = `${year}-${month}-${day}`;
        state.selectedDate = dateStr;

        clearUserFlowState(userId);

        const dateObj = new Date(dateStr + 'T12:00:00');
        const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const timeMsg = buildRescheduleTimePicker(state.taskName, dateLabel, state.lang);
        const timeKb = getRescheduleTimeKeyboard(state.lang);
        await ctx.reply(timeMsg, { reply_markup: timeKb });
        return;
      }
      const lang = getLang(userId);
      await ctx.reply(lang === 'ru' ? 'Неверный формат. Используйте DD.MM (например 15.06).'
        : lang === 'kk' ? 'Қате формат. DD.MM пайдаланыңыз (мысалы 15.06).'
        : 'Invalid format. Use DD.MM (e.g. 15.06).');
      return;
    }

    // Custom time input: HH:MM
    if (flow.customField === 'time') {
      const match = text.match(/^(\d{1,2}):(\d{2})$/);
      if (match && state) {
        state.selectedTime = `${match[1].padStart(2, '0')}:${match[2]}`;

        clearUserFlowState(userId);

        const confirmMsg = buildRescheduleConfirm(
          state.taskName, state.currentDate, state.currentTime,
          state.selectedDate || '', state.selectedTime, state.lang
        );
        const confirmKb = new InlineKeyboard().text(
          state.lang === 'ru' ? 'Подтвердить' : state.lang === 'kk' ? 'Растау' : 'Confirm',
          'rs_confirm'
        );
        await ctx.reply(confirmMsg, { reply_markup: confirmKb });
        return;
      }
      const lang = getLang(userId);
      await ctx.reply(lang === 'ru' ? 'Неверный формат. Используйте HH:MM (например 15:30).'
        : lang === 'kk' ? 'Қате формат. HH:MM пайдаланыңыз (мысалы 15:30).'
        : 'Invalid format. Use HH:MM (e.g. 15:30).');
      return;
    }

    // Legacy flow (HH:MM only) — keep for backward compat with old command flows
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    const pending = getPending(flow.pendingId);
    if (match && pending) {
      const hh = match[1].padStart(2, '0');
      const mm = match[2];
      const newTime = `${hh}:${mm}`;

      const conflictIdx = flow.conflictIndex ?? 0;
      const incomingTask = pending.conflicts[conflictIdx]?.newTodo ?? pending.conflicts[0].newTodo;
      const todoRef = pending.resolvedTodos.find(t => t.task === incomingTask.task && t.time === incomingTask.time);
      if (todoRef) todoRef.time = newTime;

      clearUserFlowState(userId);

      if (pending.conflicts.length > 0 && conflictIdx < pending.conflicts.length - 1) {
        const nextIndex = conflictIdx + 1;
        pending.conflictIndex = nextIndex;
        const nextConflict = pending.conflicts[nextIndex];
        const conflictMsg = buildConflictMessage([nextConflict], pending.analysis.language);
        const keyboard = getSingleConflictKeyboard(flow.pendingId, nextIndex, pending.analysis.language);
        await ctx.reply(conflictMsg, { reply_markup: keyboard });
        return;
      }

      if (ctx.chat) savePlan(ctx.chat.id, userId, pending.analysis);
      await startDeliveryFlow(ctx, pending);
      return;
    } else if (!match) {
      const lang = getLang(userId);
      await ctx.reply(lang === 'ru' ? 'Неверный формат. Используйте HH:MM (например 15:30).'
        : lang === 'kk' ? 'Қате формат. HH:MM пайдаланыңыз (мысалы 15:30).'
        : 'Invalid format. Use HH:MM (e.g. 15:30).');
      return;
    }
  }
  
  if (flow && flow.type === 'awaiting_custom_reminder') {
    const text = ctx.message.text.trim();
    // Match either "DD.MM HH:MM" or "HH:MM"
    const matchFull = text.match(/^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    const matchTime = text.match(/^(\d{1,2}):(\d{2})$/);
    const pending = getPending(flow.pendingId);
    
    if ((matchFull || matchTime) && pending) {
      const todos = pending.resolvedTodos || pending.analysis.todos;
      const task = todos[flow.taskIndex];
      
      if (matchFull) {
        // e.g. "12.06 15:30"
        task.time = `${matchFull[1].padStart(2, '0')}.${matchFull[2].padStart(2, '0')} ${matchFull[3].padStart(2, '0')}:${matchFull[4]}`;
      } else if (matchTime) {
        // e.g. "15:30"
        task.time = `${matchTime[1].padStart(2, '0')}:${matchTime[2]}`;
      }
      
      // We assume custom time means reminder is AT that time (offset 0)
      if (ctx.chat) {
        scheduleReminders(ctx.chat.id, userId, [task], pending.analysis.language, 0);
      }
      
      clearUserFlowState(userId);
      pending.reminderIndex++;
      
      await advanceReminderLoop(ctx, pending);
      return;
    } else {
      const lang = getLang(userId);
      const msg = lang === 'ru' ? 'Неверный формат. Используйте HH:MM или DD.MM HH:MM.' 
                : lang === 'kk' ? 'Қате формат. HH:MM немесе DD.MM HH:MM пайдаланыңыз.' 
                : 'Invalid format. Use HH:MM or DD.MM HH:MM.';
      await ctx.reply(msg);
      return;
    }
  }

  // UserState-based multi-step flows
  const userState = getUserState(userId);
  if (userState?.flow) {
    const text = ctx.message.text;
    const lang = getLang(userId);
    await continueFlow(ctx, userId, userState, text, { message_id: 0 }, lang);
    return;
  }

  // No active flow — route through same intent pipeline as voice
  const text = ctx.message.text;
  const lang = getLang(userId);
  const statusMsgId = (await ctx.reply('Analyzing...')).message_id;
  try {
    const intentResult = await detectIntent(text);
    await routeByIntent(intentResult, ctx, userId, text, { message_id: statusMsgId }, lang);
  } catch (err) {
    console.error('[Text] Intent routing failed:', err);
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsgId); } catch {}
    await ctx.reply(i18n[lang].voice_only);
  }
});

// ─── Error handling ───────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error(`[${new Date().toISOString()}] Error update ${err.ctx.update.update_id}:`, err.error);
  const userId = err.ctx.from?.id;
  const lang = userId ? getLang(userId) : 'en';
  try {
    const msg = lang === 'ru' ? 'Произошла ошибка. Попробуйте еще раз.' : lang === 'kk' ? 'Қате орын алды. Қайталап көріңіз.' : 'An error occurred. Please try again.';
    err.ctx.reply(msg);
  } catch {}
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Clean up temp files from previous run
const TEMP_DIR = path.resolve('temp');
try {
  if (fs.existsSync(TEMP_DIR)) {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.endsWith('.ogg')) fs.unlinkSync(path.join(TEMP_DIR, f));
    }
    console.log(`[Boot] Cleaned ${files.length} temp files`);
  }
} catch (e) {
  console.error('[Boot] Temp cleanup failed:', e);
}

initScheduler(bot);

console.log('[DB] Users:', db.prepare('SELECT COUNT(*) as c FROM users').get());
console.log('[DB] Todos:', db.prepare('SELECT COUNT(*) as c FROM todos').get());

const app = createServer();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`[Server] Express server running on port ${config.port}`);
});

console.log('[Bot] Starting...');
bot.start({
  onStart: async (info) => {
    console.log(`@${info.username} running`);
    console.log(`   Model: ${config.openaiModel} | GitHub: ${config.isGitHubModels} | User: ${config.allowedUserId || 'any'}`);
    // Dismiss any stale reply keyboard left by a previous bot version
    if (config.allowedUserId) {
      try {
        await bot.api.sendMessage(config.allowedUserId, '.', { reply_markup: { remove_keyboard: true } });
        await bot.api.sendMessage(config.allowedUserId, 'Ready.', { reply_markup: { remove_keyboard: true } });
      } catch {}
    }
  },
});
