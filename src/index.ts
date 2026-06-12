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
    start: 'flex — voice notes assistant\n\nSend a voice message. I will transcribe it, extract tasks, and generate a structured report.\n\nCommands:\n/report — view all current tasks\n/language — change language\n\nLocation is detected automatically from your messages.',
    lang_set: 'Language set to Russian.',
    ping: 'pong',
    wait_report: 'Analyzing tasks...',
    no_tasks: 'No tasks yet. Send a voice message.',
  },
  en: {
    start: 'flex — voice notes assistant\n\nSend a voice message. I will transcribe it, extract tasks, and generate a structured report.\n\nCommands:\n/report — view all current tasks\n/language — change language\n\nLocation is detected automatically from your messages.',
    lang_set: 'Language set to English.',
    ping: 'pong',
    wait_report: 'Analyzing tasks...',
    no_tasks: 'No tasks yet. Send a voice message.',
  },
  kk: {
    start: 'flex — voice notes assistant\n\nSend a voice message. I will transcribe it, extract tasks, and generate a structured report.\n\nCommands:\n/report — view all current tasks\n/language — change language\n\nLocation is detected automatically from your messages.',
    lang_set: 'Language set to Kazakh.',
    ping: 'pong',
    wait_report: 'Analyzing tasks...',
    no_tasks: 'No tasks yet. Send a voice message.',
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
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error(err, 'Report generation failed');
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, 'Error.');
  }
});

bot.command('start', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'en';
  await ctx.reply(i18n[lang].start);
});

bot.command('help', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'en';
  await ctx.reply(i18n[lang].start);
});

bot.on('message:voice', handleVoice);
bot.on('message:audio', (ctx) => ctx.reply('Send a voice message (hold mic), not an audio file.'));

// Debug: /test <text> — run text through analysis without voice
bot.command('test', async (ctx) => {
  const text = ctx.match;
  if (!text) { await ctx.reply('Usage: /test <text to analyze>'); return; }
  const userId = ctx.from!.id;
  const msg = await ctx.reply('Analyzing...');
  try {
    const analysis = await analyzeTranscript(text);
    if (ctx.chat) savePlan(ctx.chat.id, userId, analysis);
    const lines = analysis.todos.map(t => `\u2014 ${t.task} \u00B7 ${t.priority}${t.time ? ' \u00B7 ' + t.time : ''}${t.date ? ' \u00B7 ' + t.date : ''}`).join('\n');
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id,
      `${analysis.title}\n\n${analysis.summary}\n\nTASKS\n${lines || '\u2014'}\n\nLANG: ${analysis.language}\nTAGS: ${analysis.tags.join(', ') || '\u2014'}`
    );
  } catch (err) {
    logger.error(err, '[Test] Error');
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, 'Error.');
  }
});

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

  // Route text through GPT for classification
  await handleTextMessage(ctx, text);
});

bot.catch((err) => {
  logger.error({ updateId: err.ctx.update.update_id, error: err.error }, 'Bot error');
});

initScheduler(bot);

const app = createServer();

// Setup webhook or polling
if (config.webhookDomain) {
  const webhookUrl = `${config.webhookDomain}/webhook`;
  app.use(webhookCallback(bot, 'express', {
    timeoutMilliseconds: 30_000,
  }));
  bot.api.setWebhook(webhookUrl);
  logger.info({ webhookUrl }, 'Webhook configured');
} else {
  logger.info('No WEBHOOK_DOMAIN set — using long polling');
}

app.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port }, 'Express server running');
});

if (!config.webhookDomain) {
  logger.info('Starting bot polling...');
  bot.start({
    onStart: (info) => {
      logger.info({ username: info.username, model: config.openaiModel, github: config.isGitHubModels, userId: config.allowedUserId || 'any' }, 'Bot started');
    },
  });
}

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
