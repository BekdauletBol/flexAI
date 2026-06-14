import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import { config } from './config.js';
import { migrateFromJson } from './services/db.js';
import { handleVoice } from './handlers/voice.js';
import { deliverPlan } from './handlers/voice.js';
import { initScheduler, scheduleReminders } from './services/scheduler.js';
import { createServer } from './server.js';
import { logger } from './logger.js';
import { TodoItem } from './types/analysis.js';
import { analyzeTranscript } from './services/analysis.js';
import { savePlan } from './services/planStore.js';

migrateFromJson();
import { setUserLanguage, getUserConfig, setReminderOffset } from './services/userConfig.js';
import { getUserTasks, getPlan } from './services/planStore.js';
import { generateFullReport } from './services/reporter.js';
import { getPendingSession, clearPendingSession, getTaskKeyboard, getTaskMessage, applyReminderOffset, setWaitingCustom, getWaitingCustom, clearWaitingCustom, setPendingReminderConfig } from './services/reminderSession.js';
import { getPendingPlan, advanceStep, clearPendingPlan, resolveConflict } from './services/pendingPlan.js';
import { handleTextMessage } from './services/textRouter.js';

// Waiting for custom conflict time input
const conflictCustomWaiting = new Map<number, string>(); // chatId -> taskId

const bot = new Bot(config.telegramToken);

const i18n = {
  ru: {
    start: 'flex — голосовой ассистент для заметок\n\nОтправь голосовое сообщение. Я расшифрую, извлеку задачи и сформирую отчёт.\n\nКоманды:\n/report — все текущие задачи\n/language — сменить язык\n\nМестоположение определяется автоматически.',
    lang_set: 'Язык установлен: русский.',
    ping: 'работаю',
    wait_report: 'Анализирую задачи...',
    no_tasks: 'Пока нет задач. Отправь голосовое сообщение.',
  },
  en: {
    start: 'flex — voice notes assistant\n\nSend a voice message. I will transcribe it, extract tasks, and generate a structured report.\n\nCommands:\n/report — view all current tasks\n/language — change language\n\nLocation is detected automatically from your messages.',
    lang_set: 'Language set to English.',
    ping: 'pong',
    wait_report: 'Analyzing tasks...',
    no_tasks: 'No tasks yet. Send a voice message.',
  },
  kk: {
    start: 'flex — дауыстық жазбалар ассистенті\n\nДауыстық хабарлама жіберіңіз. Мен транскрипциялап, тапсырмаларды бөліп алып, есеп дайындаймын.\n\nКомандалар:\n/report — барлық тапсырмалар\n/language — тілді өзгерту\n\nОрналасқан жері автоматты түрде анықталады.',
    lang_set: 'Тіл орнатылды: қазақша.',
    ping: 'жұмыс істеймін',
    wait_report: 'Тапсырмаларды талдау...',
    no_tasks: 'Әлі тапсырмалар жоқ. Дауыстық хабарлама жіберіңіз.',
  }
};

bot.command('ping', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'en';
  await ctx.reply(i18n[lang].ping);
});

bot.command('language', async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text('Russian', 'lang_ru')
    .text('English', 'lang_en')
    .text('Kazakh', 'lang_kk');

  await ctx.reply('Choose language / \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u044F\u0437\u044B\u043A / \u0422\u0456\u043B\u0434\u0456 \u0442\u0430\u04A3\u0434\u0430\u04A3\u044B\u0437:', {
    reply_markup: keyboard
  });
});

bot.callbackQuery(/lang_(ru|en|kk)/, async (ctx) => {
  const lang = ctx.match[1] as 'ru' | 'en' | 'kk';
  setUserLanguage(ctx.from.id, lang);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(i18n[lang].lang_set);
});

bot.command('report', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const tasks = getUserTasks(userId);
  const settings = getUserConfig(userId);
  const lang = settings.language || 'en';

  if (tasks.length === 0) {
    await ctx.reply(i18n[lang].no_tasks);
    return;
  }

  const statusMsg = await ctx.reply(i18n[lang].wait_report);

  try {
    const report = await generateFullReport(tasks, lang);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report);
  } catch (err) {
    logger.error(err, 'Report generation failed');
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, 'Error.');
  }
});

bot.command('start', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'ru';
  await ctx.reply(i18n[lang]?.start || i18n.ru.start);
});

bot.command('help', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'ru';
  if (lang === 'ru') {
    await ctx.reply('flex — голосовой ассистент\n\nКак использовать:\n— Отправь голосовое сообщение с задачами\n— Я расшифрую, извлеку задачи и предложу настроить напоминания\n— В конце пришлю PDF-отчёт\n\nКоманды:\n/report — все задачи\n/language — сменить язык\n/ping — проверка');
  } else if (lang === 'kk') {
    await ctx.reply('flex — дауыстық ассистент\n\nҚалай қолдану керек:\n— Тапсырмаларыңызбен дауыстық хабарлама жіберіңіз\n— Мен транскрипциялап, тапсырмаларды бөліп алып, еске салғыштарды ұсынамын\n— Соңында PDF есеп жіберемін\n\nКомандалар:\n/report — барлық тапсырмалар\n/language — тілді өзгерту\n/ping — тексеру');
  } else {
    await ctx.reply('flex — voice assistant\n\nHow to use:\n— Send a voice message with your tasks\n— I will transcribe, extract tasks, and suggest reminders\n— I will send a PDF report at the end\n\nCommands:\n/report — all tasks\n/language — change language\n/ping — check');
  }
});

bot.on('message:voice', handleVoice);
bot.on('message:audio', (ctx) => ctx.reply('Send a voice message (hold mic), not an audio file.'));

// Debug: /test <text> — run text through analysis without voice
// Handle reminder inline keyboard callbacks
bot.callbackQuery(/^remind_(\d+)_(-?\d+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const taskIndex = parseInt(ctx.match[1]);
  const offset = parseInt(ctx.match[2]);

  if (offset === -1) {
    setWaitingCustom(ctx.chat.id, taskIndex);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Type the number of minutes before the task:');
    return;
  }

  const result = applyReminderOffset(ctx.chat.id, taskIndex, offset);
  if (result.done) {
    await ctx.editMessageText(result.msg);
    await ctx.answerCallbackQuery();

    // All reminders set — advance plan if pending
    const pending = getPendingPlan(ctx.chat.id);
    if (pending && pending.step === 'reminders') {
      advanceStep(ctx.chat.id);
      await deliverPlan(ctx, ctx.chat.id, pending.userId, pending.analysis, pending.statusMsgId);
    }
  } else {
    await ctx.editMessageText(result.msg, {
      reply_markup: getTaskKeyboard(
        getPendingSession(ctx.chat.id)?.currentTaskIndex ?? 0,
        getPendingSession(ctx.chat.id)?.tasks.length ?? 0
      ),
    });
    await ctx.answerCallbackQuery();
  }
});

// After all conflicts resolved: save, advance step, start reminders or deliver plan
async function afterConflictsDone(ctx: any, chatId: number) {
  const pending = getPendingPlan(chatId);
  if (!pending) {
    await ctx.reply('No pending plan found.');
    return;
  }

  savePlan(chatId, pending.userId, pending.analysis);
  advanceStep(chatId);

  const timedTasks = pending.analysis.todos.filter(t => (t.time || t.datetime) && !t.done);
  const tasksWithTime = timedTasks.filter(t => t.time);

  if (tasksWithTime.length > 0) {
    setPendingReminderConfig(chatId, pending.userId, pending.analysis.todos, pending.analysis.language);
    const session = getPendingSession(chatId);
    if (session) {
      const msg = await ctx.reply(getTaskMessage(session), {
        reply_markup: getTaskKeyboard(session.currentTaskIndex, session.tasks.length),
      });
      session.messageId = msg.message_id;
    }
  } else {
    advanceStep(chatId);
    await deliverPlan(ctx, chatId, pending.userId, pending.analysis, pending.statusMsgId);
  }
}

// Handle conflict resolution callbacks
bot.callbackQuery(/^cf_(keep|skip|move|custom)_([a-f0-9-]+)(?:_(\d{2}:\d{2}))?$/, async (ctx) => {
  if (!ctx.chat) return;
  const action = ctx.match[1];
  const taskId = ctx.match[2];
  const newTime = ctx.match[3];
  const chatId = ctx.chat.id;

  if (action === 'custom') {
    conflictCustomWaiting.set(chatId, taskId);
    await ctx.editMessageText('Type the new time in HH:MM format (e.g. 14:30):');
    await ctx.answerCallbackQuery();
    return;
  }

  const pending = getPendingPlan(chatId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'No pending plan.' });
    return;
  }

  const todo = pending.analysis.todos.find(t => t.id === taskId);
  if (!todo) {
    await ctx.answerCallbackQuery({ text: 'Task not found.' });
    return;
  }

  if (action === 'skip') {
    todo.done = true;
    await ctx.editMessageText(`Skipped:\n\u2014 ${todo.task}`);
    await ctx.answerCallbackQuery();
  } else if (action === 'move' && newTime) {
    todo.time = newTime;
    await ctx.editMessageText(`Moved:\n\u2014 ${todo.task} \u00B7 ${newTime}`);
    await ctx.answerCallbackQuery();
  } else {
    await ctx.editMessageText('Kept as-is.');
    await ctx.answerCallbackQuery();
  }

  const allResolved = resolveConflict(chatId, taskId);
  if (allResolved) {
    await afterConflictsDone(ctx, chatId);
  }
});

// Handle custom conflict time + custom reminder + text router
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith('/')) return;

  // Custom conflict time
  const conflictTaskId = conflictCustomWaiting.get(ctx.chat.id);
  if (conflictTaskId) {
    const match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const hh = match[1].padStart(2, '0');
      const mm = match[2];
      const newTime = `${hh}:${mm}`;
      conflictCustomWaiting.delete(ctx.chat.id);
      // apply move + complete resolution flow
      const pending = getPendingPlan(ctx.chat.id);
      if (pending) {
        const todo = pending.analysis.todos.find(t => t.id === conflictTaskId);
        if (todo) {
          todo.time = newTime;
        }
      }
      const allResolved = resolveConflict(ctx.chat.id, conflictTaskId);
      await ctx.reply(`Moved to ${newTime}`, { reply_to_message_id: ctx.message.message_id });
      if (allResolved) {
        await afterConflictsDone(ctx, ctx.chat.id);
      }
    } else {
      await ctx.reply('Please enter time in HH:MM format (e.g. 14:30).');
    }
    return;
  }

  const customIndex = getWaitingCustom(ctx.chat.id);
  if (customIndex !== undefined) {
    const minutes = parseInt(text.trim());
    if (!isNaN(minutes) && minutes > 0) {
      clearWaitingCustom(ctx.chat.id);
      const result = applyReminderOffset(ctx.chat.id, customIndex, minutes);
      if (result.done) {
        await ctx.reply(result.msg);
      } else {
        await ctx.reply(result.msg, {
          reply_markup: getTaskKeyboard(
            getPendingSession(ctx.chat.id)?.currentTaskIndex ?? 0,
            getPendingSession(ctx.chat.id)?.tasks.length ?? 0
          ),
        });
      }
    } else {
      await ctx.reply('Enter a valid number of minutes (e.g. 15).');
    }
    return;
  }

  // Pre-check: user asking about their plans? (no \b — Cyrillic incompatible)
  const lower = text.toLowerCase().trim();
  const isQuery = /(?:какие|какой|какая|сколько)\s+(?:у меня|сегодня|завтра|планы|задачи|дела|расписание)/.test(lower)
    || /что\s+(?:у меня|я|на|сегодня|завтра|там)/.test(lower)
    || /(?:мои|мой|моя)\s+(?:план|задач|расписание)/.test(lower)
    || /^(?:какие планы|что у меня|когда у меня|покажи|показать|скажи)\s/.test(lower)
    || /(?:what|which)\s.*(?:do i have|are my|is my|plans|tasks|schedule|agenda)/.test(lower)
    || /(?:my plans|my tasks|my schedule|my agenda)/.test(lower)
    || /(?:қандай|менің)\s+(?:тапсырма|жоспар)/.test(lower);

  if (isQuery) {
    const plan = getPlan(ctx.chat.id);
    if (!plan) { await ctx.reply('У вас пока нет сохранённых планов.'); return; }
    const lines = plan.todos.filter(t => !t.done).map(t => {
      let s = '';
      if (t.time) s += ` \u00B7 ${t.time}`;
      if (t.date) s += ` \u00B7 ${t.date}`;
      return `\u2014 ${t.task}${s}`;
    });
    const msg = lines.length > 0
      ? `ВАШИ ЗАДАЧИ\n\n${lines.join('\n')}`
      : 'Нет активных задач.';
    await ctx.reply(msg);
    return;
  }

  // Route text through GPT for classification
  await handleTextMessage(ctx, text);
});

bot.catch((err) => {
  logger.error({ updateId: err.ctx.update.update_id, error: err.error }, 'Bot error');
});

initScheduler(bot);

async function setBotCommands() {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Начать / перезапустить бота' },
      { command: 'report', description: 'Показать все задачи' },
      { command: 'language', description: 'Сменить язык (рус / eng / қаз)' },
      { command: 'help', description: 'Помощь' },
      { command: 'ping', description: 'Проверка работы' },

    ]);
    logger.info('Bot commands registered');
  } catch (e) {
    logger.warn(e, 'Failed to set commands');
  }
}

const app = createServer();

// Setup webhook or polling
(async () => {
  if (config.webhookDomain) {
    const webhookUrl = `${config.webhookDomain}/webhook`;
    app.use(webhookCallback(bot, 'express', {
      timeoutMilliseconds: 30_000,
    }));
    await bot.api.setWebhook(webhookUrl).catch(() => {});
    logger.info({ webhookUrl }, 'Webhook configured');
    await setBotCommands();
  } else {
    logger.info('No WEBHOOK_DOMAIN set — using long polling');
  }

  app.listen(config.port, '0.0.0.0', () => {
    logger.info({ port: config.port }, 'Express server running');
  });

  if (!config.webhookDomain) {
    logger.info('Starting bot polling...');
    bot.start({
      onStart: async (info) => {
        logger.info({ username: info.username, model: config.openaiModel, github: config.isGitHubModels, userId: config.allowedUserId || 'any' }, 'Bot started');
        await setBotCommands();
      },
    });
  }
})();

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down...');
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    logger.info('Webhook deleted');
  } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
