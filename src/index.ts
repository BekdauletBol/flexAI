import fs from "fs";
import path from "path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import {
  handleVoice,
  handlePlanIntent,
  handleQuestionIntent,
  routeByIntent,
  continueFlow,
  routeImageFollowup,
} from "./handlers/voice.js";
import { handleImage, pendingImageTasks, mapSourceAppToTaskSource } from "./handlers/image.js";
import { initScheduler } from "./services/scheduler.js";
import { createServer, resetStartTime } from "./server.js";
import {
  setUserLanguage,
  getUserConfig,
  setUserLocation,
  setReminderOffset,
} from "./services/userConfig.js";
import {
  getUserTasks,
  getWeeklyPlans,
  archiveCompletedTasks,
  savePlan,
  deleteAllUserPlans,
  updateTaskDateTime,
  getKzToday,
  getTasksFiltered,
  prepareReportTasks,
} from "./services/planStore.js";
import {
  generateFullReport,
  generateWeeklyReport,
} from "./services/reporter.js";
import { geocodeCity } from "./services/location.js";
import { generateReportPdf } from "./services/pdf.js";

import {
  getNavKeyboard,
  buildConflictMessage,
  buildCombinedConflictMessage,
  getCombinedConflictKeyboard,
  getSingleConflictKeyboard,
  buildRescheduleDatePicker,
  getRescheduleDateKeyboard,
  buildRescheduleTimePicker,
  getRescheduleTimeKeyboard,
  buildRescheduleConfirm,
} from "./services/messages.js";
import {
  getPending,
  deletePending,
  getUserFlowState,
  setUserFlowState,
  clearUserFlowState,
  setRescheduleState,
  getRescheduleState,
  clearRescheduleState,
  getUserState,
  isAwaitingVoiceFollowup,
  clearAwaitingVoiceFollowup,
  clearAwaitingImageFollowup,
} from "./services/pendingStore.js";
import { startDeliveryFlow, advanceReminderLoop } from "./services/delivery.js";
import {
  scheduleReminders,
  cancelReminderByTaskId,
  snoozeReminder,
  snoozeReminderUntilMorning,
} from "./services/scheduler.js";
import { detectIntent } from "./services/intent.js";
import { db } from "./services/db.js";
import { logger } from "./logger.js";
import { voiceQueue, getQueueStats } from "./services/queue.js";

console.log("[Config] Model:", process.env.OPENAI_MODEL || "not set");
console.log("[Config] BaseURL:", process.env.OPENAI_BASE_URL || "not set");
console.log("[Config] OpenAI key exists:", !!process.env.OPENAI_API_KEY);
console.log("[Config] GitHub token exists:", !!process.env.GITHUB_TOKEN);
console.log("[Config] Groq key exists:", !!process.env.GROQ_API_KEY);

const bot = new Bot(config.telegramToken);

const SEP = "———————————————";

// Localised strings

const i18n = {
  ru: {
    start: [
      "flex — голосовой ассистент для задач.",
      "",
      "Отправь голосовое сообщение. Я транскрибирую его, извлеку задачи и сгенерирую PDF-отчет.",
      "",
      SEP,
      "",
      "КОМАНДЫ",
      "",
      "— /report   все текущие задачи",
      "— /weekly   отчет за 7 дней",
      "— /clear    архивировать выполненные",
      "— /language сменить язык",
    ].join("\n"),

    lang_set: "Язык изменен на русский.",
    ping: "понг",

    wait_report: "Загрузка задач...",
    no_tasks: "Задач пока нет. Отправьте голосовое сообщение.",

    no_weekly: "За последние 7 дней записей нет.",
    cleared: (n: number) => `Архивировано задач: ${n}.`,
    cleared_none: "Выполненных задач нет.",

    voice_only: "Отправьте голосовое сообщение.",
    audio_note:
      "Отправьте голосовое сообщение (зажмите микрофон), а не аудиофайл.",
  },
  en: {
    start: [
      "flex — a voice note assistant for tasks.",
      "",
      "Send a voice message. I will transcribe it, extract tasks, and generate a PDF report.",
      "",
      SEP,
      "",
      "COMMANDS",
      "",
      "— /report   all current tasks",
      "— /weekly   report for the past 7 days",
      "— /clear    archive completed tasks",
      "— /language change language",
    ].join("\n"),

    lang_set: "Language set to English.",
    ping: "pong",

    wait_report: "Loading tasks...",
    no_tasks: "No tasks recorded yet. Send a voice message.",

    no_weekly: "No notes in the past 7 days.",
    cleared: (n: number) => `Archived: ${n} task${n === 1 ? "" : "s"}.`,
    cleared_none: "No completed tasks to archive.",

    voice_only: "Send a voice message.",
    audio_note:
      "Send a voice message (hold the mic button), not an audio file.",
  },
  kk: {
    start: [
      "flex — тапсырмаларға арналған дауыстық жазба көмекшісі.",
      "",
      "Дауыстық хабарлама жібер. Мен оны мәтінге айналдырамын, тапсырмаларды бөліп аламын және PDF-есеп жасаймын.",
      "",
      SEP,
      "",
      "КОМАНДАЛАР",
      "",
      "— /report   барлық ағымдағы тапсырмалар",
      "— /weekly   7 күндік есеп",
      "— /clear    орындалғандарды мұрағаттау",
      "— /language тілді өзгерту",
    ].join("\n"),

    lang_set: "Тіл қазақшаға өзгертілді.",
    ping: "понг",

    wait_report: "Тапсырмалар жүктелуде...",
    no_tasks: "Тапсырмалар жоқ. Дауыстық хабарлама жіберіңіз.",

    no_weekly: "Соңғы 7 күнде жазбалар жоқ.",
    cleared: (n: number) => `Жасырылған: ${n} тапсырма.`,
    cleared_none: "Жасырылатын орындалған тапсырма жоқ.",

    voice_only: "Дауыстық хабарлама жіберіңіз.",
    audio_note:
      "Аудиофайл емес, дауыстық хабарлама жіберіңіз (микрофон батырмасын ұстап тұр).",
  },
} as const;

type Lang = keyof typeof i18n;

function getLang(userId: number): Lang {
  const lang = getUserConfig(userId).language || "en";
  return (["ru", "en", "kk"].includes(lang) ? lang : "en") as Lang;
}

// Rate limiter (sliding window, 10 req/min per user)

const userRequests = new Map<number, number[]>();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60_000;

function checkRateLimit(userId: number): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW;
  let timestamps = userRequests.get(userId) || [];
  timestamps = timestamps.filter((t) => t > windowStart);
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  userRequests.set(userId, timestamps);
  return true;
}

// Request logging middleware

bot.use(async (ctx, next) => {
  const start = Date.now();
  const userId = ctx.from?.id ?? 0;
  const type = ctx.message?.voice
    ? "voice"
    : ctx.message?.text
      ? "text"
      : ctx.message?.photo
        ? "photo"
        : "other";
  await next();
  logger.info(
    {
      userId,
      type,
      duration: Date.now() - start,
      updateId: ctx.update.update_id,
    },
    "Update processed",
  );
});

// User cap + rate limit middleware

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  // Hard cap check — only for new (unregistered) users
  const user = db
    .prepare("SELECT language FROM users WHERE user_id = ?")
    .get(userId) as any;
  if (!user) {
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }
    ).c;
    if (count >= config.maxUsers) {
      logger.warn({ userId }, "User cap reached, rejected");
      await ctx.reply("Bot is at capacity. Please try again later.");
      return;
    }
    db.prepare("INSERT INTO users (user_id, language) VALUES (?, ?)").run(
      userId,
      "ru",
    );
    logger.info({ userId }, "New user registered");
  }

  // Rate limit
  if (!checkRateLimit(userId)) {
    const lang = getLang(userId);
    await ctx.reply(
      lang === "ru"
        ? "Слишком много запросов. Подождите минуту."
        : lang === "kk"
          ? "Тым көп сұраныс. Бір минут күтіңіз."
          : "Too many requests. Please wait a minute.",
    );
    return;
  }

  await next();
});

// Commands

bot.command("ping", async (ctx) => {
  const lang = getLang(ctx.from!.id);
  await ctx.reply(i18n[lang].ping);
});

bot.command("start", async (ctx) => {
  const lang = getLang(ctx.from!.id);
  // Ensure user exists in DB before any task operations
  db.prepare(
    `
    INSERT OR IGNORE INTO users (user_id, language)
    VALUES (?, 'ru')
  `,
  ).run(ctx.from!.id);
  // Remove any lingering reply keyboard (e.g. old "Share Location" button)
  const navKeyboard = getNavKeyboard(lang);
  await ctx.reply(i18n[lang].start, { reply_markup: navKeyboard });
});

bot.command("help", async (ctx) => {
  const lang = getLang(ctx.from!.id);
  await ctx.reply(i18n[lang].start);
});

bot.command("language", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text("Русский", "lang_ru")
    .text("English", "lang_en")
    .text("Казакша", "lang_kk");

  await ctx.reply("Select language / Выберите язык / Тілді таңдаңыз:", {
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/lang_(ru|en|kk)/, async (ctx) => {
  const lang = ctx.match[1] as Lang;
  setUserLanguage(ctx.from.id, lang);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(i18n[lang].lang_set);
});

bot.command("report", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !ctx.chat) return;

  if (isAwaitingVoiceFollowup(ctx.chat.id)) {
    const lang = getLang(userId);
    await ctx.reply(
      lang === "ru"
        ? "Жду голосовое сообщение после скриншота."
        : lang === "kk"
          ? "Скриншоттан кейін дауыстық хабарлама күтемін."
          : "Waiting for a voice message after the screenshot.",
    );
    return;
  }

  const lang = getLang(userId);
  const rawTasks = getTasksFiltered(userId, { date: getKzToday(), includeDone: true });
  const { tasks, overdue } = prepareReportTasks(rawTasks, getKzToday());

  if (tasks.length === 0 && overdue.length === 0) {
    await ctx.reply(i18n[lang].no_tasks);
    return;
  }

  const statusMsg = await ctx.reply(i18n[lang].wait_report);

  try {
    const summary =
      overdue.length > 0
        ? (lang === "ru"
            ? `ПРОСРОЧЕНО:\n${overdue.map((t) => `— ${t.task}`).join("\n")}\n\n`
            : lang === "kk"
              ? `МЕРЗІМІ ӨТКЕН:\n${overdue.map((t) => `— ${t.task}`).join("\n")}\n\n`
              : `OVERDUE:\n${overdue.map((t) => `— ${t.task}`).join("\n")}\n\n`) +
          (lang === "ru"
            ? `Всего: ${tasks.length}`
            : lang === "kk"
              ? `Барлығы: ${tasks.length}`
              : `Total: ${tasks.length}`)
        : undefined;
    const pdfBuf = await generateReportPdf(tasks, lang, summary ? { summary } : undefined);
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}

    const fn = `report_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), {
      caption: "Report",
      reply_markup: getNavKeyboard(lang),
    });
  } catch (err: any) {
    console.error("[PDF] Generation failed:", err.message, err.stack);
    try {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `[PDF] ${err.message}`, {
        reply_markup: getNavKeyboard(lang),
      });
    } catch {}
  }
});

bot.command("weekly", async (ctx) => {
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
    const tasks = plans.flatMap((p) => p.todos);
    const pdfBuf = await generateReportPdf(tasks, lang);
    try {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch {}

    const fn = `weekly_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), {
      caption: "Weekly Report",
      reply_markup: getNavKeyboard(lang),
    });
  } catch (err: any) {
    console.error("[PDF] Generation failed:", err.message, err.stack);
    try {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `[PDF] ${err.message}`, {
        reply_markup: getNavKeyboard(lang),
      });
    } catch {}
  }
});

bot.command("clear", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = getLang(userId);
  const archived = archiveCompletedTasks(userId);

  if (archived === 0) {
    await ctx.reply(i18n[lang].cleared_none, {
      reply_markup: getNavKeyboard(lang),
    });
  } else {
    await ctx.reply(i18n[lang].cleared(archived), {
      reply_markup: getNavKeyboard(lang),
    });
  }
});

bot.command("reminders", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !ctx.chat) return;

  const lang = getLang(userId);
  const { getActiveReminders } = await import("./services/db.js");
  const reminders = getActiveReminders(userId);

  if (reminders.length === 0) {
    await ctx.reply(
      lang === "ru" ? "Активных напоминаний нет."
        : lang === "kk" ? "Белсенді еске салулар жоқ."
          : "No active reminders.",
      { reply_markup: getNavKeyboard(lang) },
    );
    return;
  }

  const lines: string[] = [];
  const keyboard = new InlineKeyboard();

  for (const r of reminders) {
    const dt = r.scheduled_time_kz || r.datetime || '';
    let timeLabel = '';
    if (dt) {
      try {
        const { DateTime } = await import("luxon");
        const d = DateTime.fromISO(dt.includes('T') ? dt : dt + 'T00:00', { zone: dt.includes('Z') ? 'utc' : 'Asia/Almaty' });
        timeLabel = d.setZone('Asia/Almaty').toFormat('HH:mm');
      } catch {
        timeLabel = String(dt).slice(11, 16) || '??:??';
      }
    }
    lines.push(`🔔 Напомню о «${r.task}» в ${timeLabel}`);
    keyboard.text(`Отменить ❌`, `cancel_reminder_${r.id}`).row();
  }

  await ctx.reply(lines.join('\n'), {
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^cancel_reminder_(.+)$/, async (ctx) => {
  const taskId = ctx.match[1];
  const userId = ctx.from?.id;
  if (!userId) return;

  const { deleteReminderById } = await import("./services/db.js");
  const deleted = deleteReminderById(userId, taskId);

  // Also remove from in-memory scheduler
  if (deleted) {
    const { cancelReminderByTaskId } = await import("./services/scheduler.js");
    cancelReminderByTaskId(taskId);
  }

  await ctx.answerCallbackQuery();
  const lang = getLang(userId);
  await ctx.editMessageText(
    deleted
      ? (lang === "ru" ? "Напоминание удалено." : lang === "kk" ? "Еске салу өшірілді." : "Reminder deleted.")
      : (lang === "ru" ? "Не удалось удалить." : lang === "kk" ? "Өшіру мүмкін болмады." : "Failed to delete."),
  );
});

bot.command("stats", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (config.adminTelegramId && userId !== config.adminTelegramId) {
    await ctx.reply("Access denied.");
    return;
  }
  const userCount = (
    db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;
  const todoCount = (
    db.prepare("SELECT COUNT(*) as c FROM todos").get() as { c: number }
  ).c;
  const queueStats = getQueueStats();
  const uptime = Math.floor((Date.now() - process.uptime() * 1000) / 1000);
  await ctx.reply(
    `📊 STATS\n\nUsers: ${userCount} / ${config.maxUsers}\nTasks: ${todoCount}\nQueue: ${queueStats.size} waiting, ${queueStats.pending} pending\nUptime: ${uptime}s`,
  );
});

// Hidden — nuke all tasks for testing
bot.command("nuke", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  deleteAllUserPlans(userId);
  await ctx.reply("All tasks deleted.");
});

// Hidden — kept for backward compat but not surfaced in /start
bot.command("setcity", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = getLang(userId);
  const cityName = ctx.match;

  if (!cityName) {
    await ctx.reply("Provide a city name: /setcity Almaty");
    return;
  }

  const statusMsg = await ctx.reply(`Searching for "${cityName}"...`);

  try {
    const coords = await geocodeCity(cityName);
    if (!coords) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `City not found: ${cityName}`,
      );
      return;
    }

    setUserLocation(userId, cityName, coords.lat, coords.lng);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Location set.\n\n— ${cityName}\n— ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`,
    );
  } catch (err) {
    console.error("[Bot] Failed to set city:", err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "Error setting location.",
    );
  }
});

// ─── Callback handlers

bot.callbackQuery("nav_report", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const lang = getLang(userId);
  if (ctx.chat && isAwaitingVoiceFollowup(ctx.chat.id)) {
    await ctx.reply(
      lang === "ru"
        ? "Жду голосовое сообщение после скриншота."
        : "Waiting for a voice message after the screenshot.",
    );
    return;
  }
  const rawTasks = getTasksFiltered(userId, { date: getKzToday(), includeDone: true });
  const { tasks, overdue } = prepareReportTasks(rawTasks, getKzToday());
  if (tasks.length === 0 && overdue.length === 0) {
    await ctx.reply(i18n[lang].no_tasks);
    return;
  }
  try {
    const summary =
      overdue.length > 0
        ? `OVERDUE:\n${overdue.map((t) => `— ${t.task}`).join("\n")}`
        : undefined;
    const pdfBuf = await generateReportPdf(tasks, lang, summary ? { summary } : undefined);
    const fn = `report_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), {
      caption: "Report",
      reply_markup: getNavKeyboard(lang),
    });
  } catch (err) {
    console.error("[Bot] Report generation failed:", err);
    const report = await generateFullReport(tasks, lang);
    await ctx.reply(report, { reply_markup: getNavKeyboard(lang) });
  }
});

bot.callbackQuery("nav_weekly", async (ctx) => {
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
    const tasks = plans.flatMap((p) => p.todos);
    const pdfBuf = await generateReportPdf(tasks, lang);
    try {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch {}
    const fn = `weekly_${userId}_${Date.now()}.pdf`;
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), {
      caption: "Weekly Report",
      reply_markup: getNavKeyboard(lang),
    });
  } catch (err) {
    console.error("[Bot] Weekly PDF failed:", err);
    const report = generateWeeklyReport(plans, lang);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, {
      reply_markup: getNavKeyboard(lang),
    });
  }
});

function handleClearCompleted(ctx: any, userId: number, lang: Lang) {
  const archived = archiveCompletedTasks(userId);
  if (archived === 0) {
    ctx.reply(i18n[lang].cleared_none, { reply_markup: getNavKeyboard(lang) });
  } else {
    ctx.reply(i18n[lang].cleared(archived), {
      reply_markup: getNavKeyboard(lang),
    });
  }
}

bot.callbackQuery("nav_clear", async (ctx) => {
  await ctx.answerCallbackQuery();
  handleClearCompleted(ctx, ctx.from.id, getLang(ctx.from.id));
});

bot.callbackQuery("menu_clear", async (ctx) => {
  await ctx.answerCallbackQuery();
  handleClearCompleted(ctx, ctx.from.id, getLang(ctx.from.id));
});

bot.callbackQuery("nav_language", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text("Русский", "lang_ru")
    .text("English", "lang_en")
    .text("Казакша", "lang_kk");
  await ctx.reply("Select language / Выберите язык / Тілді таңдаңыз:", {
    reply_markup: keyboard,
  });
});

// ─── Combined Conflict Callbacks

bot.callbackQuery(/^conflict_keep_all_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }

  await ctx.answerCallbackQuery();

  if (ctx.chat) {
    savePlan(ctx.chat.id, pending.userId, pending.analysis, pending.source);
  }

  if (ctx.callbackQuery.message) {
    try {
      await ctx.api.deleteMessage(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
      );
    } catch {}
  }

  await startDeliveryFlow(ctx, pending);
});

bot.callbackQuery(/^conflict_skip_all_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }

  await ctx.answerCallbackQuery();

  const conflictedIds = new Set(pending.conflicts.map((c) => c.newTodo.id));
  pending.resolvedTodos = pending.analysis.todos.filter(
    (t) => !conflictedIds.has(t.id),
  );

  if (ctx.callbackQuery.message) {
    try {
      await ctx.api.deleteMessage(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
      );
    } catch {}
  }

  await startDeliveryFlow(ctx, pending);
});

bot.callbackQuery(/^conflict_one_by_one_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }

  await ctx.answerCallbackQuery();

  pending.conflictIndex = 0;

  const conflict = pending.conflicts[0];
  const conflictMsg = buildConflictMessage(
    [conflict],
    pending.analysis.language,
  );
  const keyboard = getSingleConflictKeyboard(
    pendingId,
    0,
    pending.analysis.language,
  );

  if (ctx.callbackQuery.message) {
    try {
      await ctx.api.deleteMessage(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
      );
    } catch {}
  }
  await ctx.reply(conflictMsg, { reply_markup: keyboard });
});

bot.callbackQuery(/^conflict_keep_idx_(.+)_(\d+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const conflictIndex = parseInt(ctx.match[2], 10);
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }

  await ctx.answerCallbackQuery();

  const nextIndex = conflictIndex + 1;

  if (nextIndex >= pending.conflicts.length) {
    if (ctx.chat) {
      savePlan(ctx.chat.id, pending.userId, pending.analysis, pending.source);
    }
    if (ctx.callbackQuery.message) {
      try {
        await ctx.api.deleteMessage(
          ctx.chat!.id,
          ctx.callbackQuery.message.message_id,
        );
      } catch {}
    }
    await startDeliveryFlow(ctx, pending);
  } else {
    pending.conflictIndex = nextIndex;
    const conflict = pending.conflicts[nextIndex];
    const conflictMsg = buildConflictMessage(
      [conflict],
      pending.analysis.language,
    );
    const keyboard = getSingleConflictKeyboard(
      pendingId,
      nextIndex,
      pending.analysis.language,
    );

    if (ctx.callbackQuery.message) {
      try {
        await ctx.api.deleteMessage(
          ctx.chat!.id,
          ctx.callbackQuery.message.message_id,
        );
      } catch {}
    }
    await ctx.reply(conflictMsg, { reply_markup: keyboard });
  }
});

bot.callbackQuery(/^conflict_reschedule_idx_(.+)_(\d+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const conflictIndex = parseInt(ctx.match[2], 10);
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("Expired.");
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
    currentTime: task.time || "09:00",
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
    await ctx.answerCallbackQuery("Expired.");
    return;
  }

  await ctx.answerCallbackQuery();

  const skipTask = pending.conflicts[conflictIndex].newTodo;
  pending.analysis.todos = pending.analysis.todos.filter(
    (t) => t.id !== skipTask.id,
  );
  pending.resolvedTodos = pending.resolvedTodos.filter(
    (t) => t.id !== skipTask.id,
  );

  const nextIndex = conflictIndex + 1;

  if (nextIndex >= pending.conflicts.length) {
    if (ctx.chat) {
      savePlan(ctx.chat.id, pending.userId, pending.analysis, pending.source);
    }
    if (ctx.callbackQuery.message) {
      try {
        await ctx.api.deleteMessage(
          ctx.chat!.id,
          ctx.callbackQuery.message.message_id,
        );
      } catch {}
    }
    await startDeliveryFlow(ctx, pending);
  } else {
    pending.conflictIndex = nextIndex;
    const conflict = pending.conflicts[nextIndex];
    const conflictMsg = buildConflictMessage(
      [conflict],
      pending.analysis.language,
    );
    const keyboard = getSingleConflictKeyboard(
      pendingId,
      nextIndex,
      pending.analysis.language,
    );

    if (ctx.callbackQuery.message) {
      try {
        await ctx.api.deleteMessage(
          ctx.chat!.id,
          ctx.callbackQuery.message.message_id,
        );
      } catch {}
    }
    await ctx.reply(conflictMsg, { reply_markup: keyboard });
  }
});

// ─── Interactive Reschedule Picker ─────────────────────────────────────────────

bot.callbackQuery(/^rs_d_(today|tomorrow|plus2|custom)$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }
  await ctx.answerCallbackQuery();

  const option = ctx.match[1];
  const now = new Date();

  if (option === "custom") {
    const prompt =
      state.lang === "ru"
        ? "Введите дату в формате DD.MM (например 15.06)"
        : state.lang === "kk"
          ? "DD.MM форматында күнді енгізіңіз (мысалы 15.06)"
          : "Enter date in DD.MM format (e.g. 15.06)";
    await ctx.editMessageText(prompt);
    setUserFlowState(userId, {
      type: "awaiting_reschedule",
      pendingId: "",
      customField: "date",
    });
    return;
  }

  let dateObj: Date;
  if (option === "today") dateObj = now;
  else if (option === "tomorrow") {
    dateObj = new Date(now);
    dateObj.setDate(dateObj.getDate() + 1);
  } else {
    dateObj = new Date(now);
    dateObj.setDate(dateObj.getDate() + 2);
  }

  const dateStr = dateObj.toISOString().substring(0, 10);
  state.selectedDate = dateStr;

  const dateLabel = dateObj.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const timeMsg = buildRescheduleTimePicker(
    state.taskName,
    dateLabel,
    state.lang,
  );
  const timeKb = getRescheduleTimeKeyboard(state.lang);

  await ctx.editMessageText(timeMsg, { reply_markup: timeKb });
});

bot.callbackQuery(/^rs_t_custom$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }
  await ctx.answerCallbackQuery();

  const prompt =
    state.lang === "ru"
      ? "Введите время в формате HH:MM (например 14:30)"
      : state.lang === "kk"
        ? "HH:MM форматында уақытты енгізіңіз (мысалы 14:30)"
        : "Enter time in HH:MM format (e.g. 14:30)";
  await ctx.editMessageText(prompt);
  setUserFlowState(userId, {
    type: "awaiting_reschedule",
    pendingId: "",
    customField: "time",
  });
});

bot.callbackQuery(/^rs_t_(\d{2}:\d{2})$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state || !state.selectedDate) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }
  await ctx.answerCallbackQuery();

  state.selectedTime = ctx.match[1];

  const confirmMsg = buildRescheduleConfirm(
    state.taskName,
    state.currentDate,
    state.currentTime,
    state.selectedDate,
    state.selectedTime,
    state.lang,
  );
  const confirmKb = new InlineKeyboard().text(
    state.lang === "ru"
      ? "Подтвердить"
      : state.lang === "kk"
        ? "Растау"
        : "Confirm",
    "rs_confirm",
  );
  await ctx.editMessageText(confirmMsg, { reply_markup: confirmKb });
});

bot.callbackQuery("rs_confirm", async (ctx) => {
  const userId = ctx.from.id;
  const state = getRescheduleState(userId);
  if (!state || !state.selectedDate || !state.selectedTime) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }
  await ctx.answerCallbackQuery();

  const {
    taskId,
    selectedDate,
    selectedTime,
    currentDate,
    currentTime,
    lang,
    pendingId,
    conflictIndex,
  } = state;

  // Bug 4: Check if new datetime is same as old datetime
  if (selectedDate === currentDate && selectedTime === currentTime) {
    const timeMsg =
      lang === "ru"
        ? "Это то же самое время. Выберите другое."
        : lang === "kk"
          ? "Бұл сол уақыт. Басқасын таңдаңыз."
          : "This is the same time. Pick another.";
    await ctx.editMessageText(timeMsg);
    // Re-show date picker
    const dateMsg = buildRescheduleDatePicker(state.taskName, lang);
    const dateKb = getRescheduleDateKeyboard(lang);
    await ctx.reply(dateMsg, { reply_markup: dateKb });
    return;
  }

  // Check if new time conflicts with another task
  const allUserTasks = getUserTasks(userId);
  const otherTasks = allUserTasks.filter(
    (t) => t.id !== taskId && !t.done && t.time && t.date,
  );
  const conflict = otherTasks.find(
    (t) => t.time === selectedTime && t.date === selectedDate,
  );
  if (conflict) {
    const conflictMsg =
      lang === "ru"
        ? `КОНФЛИКТ\n\nВ ${selectedTime} уже запланировано:\n— ${conflict.task}\n\nВыберите другое время.`
        : lang === "kk"
          ? `ҚАЙШЫЛЫҚ\n\n${selectedTime} уақытында жоспарланған:\n— ${conflict.task}\n\nБасқа уақыт таңдаңыз.`
          : `CONFLICT\n\nAt ${selectedTime} you already have:\n— ${conflict.task}\n\nPick a different time.`;
    await ctx.editMessageText(conflictMsg);
    const timeMsg = buildRescheduleTimePicker(
      state.taskName,
      selectedDate,
      lang,
    );
    const timeKb = getRescheduleTimeKeyboard(lang);
    await ctx.reply(timeMsg, { reply_markup: timeKb });
    return;
  }

  clearRescheduleState(userId);
  clearUserFlowState(userId);

  // Cancel old reminder
  cancelReminderByTaskId(taskId);

  // Update task in database
  const updated = updateTaskDateTime(
    userId,
    taskId,
    selectedDate,
    selectedTime,
  );
  if (updated && ctx.chat) {
    scheduleReminders(ctx.chat.id, userId, [updated], lang);
  }

  // If batch mode (one by one), advance to next conflict
  if (pendingId && conflictIndex !== undefined) {
    const pending = getPending(pendingId);
    if (pending) {
      const nextIndex = conflictIndex + 1;
      if (nextIndex >= pending.conflicts.length) {
        if (ctx.chat) savePlan(ctx.chat.id, userId, pending.analysis, pending.source);
        await ctx.editMessageText(
          lang === "ru"
            ? "Все конфликты разрешены."
            : lang === "kk"
              ? "Барлық қайшылықтар шешілді."
              : "All conflicts resolved.",
        );
        await startDeliveryFlow(ctx, pending);
      } else {
        pending.conflictIndex = nextIndex;
        const conflict = pending.conflicts[nextIndex];
        const conflictMsg = buildConflictMessage([conflict], lang);
        const keyboard = getSingleConflictKeyboard(pendingId, nextIndex, lang);
        try {
          await ctx.api.deleteMessage(
            ctx.chat!.id,
            ctx.callbackQuery.message!.message_id,
          );
        } catch {}
        await ctx.reply(conflictMsg, { reply_markup: keyboard });
      }
      return;
    }
  }

  // Single conflict mode
  const confirmMsg = buildRescheduleConfirm(
    state.taskName,
    currentDate,
    currentTime,
    selectedDate,
    selectedTime,
    lang,
  );
  try {
    await ctx.editMessageText(confirmMsg);
  } catch {}
  await ctx.reply(
    lang === "ru" ? "Готово." : lang === "kk" ? "Дайын." : "Done.",
    { reply_markup: getNavKeyboard(lang) },
  );
});

// ─── Single Conflict Callbacks ─────────────────────────────────────────────────

bot.callbackQuery(/^conflict_keep_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }

  await ctx.answerCallbackQuery();

  if (ctx.chat) {
    savePlan(ctx.chat.id, pending.userId, pending.analysis, pending.source);
  }

  if (ctx.callbackQuery.message) {
    try {
      await ctx.api.deleteMessage(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
      );
    } catch {}
  }

  await startDeliveryFlow(ctx, pending);
});

// Note: conflict_reschedule_ is handled above (single conflict) and
// conflict_reschedule_idx_ is in the combined conflict section

bot.callbackQuery(/^conflict_skip_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = getPending(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("Expired.");
    return;
  }

  await ctx.answerCallbackQuery();

  const skipTask = pending.conflicts[0].newTodo;
  pending.analysis.todos = pending.analysis.todos.filter(
    (t) => t.id !== skipTask.id,
  );
  pending.resolvedTodos = pending.resolvedTodos.filter(
    (t) => t.id !== skipTask.id,
  );

  if (ctx.callbackQuery.message) {
    try {
      await ctx.api.deleteMessage(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
      );
    } catch {}
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
      try {
        await ctx.api.deleteMessage(
          ctx.chat!.id,
          ctx.callbackQuery.message.message_id,
        );
      } catch {}
    }
    return;
  }

  const todos = pending.resolvedTodos || pending.analysis.todos;
  const currentTaskIndex = pending.reminderIndex;

  if (currentTaskIndex >= todos.length) return;
  const currentTask = todos[currentTaskIndex];

  if (action === "custom") {
    const lang = pending.analysis.language;
    const prompt =
      lang === "ru"
        ? `Введите время (и дату) для:\n"${currentTask.task}"\nФормат: HH:MM или DD.MM HH:MM`
        : lang === "kk"
          ? `Уақытты (және күнді) енгізіңіз:\n"${currentTask.task}"\nФормат: HH:MM немесе DD.MM HH:MM`
          : `Enter time (and date) for:\n"${currentTask.task}"\nFormat: HH:MM or DD.MM HH:MM`;

    if (ctx.callbackQuery.message) {
      await ctx.editMessageText(prompt);
    } else {
      await ctx.reply(prompt);
    }
    setUserFlowState(pending.userId, {
      type: "awaiting_custom_reminder",
      pendingId,
      taskIndex: currentTaskIndex,
    });
    return;
  }

  const offsetMinutes = action === "none" ? -1 : parseInt(action, 10);

  // Set default (if not none, update their default)
  if (offsetMinutes !== -1) {
    setReminderOffset(ctx.from.id, offsetMinutes);
  }

  // Schedule if not none and has a time
  if (offsetMinutes !== -1 && ctx.chat) {
    // If it doesn't have a time, we can't schedule an offset reminder,
    // but we just skip scheduling.
    if (currentTask.time) {
      scheduleReminders(
        ctx.chat.id,
        pending.userId,
        [currentTask],
        pending.analysis.language,
        offsetMinutes,
      );
    }
  }

  // Move to next task
  pending.reminderIndex++;

  // Loop again by calling delivery (it handles editing the message if we passed ctx, but it actually replies right now)
  // Since delivery uses ctx.reply, we should delete the old inline message
  if (ctx.callbackQuery.message) {
    try {
      await ctx.api.deleteMessage(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
      );
    } catch {}
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

  if (action === "done") {
    const { markTaskDone } = await import("./services/planStore.js");
    markTaskDone(userId, taskId);
    const msg =
      lang === "ru"
        ? "Отмечено как выполненное."
        : lang === "kk"
          ? "Орындалды деп белгіленді."
          : "Marked as done.";
    if (ctx.callbackQuery.message) {
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          ctx.callbackQuery.message.message_id,
          msg,
        );
      } catch {}
    }
    cancelReminderByTaskId(taskId);
    return;
  }

  let minutes: number;
  let snoozedUntilStr: string | null = null;

  if (action === "tmrw") {
    const tomorrow9am = new Date();
    tomorrow9am.setDate(tomorrow9am.getDate() + 1);
    tomorrow9am.setHours(9, 0, 0, 0);
    minutes = Math.round((tomorrow9am.getTime() - Date.now()) / 60000);
    snoozedUntilStr = tomorrow9am.toISOString();
  } else {
    minutes = parseInt(action, 10);
    snoozedUntilStr = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }

  const reminder =
    action === "tmrw"
      ? snoozeReminderUntilMorning(taskId, lang)
      : snoozeReminder(taskId, minutes);

  if (!reminder) {
    if (ctx.callbackQuery.message) {
      try {
        await ctx.api.deleteMessage(
          ctx.chat!.id,
          ctx.callbackQuery.message.message_id,
        );
      } catch {}
    }
    return;
  }

  // Update DB
  const { updateSnooze } = await import("./services/db.js");
  updateSnooze(taskId, snoozedUntilStr);

  const msg =
    action === "tmrw"
      ? lang === "ru"
        ? "Напомню завтра в 09:00."
        : lang === "kk"
          ? "Ертең 09:00-де еске саламын."
          : "I'll remind you tomorrow at 09:00."
      : lang === "ru"
        ? `Напомню через ${minutes} мин.`
        : lang === "kk"
          ? `${minutes} миннен кейін еске саламын.`
          : `I\'ll remind you in ${minutes} min.`;

  if (ctx.callbackQuery.message) {
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
        msg,
      );
    } catch {}
  }
});

// ─── Image Confirmation Callbacks ──────────────────────────────────────────────

bot.callbackQuery(/^img_add_all_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1], 10);
  const data = pendingImageTasks.get(userId);

  if (!data) {
    await ctx.answerCallbackQuery(
      "Session expired. Send the screenshot again.",
    );
    return;
  }

  await ctx.answerCallbackQuery();

  const { tasks } = data;
  const todos = tasks.map((t) => ({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    task: t.task,
    priority: (["high", "medium", "low"].includes(t.priority)
      ? t.priority
      : "medium") as any,
    done: false,
    time: t.time || undefined,
    date: t.date || undefined,
    duration: t.duration_minutes || 30,
    location: undefined,
    source: mapSourceAppToTaskSource(data.source),
  }));

  const analysis = {
    intent: "action" as const,
    title: `From image`,
    summary: `Added ${todos.length} tasks from screenshot.`,
    key_points: [],
    todos,
    tags: ["#screenshot"],
    raw_transcript: "[from image confirm]",
    language: "ru" as "ru" | "en" | "kk",
    timeframe: "day" as const,
    needs_location_check: false,
  };

  if (ctx.chat) {
    savePlan(ctx.chat.id, userId, analysis, mapSourceAppToTaskSource(data.source));
    const timed = todos.filter((t) => t.time);
    if (timed.length > 0) scheduleReminders(ctx.chat.id, userId, todos, "ru");
  }

  pendingImageTasks.delete(userId);
  if (ctx.chat) clearAwaitingVoiceFollowup(ctx.chat.id);
  clearAwaitingImageFollowup(userId);

  const taskList = tasks
    .map((t) => `— ${t.task}${t.time ? " · " + t.time : ""}`)
    .join("\n");
  await ctx.editMessageText(
    `СОХРАНЕНО\n\n${taskList}\n\n${todos.length} задач добавлено.`,
  );
});

bot.callbackQuery(/^img_cancel_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1], 10);
  pendingImageTasks.delete(userId);
  if (ctx.chat) clearAwaitingVoiceFollowup(ctx.chat.id);
  clearAwaitingImageFollowup(userId);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Отменено.");
});

// ─── Image: one-by-one resolution ────────────────────────────────────────────

function buildOneByOneKeyboard(userId: number, idx: number, lang: string) {
  const addLabel =
    lang === "ru" ? "✅ Добавить" : lang === "kk" ? "✅ Қосу" : "✅ Add";
  const skipLabel =
    lang === "ru" ? "⏭ Пропустить" : lang === "kk" ? "⏭ Өткізу" : "⏭ Skip";
  const doneLabel =
    lang === "ru"
      ? "💾 Сохранить выбранное"
      : lang === "kk"
        ? "💾 Таңдалғандарды сақтау"
        : "💾 Save selected";
  const cancelLabel =
    lang === "ru" ? "❌ Отмена" : lang === "kk" ? "❌ Болдырмау" : "❌ Cancel";
  return new InlineKeyboard()
    .text(addLabel, `img_evt_add_${userId}_${idx}`)
    .text(skipLabel, `img_evt_skip_${userId}_${idx}`)
    .row()
    .text(doneLabel, `img_evt_done_${userId}`)
    .text(cancelLabel, `img_cancel_${userId}`);
}

function buildOneByOneMessage(
  task: any,
  idx: number,
  total: number,
  lang: string,
  conflicts: string[],
): string {
  const lines: string[] = [];
  const header =
    lang === "ru"
      ? `СОБЫТИЕ ${idx + 1} / ${total}`
      : lang === "kk"
        ? `ОҚИҒА ${idx + 1} / ${total}`
        : `EVENT ${idx + 1} / ${total}`;
  lines.push(header);
  lines.push("");
  lines.push(`— ${task.task}`);
  if (task.time) {
    const timeStr = task.end_time ? `${task.time}–${task.end_time}` : task.time;
    lines.push(`   ⏰ ${timeStr}`);
  }
  if (task.date) lines.push(`   📅 ${task.date}`);
  if (task.notes) lines.push(`   📝 ${task.notes}`);
  if (conflicts.length > 0) {
    lines.push("");
    const warnLabel =
      lang === "ru"
        ? "⚠️ Конфликт с:"
        : lang === "kk"
          ? "⚠️ Қайшылық:"
          : "⚠️ Conflicts with:";
    lines.push(warnLabel);
    for (const c of conflicts) lines.push(`   — ${c}`);
  }
  return lines.join("\n");
}

bot.callbackQuery(/^img_one_by_one_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1], 10);
  const data = pendingImageTasks.get(userId);
  if (!data) {
    await ctx.answerCallbackQuery("Сессия истекла. Отправь скриншот заново.");
    return;
  }
  await ctx.answerCallbackQuery();

  const lang = data.lang || "ru";
  data.oneByOneIndex = 0;
  data.selections = new Array(data.tasks.length).fill(undefined);

  const existingTasks = getUserTasks(userId).filter((t) => !t.done);
  const task = data.tasks[0];
  const conflicts = existingTasks
    .filter(
      (t) =>
        t.time &&
        task.time &&
        Math.abs(
          parseInt(t.time.split(":")[0]) * 60 +
            parseInt(t.time.split(":")[1]) -
            (parseInt(task.time.split(":")[0]) * 60 +
              parseInt(task.time.split(":")[1])),
        ) < (task.duration_minutes || 30),
    )
    .map((t) => `${t.task} (${t.time})`);

  const msg = buildOneByOneMessage(task, 0, data.tasks.length, lang, conflicts);
  const kb = buildOneByOneKeyboard(userId, 0, lang);
  await ctx.editMessageText(msg, { reply_markup: kb });
});

bot.callbackQuery(/^img_evt_add_(\d+)_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1], 10);
  const idx = parseInt(ctx.match[2], 10);
  const data = pendingImageTasks.get(userId);
  if (!data) {
    await ctx.answerCallbackQuery("Сессия истекла.");
    return;
  }
  await ctx.answerCallbackQuery();

  const lang = data.lang || "ru";
  if (!data.selections)
    data.selections = new Array(data.tasks.length).fill(undefined);
  data.selections[idx] = true;

  const nextIdx = idx + 1;
  if (nextIdx >= data.tasks.length) {
    // All events reviewed — save selected
    await saveSelectedImageTasks(ctx, userId, data, lang);
    return;
  }

  // Show next event
  data.oneByOneIndex = nextIdx;
  const existingTasks = getUserTasks(userId).filter((t) => !t.done);
  const task = data.tasks[nextIdx];
  const conflicts = existingTasks
    .filter(
      (t) =>
        t.time &&
        task.time &&
        Math.abs(
          parseInt(t.time.split(":")[0]) * 60 +
            parseInt(t.time.split(":")[1]) -
            (parseInt(task.time.split(":")[0]) * 60 +
              parseInt(task.time.split(":")[1])),
        ) < (task.duration_minutes || 30),
    )
    .map((t) => `${t.task} (${t.time})`);

  const msg = buildOneByOneMessage(
    task,
    nextIdx,
    data.tasks.length,
    lang,
    conflicts,
  );
  const kb = buildOneByOneKeyboard(userId, nextIdx, lang);
  await ctx.editMessageText(msg, { reply_markup: kb });
});

bot.callbackQuery(/^img_evt_skip_(\d+)_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1], 10);
  const idx = parseInt(ctx.match[2], 10);
  const data = pendingImageTasks.get(userId);
  if (!data) {
    await ctx.answerCallbackQuery("Сессия истекла.");
    return;
  }
  await ctx.answerCallbackQuery();

  const lang = data.lang || "ru";
  if (!data.selections)
    data.selections = new Array(data.tasks.length).fill(undefined);
  data.selections[idx] = false;

  const nextIdx = idx + 1;
  if (nextIdx >= data.tasks.length) {
    await saveSelectedImageTasks(ctx, userId, data, lang);
    return;
  }

  data.oneByOneIndex = nextIdx;
  const existingTasks = getUserTasks(userId).filter((t) => !t.done);
  const task = data.tasks[nextIdx];
  const conflicts = existingTasks
    .filter(
      (t) =>
        t.time &&
        task.time &&
        Math.abs(
          parseInt(t.time.split(":")[0]) * 60 +
            parseInt(t.time.split(":")[1]) -
            (parseInt(task.time.split(":")[0]) * 60 +
              parseInt(task.time.split(":")[1])),
        ) < (task.duration_minutes || 30),
    )
    .map((t) => `${t.task} (${t.time})`);

  const msg = buildOneByOneMessage(
    task,
    nextIdx,
    data.tasks.length,
    lang,
    conflicts,
  );
  const kb = buildOneByOneKeyboard(userId, nextIdx, lang);
  await ctx.editMessageText(msg, { reply_markup: kb });
});

bot.callbackQuery(/^img_evt_done_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1], 10);
  const data = pendingImageTasks.get(userId);
  if (!data) {
    await ctx.answerCallbackQuery("Сессия истекла.");
    return;
  }
  await ctx.answerCallbackQuery();
  const lang = data.lang || "ru";
  await saveSelectedImageTasks(ctx, userId, data, lang);
});

async function saveSelectedImageTasks(
  ctx: any,
  userId: number,
  data: any,
  lang: string,
) {
  // Determine which tasks to save: selected ones (true) or all if none explicitly chosen
  const tasksToSave = data.selections
    ? data.tasks.filter((_: any, i: number) => data.selections[i] !== false)
    : data.tasks;

  if (tasksToSave.length === 0) {
    pendingImageTasks.delete(userId);
    const msg =
      lang === "ru"
        ? "Ничего не добавлено."
        : lang === "kk"
          ? "Ештеңе қосылмады."
          : "Nothing added.";
    try {
      await ctx.editMessageText(msg);
    } catch {
      await ctx.reply(msg);
    }
    return;
  }

  const { v4: uuid } = await import("uuid");
  const todos = tasksToSave.map((t: any) => ({
    id: uuid(),
    task: t.task,
    priority: (["high", "medium", "low"].includes(t.priority)
      ? t.priority
      : "medium") as any,
    done: false,
    time: t.time || undefined,
    date: t.date || undefined,
    duration: t.duration_minutes || 30,
    location: undefined,
    source: mapSourceAppToTaskSource(data.source),
  }));

  const analysis = {
    intent: "action" as const,
    title: `From screenshot`,
    summary: `Added ${todos.length} tasks from screenshot.`,
    key_points: [],
    todos,
    tags: ["#screenshot"],
    raw_transcript: "[from image]",
    language: lang as "ru" | "en" | "kk",
    timeframe: "day" as const,
    needs_location_check: false,
  };

  if (ctx.chat) {
    savePlan(ctx.chat.id, userId, analysis, mapSourceAppToTaskSource(data.source));
    const timed = todos.filter((t: any) => t.time);
    if (timed.length > 0) scheduleReminders(ctx.chat.id, userId, todos, lang);
  }

  pendingImageTasks.delete(userId);
  if (ctx.chat) clearAwaitingVoiceFollowup(ctx.chat.id);
  clearAwaitingImageFollowup(userId);

  const addedCount = todos.length;
  const skippedCount = data.tasks.length - tasksToSave.length;
  const taskList = todos
    .map((t: any) => `— ${t.task}${t.time ? " · " + t.time : ""}`)
    .join("\n");

  const savedLabel =
    lang === "ru" ? "СОХРАНЕНО" : lang === "kk" ? "САҚТАЛДЫ" : "SAVED";
  const addedLabel =
    lang === "ru"
      ? `${addedCount} задач добавлено`
      : lang === "kk"
        ? `${addedCount} тапсырма қосылды`
        : `${addedCount} task${addedCount === 1 ? "" : "s"} added`;
  const skippedLabel =
    skippedCount > 0
      ? lang === "ru"
        ? `, ${skippedCount} пропущено`
        : lang === "kk"
          ? `, ${skippedCount} өткізілді`
          : `, ${skippedCount} skipped`
      : "";

  const msg = `${savedLabel}\n\n${taskList}\n\n${addedLabel}${skippedLabel}.`;
  try {
    await ctx.editMessageText(msg);
  } catch {
    await ctx.reply(msg);
  }
}

// ─── Message handlers ─────────────────────────────────────────────────────────

bot.on("message:voice", async (ctx) => {
  const userId = ctx.from?.id ?? 0;
  await ctx.reply("Processing");
  await voiceQueue.add(async () => {
    const start = Date.now();
    try {
      await handleVoice(ctx);
    } catch (err) {
      logger.error(
        { userId, err: err instanceof Error ? err.message : String(err) },
        "Voice processing failed",
      );
      try {
        await ctx.reply("Something went wrong processing your voice message.");
      } catch {}
    } finally {
      logger.info(
        { userId, type: "voice", duration: Date.now() - start },
        "Voice processed",
      );
    }
  });
});

bot.on("message:photo", handleImage);

bot.on("message:audio", async (ctx) => {
  const lang = getLang(ctx.from?.id ?? 0);
  await ctx.reply(i18n[lang].audio_note);
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const userId = ctx.from?.id ?? 0;
  const chatId = ctx.chat?.id;

  // Awaiting screenshot follow-up — route text as instruction, never send cached report
  if (chatId && isAwaitingVoiceFollowup(chatId)) {
    const lang = getLang(userId);
    const handled = await routeImageFollowup(ctx, userId, ctx.message.text, lang, chatId);
    if (handled) return;
  }

  const flow = getUserFlowState(userId);

  if (flow && flow.type === "awaiting_reschedule") {
    const text = ctx.message.text.trim();
    const state = getRescheduleState(userId);

    // Custom date input: DD.MM[.YYYY]
    if (flow.customField === "date") {
      const match = text.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
      if (match && state) {
        const day = match[1].padStart(2, "0");
        const month = match[2].padStart(2, "0");
        let year = match[3];
        if (!year) year = String(new Date().getFullYear());
        else if (year.length === 2) year = "20" + year;
        const dateStr = `${year}-${month}-${day}`;
        state.selectedDate = dateStr;

        clearUserFlowState(userId);

        const dateObj = new Date(dateStr + "T12:00:00");
        const dateLabel = dateObj.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const timeMsg = buildRescheduleTimePicker(
          state.taskName,
          dateLabel,
          state.lang,
        );
        const timeKb = getRescheduleTimeKeyboard(state.lang);
        await ctx.reply(timeMsg, { reply_markup: timeKb });
        return;
      }
      const lang = getLang(userId);
      await ctx.reply(
        lang === "ru"
          ? "Неверный формат. Используйте DD.MM (например 15.06)."
          : lang === "kk"
            ? "Қате формат. DD.MM пайдаланыңыз (мысалы 15.06)."
            : "Invalid format. Use DD.MM (e.g. 15.06).",
      );
      return;
    }

    // Custom time input: HH:MM
    if (flow.customField === "time") {
      const match = text.match(/^(\d{1,2}):(\d{2})$/);
      if (match && state) {
        state.selectedTime = `${match[1].padStart(2, "0")}:${match[2]}`;

        clearUserFlowState(userId);

        const confirmMsg = buildRescheduleConfirm(
          state.taskName,
          state.currentDate,
          state.currentTime,
          state.selectedDate || "",
          state.selectedTime,
          state.lang,
        );
        const confirmKb = new InlineKeyboard().text(
          state.lang === "ru"
            ? "Подтвердить"
            : state.lang === "kk"
              ? "Растау"
              : "Confirm",
          "rs_confirm",
        );
        await ctx.reply(confirmMsg, { reply_markup: confirmKb });
        return;
      }
      const lang = getLang(userId);
      await ctx.reply(
        lang === "ru"
          ? "Неверный формат. Используйте HH:MM (например 15:30)."
          : lang === "kk"
            ? "Қате формат. HH:MM пайдаланыңыз (мысалы 15:30)."
            : "Invalid format. Use HH:MM (e.g. 15:30).",
      );
      return;
    }

    // Legacy flow (HH:MM only) — keep for backward compat with old command flows
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    const pending = getPending(flow.pendingId);
    if (match && pending) {
      const hh = match[1].padStart(2, "0");
      const mm = match[2];
      const newTime = `${hh}:${mm}`;

      const conflictIdx = flow.conflictIndex ?? 0;
      const incomingTask =
        pending.conflicts[conflictIdx]?.newTodo ?? pending.conflicts[0].newTodo;
      const todoRef = pending.resolvedTodos.find(
        (t) => t.task === incomingTask.task && t.time === incomingTask.time,
      );
      if (todoRef) todoRef.time = newTime;

      clearUserFlowState(userId);

      if (
        pending.conflicts.length > 0 &&
        conflictIdx < pending.conflicts.length - 1
      ) {
        const nextIndex = conflictIdx + 1;
        pending.conflictIndex = nextIndex;
        const nextConflict = pending.conflicts[nextIndex];
        const conflictMsg = buildConflictMessage(
          [nextConflict],
          pending.analysis.language,
        );
        const keyboard = getSingleConflictKeyboard(
          flow.pendingId,
          nextIndex,
          pending.analysis.language,
        );
        await ctx.reply(conflictMsg, { reply_markup: keyboard });
        return;
      }

      if (ctx.chat) savePlan(ctx.chat.id, userId, pending.analysis, pending.source);
      await startDeliveryFlow(ctx, pending);
      return;
    } else if (!match) {
      const lang = getLang(userId);
      await ctx.reply(
        lang === "ru"
          ? "Неверный формат. Используйте HH:MM (например 15:30)."
          : lang === "kk"
            ? "Қате формат. HH:MM пайдаланыңыз (мысалы 15:30)."
            : "Invalid format. Use HH:MM (e.g. 15:30).",
      );
      return;
    }
  }

  if (flow && flow.type === "awaiting_custom_reminder") {
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
        task.time = `${matchFull[1].padStart(2, "0")}.${matchFull[2].padStart(2, "0")} ${matchFull[3].padStart(2, "0")}:${matchFull[4]}`;
      } else if (matchTime) {
        // e.g. "15:30"
        task.time = `${matchTime[1].padStart(2, "0")}:${matchTime[2]}`;
      }

      // We assume custom time means reminder is AT that time (offset 0)
      if (ctx.chat) {
        scheduleReminders(
          ctx.chat.id,
          userId,
          [task],
          pending.analysis.language,
          0,
        );
      }

      clearUserFlowState(userId);
      pending.reminderIndex++;

      await advanceReminderLoop(ctx, pending);
      return;
    } else {
      const lang = getLang(userId);
      const msg =
        lang === "ru"
          ? "Неверный формат. Используйте HH:MM или DD.MM HH:MM."
          : lang === "kk"
            ? "Қате формат. HH:MM немесе DD.MM HH:MM пайдаланыңыз."
            : "Invalid format. Use HH:MM or DD.MM HH:MM.";
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
  const statusMsgId = (await ctx.reply("Analyzing...")).message_id;
  try {
    const intentResult = await detectIntent(text, userId);
    await routeByIntent(
      intentResult,
      ctx,
      userId,
      text,
      { message_id: statusMsgId },
      lang,
    );
  } catch (err) {
    console.error("[Text] Intent routing failed:", err);
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsgId);
    } catch {}
    await ctx.reply(i18n[lang].voice_only);
  }
});

// ─── Error handling ───────────────────────────────────────────────────────────

bot.catch((err) => {
  logger.error(
    { updateId: err.ctx.update.update_id, err: err.error },
    "Grammy error",
  );
  const userId = err.ctx.from?.id;
  const lang = userId ? getLang(userId) : "en";
  try {
    const msg =
      lang === "ru"
        ? "Произошла ошибка. Попробуйте еще раз."
        : lang === "kk"
          ? "Қате орын алды. Қайталап көріңіз."
          : "An error occurred. Please try again.";
    err.ctx.reply(msg);
  } catch {}
});

// ─── Global error handlers ─────────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason.message : String(reason) },
    "Unhandled rejection",
  );
});

process.on("uncaughtException", (err) => {
  logger.error({ err: err.message, stack: err.stack }, "Uncaught exception");
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down...");
  bot.stop();
  voiceQueue.clear();
  // Force-exit after 5s even if queue jobs hang (not unref'd — must fire)
  const forceTimer = setTimeout(() => {
    logger.warn("Shutdown timeout — forcing exit");
    process.exit(0);
  }, 5000);
  try {
    await voiceQueue.onIdle();
  } catch {}
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Boot ─────────────────────────────────────────────────────────────────────

const TEMP_DIR = path.resolve("temp");
try {
  if (fs.existsSync(TEMP_DIR)) {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.endsWith(".ogg") || f.endsWith(".jpg"))
        fs.unlinkSync(path.join(TEMP_DIR, f));
    }
    logger.info({ cleaned: files.length }, "Temp files cleaned");
  }
} catch (e) {
  logger.error({ err: e }, "Temp cleanup failed");
}

initScheduler(bot);

const userCount = (
  db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }
).c;
const todoCount = (
  db.prepare("SELECT COUNT(*) as c FROM todos").get() as { c: number }
).c;
logger.info({ userCount, todoCount }, "DB stats");

resetStartTime();
const app = createServer(bot);
app.listen(config.port, "0.0.0.0", () => {
  logger.info({ port: config.port }, "Express server started");
});

if (config.webhookDomain && config.telegramSecretToken) {
  const webhookUrl = `${config.webhookDomain}/webhook`;
  bot.api
    .setWebhook(webhookUrl, { secret_token: config.telegramSecretToken })
    .then(() => {
      logger.info({ url: webhookUrl }, "Webhook set");
    })
    .catch((err) => {
      logger.error(
        { err: err.message },
        "Webhook setup failed, falling back to polling",
      );
      startPolling();
    });
} else {
  startPolling();
}

function startPolling() {
  logger.info("[Bot] Starting polling...");
  bot.start({
    onStart: async (info) => {
      logger.info(
        {
          username: info.username,
          model: config.openaiModel,
          github: config.isGitHubModels,
          maxUsers: config.maxUsers,
        },
        "Bot running",
      );
      if (config.allowedUserId) {
        try {
          await bot.api.sendMessage(config.allowedUserId, ".", {
            reply_markup: { remove_keyboard: true },
          });
          await bot.api.sendMessage(config.allowedUserId, "Ready.", {
            reply_markup: { remove_keyboard: true },
          });
        } catch {}
      }
    },
  });
}
