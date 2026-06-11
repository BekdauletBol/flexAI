import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { handleVoice } from './handlers/voice.js';
import { initScheduler } from './services/scheduler.js';
import { createServer } from './server.js';
import { setUserLanguage, getUserConfig, setUserLocation } from './services/userConfig.js';
import { getUserTasks, getWeeklyPlans, archiveCompletedTasks } from './services/planStore.js';
import { generateFullReport, generateWeeklyReport } from './services/reporter.js';
import { geocodeCity } from './services/location.js';

import { getNavKeyboard } from './services/messages.js';
import { getPending, deletePending, getUserFlowState, setUserFlowState, clearUserFlowState } from './services/pendingStore.js';
import { startDeliveryFlow, advanceReminderLoop } from './services/delivery.js';
import { setReminderOffset } from './services/userConfig.js';
import { scheduleReminders, formatReminderConfirmation } from './services/scheduler.js';
import { savePlan } from './services/planStore.js';

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
    const report = generateFullReport(tasks, lang);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { reply_markup: getNavKeyboard(lang) });
  } catch (err) {
    console.error('[Bot] Report generation failed:', err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, 'Error generating report.');
  }
});

bot.command('weekly', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = getLang(userId);
  const plans = getWeeklyPlans(userId);

  if (plans.length === 0) {
    await ctx.reply(i18n[lang].no_weekly);
    return;
  }

  const report = generateWeeklyReport(plans, lang);
  await ctx.reply(report, { reply_markup: getNavKeyboard(lang) });
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
  // Call the report command logic indirectly or we can just run it
  // Since commands rely on context, it's easier to duplicate a bit or extract logic
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const tasks = getUserTasks(userId);
  if (tasks.length === 0) {
    await ctx.reply(i18n[lang].no_tasks);
    return;
  }
  const report = generateFullReport(tasks, lang);
  await ctx.reply(report, { reply_markup: getNavKeyboard(lang) });
});

bot.callbackQuery('nav_weekly', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const plans = getWeeklyPlans(userId);
  if (plans.length === 0) {
    await ctx.reply(i18n[lang].no_weekly);
    return;
  }
  const report = generateWeeklyReport(plans, lang);
  await ctx.reply(report, { reply_markup: getNavKeyboard(lang) });
});

bot.callbackQuery('nav_clear', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const archived = archiveCompletedTasks(userId);
  if (archived === 0) {
    await ctx.reply(i18n[lang].cleared_none, { reply_markup: getNavKeyboard(lang) });
  } else {
    await ctx.reply(i18n[lang].cleared(archived), { reply_markup: getNavKeyboard(lang) });
  }
});

bot.callbackQuery('nav_language', async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text('Русский', 'lang_ru')
    .text('English', 'lang_en')
    .text('Казакша', 'lang_kk');
  await ctx.reply('Select language / Выберите язык / Тілді таңдаңыз:', { reply_markup: keyboard });
});

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
  
  // Clear the message with conflict buttons
  if (ctx.callbackQuery.message) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id); } catch {}
  }
  
  await startDeliveryFlow(ctx, pending);
});

bot.callbackQuery(/^conflict_reschedule_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery('Expired.');
    return;
  }
  
  await ctx.answerCallbackQuery();
  
  const incomingTask = pending.conflicts[0].newTodo;
  const prompt = `Enter a new time for: "${incomingTask.task}" (format: HH:MM)`;
  
  if (ctx.callbackQuery.message) {
    await ctx.editMessageText(prompt);
  } else {
    await ctx.reply(prompt);
  }
  
  setUserFlowState(pending.userId, { type: 'awaiting_reschedule', pendingId });
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

// ─── Message handlers ─────────────────────────────────────────────────────────

bot.on('message:voice', handleVoice);

bot.on('message:audio', async (ctx) => {
  const lang = getLang(ctx.from?.id ?? 0);
  await ctx.reply(i18n[lang].audio_note);
});

bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const userId = ctx.from?.id ?? 0;
  
  const flow = getUserFlowState(userId);
  
  if (flow && flow.type === 'awaiting_reschedule') {
    const match = ctx.message.text.trim().match(/^(\d{1,2}):(\d{2})$/);
    const pending = getPending(flow.pendingId);
    
    if (match && pending) {
      const hh = match[1].padStart(2, '0');
      const mm = match[2];
      const newTime = `${hh}:${mm}`;
      
      const incomingTask = pending.conflicts[0].newTodo;
      const todoRef = pending.resolvedTodos.find(t => t.task === incomingTask.task && t.time === incomingTask.time);
      if (todoRef) {
        todoRef.time = newTime;
      }
      
      clearUserFlowState(userId);
      
      if (ctx.chat) {
        savePlan(ctx.chat.id, userId, pending.analysis);
      }
      
      await startDeliveryFlow(ctx, pending);
      return;
    } else if (!match) {
      const lang = getLang(userId);
      const msg = lang === 'ru' ? 'Неверный формат. Используйте HH:MM (например 15:30).' 
                : lang === 'kk' ? 'Қате формат. HH:MM пайдаланыңыз (мысалы 15:30).' 
                : 'Invalid format. Use HH:MM (e.g. 15:30).';
      await ctx.reply(msg);
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
      
      await sendResultsAndReminderButtons(ctx, pending);
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

  const lang = getLang(userId);
  await ctx.reply(i18n[lang].voice_only);
});

// ─── Error handling ───────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error(`[${new Date().toISOString()}] Error update ${err.ctx.update.update_id}:`, err.error);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initScheduler(bot);

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
