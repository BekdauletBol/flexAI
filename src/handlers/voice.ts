import { Context, InputFile, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { transcribeAudio } from "../services/whisper.js";
import { analyzeTranscript } from "../services/analysis.js";
import { DateTime } from 'luxon';
import { kzLocalToUTC, normalizeTime } from '../utils/timezone.js';

const KZ_ZONE = 'Asia/Almaty';
import {
  scheduleReminders,
  cancelReminderByTaskId,
} from "../services/scheduler.js";
import {
  savePlan,
  getConflicts,
  deleteTaskById,
  findTaskByText,
  deletePlansByDate,
  getUserTasks,
  getAllPlansForLLM,
  getAllPlans,
  getWeeklyPlans,
  archiveCompletedTasks,
  findTasksByName,
  findTaskByName,
  markTaskDone,
  getTasksForPeriod,
  getTasksFiltered,
  updateTaskDateTime,
  getKzToday,
  getKzTomorrow,
  findFreeTimeGaps,
  getFreeTimeAndBreaks,
  prepareReportTasks,
  forceInsertTodo,
  dedupeReportTasks,
} from "../services/planStore.js";
import { getUserConfig, setUserLanguage } from "../services/userConfig.js";
import {
  searchPlace,
  getWeatherForecast,
  getDirections,
  generateLocationAdvice,
} from "../services/location.js";
import {
  savePending,
  setUserFlowState,
  clearUserFlowState,
  getUserState,
  setUserState,
  clearUserState,
  UserState,
  getUserFlowState,
  getRescheduleState,
  clearRescheduleState,
  getAwaitingImageFollowup,
  clearAwaitingImageFollowup,
  isAwaitingVoiceFollowup,
  getAwaitingVoiceFollowup,
  clearAwaitingVoiceFollowup,
  getDayMemory,
  refreshDayMemory,
  setPendingConflict,
  recordAskedDate,
} from "../services/pendingStore.js";
import {
  buildConflictMessage,
  buildCombinedConflictMessage,
  getConflictKeyboard,
  getCombinedConflictKeyboard,
  getSingleConflictKeyboard,
  getNavKeyboard,
  buildFreeTimeMessage,
} from "../services/messages.js";
import { startDeliveryFlow } from "../services/delivery.js";
import {
  detectIntent,
  askQuestion,
  chatReply,
  extractDeleteInfo,
  extractMemoryUpdate,
  quickIntentOverride,
  detectTranscriptLanguage,
  extractRescheduleInfo,
  extractReportInfo,
  parseTargetDateFromText,
} from "../services/intent.js";
import { getUserMemory, updateUserMemory } from "../services/memoryStore.js";
import {
  generateReportPdf,
  generateMultiDateReportPdf,
} from "../services/pdf.js";
import {
  generateDailyReportPdf,
  generateRangeReportPdf,
  generateFullReportPdf,
} from "../services/report.js";
import { TodoItem } from "../types/analysis.js";
import {
  generateFullReport,
  generateWeeklyReport,
} from "../services/reporter.js";
import { pendingImageTasks, ExtractedTask } from "./image.js";
import { callLLM } from "../services/llm-client.js";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { logger } from "../logger.js";

// ─── Compound command helpers ─────────────────────────────
const pendingSecondaryActions = new Map<number, { reminderMinutes?: number }>();

// Pending time update flow: user replied to "В какое время?" with a time
interface PendingTimeUpdate {
  tasks: TodoItem[];
  askedAt: string;
  step: number;
}
const pendingTimeUpdate = new Map<number, PendingTimeUpdate>();

function looksLikeNewPlan(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(напомни|напомнить|напоминание|напоминалка|поставь|поставить|создай|создать|запланируй|запланировать|сделай|сделать|добавь|добавить|нужно|надо|хочу|буду|давай|запиши|записать|хочу сделать|надо сделать|нужно сделать)\b/.test(lower)
    || /\b(remind|reminder|create|add|schedule|plan|set|make|need|want|will)\b/.test(lower)
    || /\b(қалайды|қажет|есімде|еске|ӛткізу|жоспарла|жаз|қос)\b/.test(lower);
}

function extractWordTime(text: string): string | null {
  const map: Record<string, string> = {
    'час': '13:00', 'в час': '13:00',
    'два': '14:00', 'в два': '14:00',
    'три': '15:00', 'в три': '15:00',
    'четыре': '16:00', 'в четыре': '16:00',
    'пять': '17:00', 'в пять': '17:00',
    'шесть': '18:00', 'в шесть': '18:00',
    'семь': '19:00', 'в семь': '19:00',
    'восемь': '08:00', 'в восемь': '08:00',
    'девять': '09:00', 'в девять': '09:00',
    'десять': '10:00', 'в десять': '10:00',
    'одиннадцать': '11:00', 'в одиннадцать': '11:00',
    'двенадцать': '12:00', 'в двенадцать': '12:00',
  };
  const lower = text.toLowerCase().trim();
  // Exact match first
  if (map[lower]) return map[lower];
  // Partial match: "в час" or "в два" etc
  for (const [key, val] of Object.entries(map)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

function extractReminderFromTranscript(text: string): number | null {
  const lower = text.toLowerCase();

  const match =
    text.match(/за (\d+)\s*минут/i) || text.match(/remind.*?(\d+)\s*min/i);
  if (match) return parseInt(match[1], 10);

  if (/за полчаса/i.test(lower)) return 30;
  if (/за час\b|за 1 час/i.test(lower)) return 60;
  if (/за 10\b/.test(text)) return 10;
  if (/за 15\b/.test(text)) return 15;
  if (/за 20\b/.test(text)) return 20;

  const simple = text.match(/за (\d+)/i);
  if (simple) return parseInt(simple[1], 10);

  return null;
}

function getReminderLabel(minutes: number, lang: string): string {
  if (lang === "ru") return `Напомню за ${minutes} мин.`;
  if (lang === "kk") return `${minutes} мин. бұрын еске саламын.`;
  return `I'll remind you ${minutes} min before.`;
}

function parseNaturalTime(input: string): string | null {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const h = parseInt(match[1]);
    const m = parseInt(match[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }

  const timeWords: Record<string, number> = {
    "ноль": 0, "нуль": 0, "zero": 0,
    "один": 1, "одна": 1, "одно": 1, "one": 1,
    "два": 2, "две": 2, "two": 2,
    "три": 3, "three": 3,
    "четыре": 4, "four": 4,
    "пять": 5, "five": 5,
    "шесть": 6, "six": 6,
    "семь": 7, "seven": 7,
    "восемь": 8, "eight": 8,
    "девять": 9, "nine": 9,
    "десять": 10, "ten": 10,
    "одиннадцать": 11, "eleven": 11,
    "двенадцать": 12, "twelve": 12,
    "тринадцать": 13, "thirteen": 13,
    "четырнадцать": 14, "fourteen": 14,
    "пятнадцать": 15, "fifteen": 15,
    "шестнадцать": 16, "sixteen": 16,
    "семнадцать": 17, "seventeen": 17,
    "восемнадцать": 18, "eighteen": 18,
    "девятнадцать": 19, "nineteen": 19,
    "двадцать": 20, "twenty": 20,
    "двадцать один": 21, "twenty one": 21,
    "двадцать два": 22, "twenty two": 22,
    "двадцать три": 23, "twenty three": 23,
    "pm": -1, "am": -2,
  };

  const lower = input.trim().toLowerCase();

  const explicitMatch = lower.match(
    /^(\d{1,2})\s*(час|часа|часов|hour|hours|ч\.)\s*(\d{1,2})?\s*(мин|минут|minutes?|м\.)?$/i
  );
  if (explicitMatch) {
    const h = parseInt(explicitMatch[1]);
    const m = explicitMatch[3] ? parseInt(explicitMatch[3]) : 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }

  const words = lower.split(/\s+/);
  const hourIdx = words.findIndex((w) =>
    ["час", "часа", "часов", "hour", "hours", "ч."].includes(w)
  );
  if (hourIdx > 0) {
    const hourWord = words.slice(0, hourIdx).join(" ");
    const h = timeWords[hourWord];
    if (h !== undefined && h >= 0 && h <= 23) {
      let m = 0;
      const afterHour = words.slice(hourIdx + 1).join(" ");
      const numMatch = afterHour.match(/^(\d{1,2})/);
      if (numMatch) m = parseInt(numMatch[1]);
      else {
        const mWord = words[hourIdx + 1];
        if (mWord && timeWords[mWord] !== undefined && timeWords[mWord] >= 0) {
          m = timeWords[mWord];
        }
      }
      if (m >= 0 && m <= 59) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      }
    }
  }

  const hhmmWords = lower
    .replace(/[^а-яёa-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/);
  if (hhmmWords.length === 2) {
    const h = timeWords[hhmmWords[0]];
    const m = timeWords[hhmmWords[1]];
    if (h !== undefined && m !== undefined && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }

  if (lower.includes("утра") || lower.includes("am")) {
    const numMatch = lower.match(/(\d{1,2})/);
    if (numMatch) {
      const h = parseInt(numMatch[1]);
      if (h >= 0 && h <= 12) {
        return `${String(h).padStart(2, "0")}:00`;
      }
    }
  }
  if (lower.includes("вечера") || lower.includes("pm")) {
    const numMatch = lower.match(/(\d{1,2})/);
    if (numMatch) {
      let h = parseInt(numMatch[1]);
      if (h >= 1 && h <= 12) h += 12;
      if (h >= 0 && h <= 23) {
        return `${String(h).padStart(2, "0")}:00`;
      }
    }
  }

  return null;
}

async function applyPendingReminder(
  userId: number,
  taskId: string | undefined,
  ctx: Context,
  lang: string,
) {
  if (!taskId) return;
  const pending = pendingSecondaryActions.get(userId);
  if (!pending?.reminderMinutes) return;

  try {
    const tasks = getUserTasks(userId);
    const task = tasks.find((t) => t.id === taskId);
    if (task && ctx.chat) {
      scheduleReminders(
        ctx.chat.id,
        userId,
        [{ ...task }],
        lang,
        pending.reminderMinutes,
      );
      await ctx.reply(getReminderLabel(pending.reminderMinutes, lang));
    }
  } catch (e) {
    logger.error("[Compound] Failed to apply reminder: %s", e);
  }
  pendingSecondaryActions.delete(userId);
}

async function detectAndHandleSecondaryAction(
  transcript: string,
  userId: number,
  ctx: Context,
  lang: string,
) {
  // Check for "и добавь / and add" pattern — secondary action
  const splitMatch = transcript.match(
    /\b(и|and)\s+(добавь|запиши|создай|сделай|add|create|make)\s+(.+)/i,
  );
  if (splitMatch) {
    const secondaryText = splitMatch[3];
    const override = quickIntentOverride(secondaryText);
    if (override?.intent === "action") {
      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      } catch {}
      await handlePlanIntent(ctx, userId, secondaryText, null, lang);
    }
  }

  // Check for "и отметь / and mark" — secondary complete
  const completeMatch = transcript.match(
    /\b(и|and)\s+(отметь|заверши|отметить|закончи|mark|complete|finish)\s+(.+)/i,
  );
  if (completeMatch) {
    const secondaryText = completeMatch[3];
    const override = quickIntentOverride(secondaryText);
    if (override?.intent === "complete") {
      try {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      } catch {}
      await handleCompleteIntent(
        ctx,
        userId,
        { intent: "complete", target_task: secondaryText },
        null,
        lang,
      );
    }
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    client
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (e) => {
          fs.unlinkSync(dest);
          reject(e);
        });
      })
      .on("error", (e) => {
        fs.unlinkSync(dest);
        reject(e);
      });
  });
}

function formatViewDate(date: DateTime, lang: string): string {
  const locale = lang === "ru" ? "ru-RU" : lang === "kk" ? "kk-KZ" : "en-US";
  return date.setLocale(locale).toFormat('cccc, d MMMM yyyy');
}

function formatViewPlans(plans: any[], lang: string): string {
  if (plans.length === 0) {
    return lang === "ru"
      ? "Нет планов на этот период."
      : lang === "kk"
        ? "Бұл кезеңге жоспарлар жоқ."
        : "No plans for this period.";
  }
  const lines: string[] = [];
  for (const plan of plans) {
    const date = formatViewDate(DateTime.fromISO(plan.createdAt, { zone: 'utc' }).setZone(KZ_ZONE), lang);
    lines.push("");
    lines.push(date);
    lines.push("");
    for (const t of plan.todos) {
      const pMark =
        t.priority === "high"
          ? "HIGH"
          : t.priority === "medium"
            ? "MED"
            : "LOW";
      const timeStr = t.time ? `${t.time} ` : "";
      const locStr = t.location ? ` [${t.location}]` : "";
      lines.push(`  ${timeStr}${t.task} · ${pMark}${locStr}`);
    }
  }
  return lines.join("\n");
}

async function handleVoiceWithImageContext(
  ctx: Context,
  userId: number,
  transcript: string,
  lang: string,
  imageTasks: ExtractedTask[],
) {
  const existingTasks = getUserTasks(userId).filter((t) => !t.done);

  const imageTasksText = imageTasks
    .map(
      (t) =>
        `- ${t.task}${t.time ? " в " + t.time : ""}${t.date ? " " + t.date : ""}`,
    )
    .join("\n");

  const existingTasksText = existingTasks
    .map(
      (t) =>
        `- ${t.task}${t.time ? " в " + t.time : ""}${t.date ? " " + t.date : ""}`,
    )
    .join("\n");

  const { content: rawContent } = await callLLM([
    {
      role: "system",
      content: `You are a personal secretary bot processing a screenshot + voice command.

SCREENSHOT TASKS (extracted from image):
${imageTasksText}

USER'S EXISTING SCHEDULE:
${existingTasksText || "No existing tasks"}

Analyze the user's voice command about the screenshot tasks.
Current date/time: ${DateTime.now().setZone(KZ_ZONE).toFormat('cccc, MMMM d, yyyy, HH:mm')}

Return ONLY this JSON with NO extra text:
{
  "action": "add_all | add_selected | check_conflicts | merge | custom",
  "tasks_to_add": [list of tasks from screenshot to add, each with task, time, date, priority],
  "conflicts": [{"task1": "name", "task2": "name", "time": "HH:MM", "date": "YYYY-MM-DD"}],
  "message": "brief response in user's language",
  "new_tasks": [any new tasks mentioned in voice, each with task, time{optional}, date{optional}, priority{optional}]
}`,
    },
    { role: "user", content: `Voice command: "${transcript}"` },
  ], {
    max_tokens: 1024,
    response_format: { type: "json_object" },
    temperature: 0.2,
    timeout: 60000,
  });

  const content = rawContent || "{}";
  let result: any;
  try {
    result = JSON.parse(content);
  } catch {
    result = { action: "add_all", message: "Done." };
  }

  switch (result.action) {
    case "add_all": {
      const allTasks = [...imageTasks, ...(result.new_tasks || [])];
      const allTodos: TodoItem[] = allTasks.map((t) => ({
        id: "",
        task: t.task,
        priority: (["high", "medium", "low"].includes(t.priority)
          ? t.priority
          : "medium") as any,
        done: false,
        time: t.time || undefined,
        date: t.date || undefined,
        duration: t.duration_minutes || 30,
      }));
      const analysis = {
        intent: "action" as const,
        title: `From screenshot + voice`,
        summary: `Added ${allTodos.length} tasks from screenshot via voice.`,
        key_points: [],
        todos: allTodos,
        tags: ["#screenshot"],
        raw_transcript: transcript,
        language: lang as "ru" | "en" | "kk",
        timeframe: "day" as const,
        needs_location_check: false,
      };
      if (ctx.chat) {
        savePlan(ctx.chat.id, userId, analysis, 'voice');
        const timed = allTodos.filter((t) => t.time);
        if (timed.length > 0)
          scheduleReminders(ctx.chat.id, userId, allTodos, lang);
      }
      const taskList = allTodos
        .map((t) => `— ${t.task}${t.time ? " · " + t.time : ""}`)
        .join("\n");
      const msg =
        lang === "ru"
          ? `СОХРАНЕНО\n\n${taskList}\n\n${allTodos.length} задач добавлено.`
          : lang === "kk"
            ? `САҚТАЛДЫ\n\n${taskList}\n\n${allTodos.length} тапсырма қосылды.`
            : `SAVED\n\n${taskList}\n\n${allTodos.length} tasks added.`;
      await ctx.reply(msg, { reply_markup: getNavKeyboard(lang) });
      break;
    }

    case "check_conflicts": {
      const conflicts = result.conflicts || [];
      if (conflicts.length > 0) {
        const conflictText = conflicts
          .map(
            (c: any) =>
              `⚠️ ${c.task1} ↔ ${c.task2} (${c.date || ""} ${c.time || ""})`,
          )
          .join("\n");
        const msg =
          lang === "ru"
            ? `КОНФЛИКТЫ\n\n${conflictText}\n\nЧто делаем?`
            : lang === "kk"
              ? `ҚАЙШЫЛЫҚТАР\n\n${conflictText}\n\nНе істейміз?`
              : `CONFLICTS\n\n${conflictText}\n\nWhat now?`;
        await ctx.reply(msg);
      } else {
        const msg =
          lang === "ru"
            ? "Конфликтов нет. Все задачи можно добавить."
            : lang === "kk"
              ? "Қайшылықтар жоқ. Барлық тапсырмаларды қосуға болады."
              : "No conflicts. All tasks can be added.";
        pendingImageTasks.set(userId, {
          tasks: imageTasks,
          source: "",
          mappedSource: 'telegram',
          analysis: {
            source_app: "",
            detected_date: null,
            events: imageTasks,
            free_slots: [],
            busy_slots: [],
            summary: "",
          },
          expiresAt: DateTime.now().toMillis() + 60000,
        });
        const keyboard = new InlineKeyboard().text(
          lang === "ru"
            ? "Добавить всё"
            : lang === "kk"
              ? "Бәрін қосу"
              : "Add all",
          `img_add_all_${userId}`,
        );
        await ctx.reply(msg, { reply_markup: keyboard });
      }
      break;
    }

    case "merge": {
      const allTasks = [...imageTasks, ...(result.new_tasks || [])];
      const allTodos: TodoItem[] = allTasks.map((t) => ({
        id: "",
        task: t.task,
        priority: (["high", "medium", "low"].includes(t.priority)
          ? t.priority
          : "medium") as any,
        done: false,
        time: t.time || undefined,
        date: t.date || undefined,
        duration: t.duration_minutes || 30,
      }));
      const analysis = {
        intent: "action" as const,
        title: `Merged screenshot + voice`,
        summary: `Merged ${allTodos.length} tasks.`,
        key_points: [],
        todos: allTodos,
        tags: ["#screenshot"],
        raw_transcript: transcript,
        language: lang as "ru" | "en" | "kk",
        timeframe: "day" as const,
        needs_location_check: false,
      };
      if (ctx.chat) {
        savePlan(ctx.chat.id, userId, analysis, 'voice');
        const timed = allTodos.filter((t) => t.time);
        if (timed.length > 0)
          scheduleReminders(ctx.chat.id, userId, allTodos, lang);
      }
      const taskList = allTodos.map((t: any) => `— ${t.task}`).join("\n");
      const msg =
        lang === "ru"
          ? `ОБЪЕДИНЕНО\n\n${taskList}\n\n${allTodos.length} задач сохранено.`
          : lang === "kk"
            ? `БІРІКТІРІЛДІ\n\n${taskList}\n\n${allTodos.length} тапсырма сақталды.`
            : `MERGED\n\n${taskList}\n\n${allTodos.length} tasks saved.`;
      await ctx.reply(msg, { reply_markup: getNavKeyboard(lang) });
      break;
    }

    default:
      await ctx.reply(result.message || "Done.", {
        reply_markup: getNavKeyboard(lang),
      });
  }
}

export async function routeImageFollowup(
  ctx: Context,
  userId: number,
  instruction: string,
  lang: string,
  chatId: number,
) {
  const awaiting = getAwaitingVoiceFollowup(chatId);
  const pendingImage = pendingImageTasks.get(userId);
  const imageTasks: ExtractedTask[] =
    awaiting?.imageData?.tasks ||
    pendingImage?.tasks ||
    [];

  if (imageTasks.length === 0) {
    clearAwaitingVoiceFollowup(chatId);
    clearAwaitingImageFollowup(userId);
    pendingImageTasks.delete(userId);
    return false;
  }

  await handleVoiceWithImageContext(ctx, userId, instruction, lang, imageTasks);
  pendingImageTasks.delete(userId);
  clearAwaitingVoiceFollowup(chatId);
  clearAwaitingImageFollowup(userId);
  return true;
}

export async function handleVoice(ctx: Context) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || "?";
  if (!ctx.message?.voice) return;
  if (!userId) return;
  if (config.allowedUserId && userId !== config.allowedUserId) {
    await ctx.reply("Access denied.");
    return;
  }

  const statusMsg = await ctx.reply("Transcribing...");
  let tempFile = "",
    transcript = "";

  try {
    // 1. Download voice message
    const f = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`;
    const tmpDir = path.resolve(process.cwd(), "temp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFile = path.join(tmpDir, `v_${DateTime.now().toMillis()}.ogg`);
    await downloadFile(url, tempFile);

    // 2. Transcribe
    transcript = await transcribeAudio(tempFile);
    if (!transcript?.trim()) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "Could not recognize speech.",
      );
      return;
    }
    const configuredLang = getUserConfig(userId).language;
    const detectedLang = detectTranscriptLanguage(transcript);
    // Priority: explicit /language choice, then dominant spoken language, then English
    const lang = configuredLang || detectedLang || "en";
    logger.debug({
      configured: configuredLang,
      detected: detectedLang,
      used: lang,
    }, "[Voice] Language:");

    // Clean up expired pending image data
    for (const [uid, data] of pendingImageTasks) {
      if (data.expiresAt < DateTime.now().toMillis()) pendingImageTasks.delete(uid);
    }

    const chatId = ctx.chat?.id;

    // Awaiting voice follow-up after screenshot — must run before intent/report routing
    if (chatId && isAwaitingVoiceFollowup(chatId)) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      const handled = await routeImageFollowup(ctx, userId, transcript, lang, chatId);
      if (handled) return;
    }

    // Legacy fallback: pending image map without chat awaiting flag
    const pendingImage = pendingImageTasks.get(userId);
    if (pendingImage) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      await handleVoiceWithImageContext(
        ctx,
        userId,
        transcript,
        lang,
        pendingImage.tasks,
      );
      pendingImageTasks.delete(userId);
      if (chatId) clearAwaitingVoiceFollowup(chatId);
      clearAwaitingImageFollowup(userId);
      return;
    }

    const awaitingImage = getAwaitingImageFollowup(userId);
    if (awaitingImage) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      if (chatId) {
        const handled = await routeImageFollowup(
          ctx,
          userId,
          transcript,
          lang,
          chatId,
        );
        if (handled) return;
      }
      await handleVoiceWithImageContext(
        ctx,
        userId,
        transcript,
        lang,
        awaitingImage.imageData.tasks,
      );
      pendingImageTasks.delete(userId);
      if (chatId) clearAwaitingVoiceFollowup(chatId);
      clearAwaitingImageFollowup(userId);
      return;
    }

    const state = getUserState(userId);
    if (state?.flow) {
      await continueFlow(ctx, userId, state, transcript, statusMsg, lang);
      return;
    }

    // If message looks like a new plan, clear stale flow/reschedule states
    if (looksLikeNewPlan(transcript)) {
      clearUserFlowState(userId);
      clearRescheduleState(userId);
    }

    const flowState = getUserFlowState(userId);
    if (flowState) {
      // Handle reminder conflict confirmation
      if (flowState.type === 'awaiting_reminder_conflict_confirm') {
        try {
          await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
        } catch {}

        const lower = transcript.toLowerCase().trim();
        const isConfirm = /^(да|yes|yep|y|ag|иә|дә)$/i.test(lower) || lower.includes('поставь') || lower.includes('ставь');
        const isReject = /^(нет|no|nope|n|жоқ|отмена|отмени)$/i.test(lower);

        if (!isConfirm && !isReject) {
          await ctx.reply(
            lang === "ru"
              ? "Ответьте «да» или «нет»."
              : lang === "kk"
                ? "«иә» немесе «жоқ» деп жауап беріңіз."
                : "Please reply 'yes' or 'no'.",
          );
          return;
        }

        if (isReject) {
          clearUserFlowState(userId);
          await ctx.reply(
            lang === "ru"
              ? "Ок, напоминание отменено."
              : lang === "kk"
                ? "Ок, еске салу болдырылмады."
                : "Ok, reminder cancelled.",
          );
          return;
        }

        // User confirmed — save the reminder
        clearUserFlowState(userId);
        const { taskName, reminderMinutes, scheduledAtUtc } = flowState;
        const { insertReminder } = await import("../services/db.js");
        const taskId = insertReminder(userId, ctx.chat!.id, taskName, scheduledAtUtc);

        // Schedule push notification
        const { reminders } = await import("../services/scheduler.js");
        const { DateTime } = await import("luxon");
        const triggerDt = DateTime.fromISO(scheduledAtUtc, { zone: 'utc' }).setZone('Asia/Almaty');
        reminders.push({
          chatId: ctx.chat!.id,
          taskId,
          task: taskName,
          timeStr: triggerDt.toFormat('HH:mm'),
          triggerAt: triggerDt.toMillis(),
          notified: false,
          language: lang,
          offsetMinutes: 0,
        });

        const formattedTime = triggerDt.toFormat('HH:mm');
        logger.debug(`[Reminder] Saved (confirmed): userId=${userId}, task="${taskName}", at=${scheduledAtUtc}`);

        await ctx.reply(
          lang === "ru"
            ? `✅ Напомню о «${taskName}» через ${reminderMinutes} мин — в ${formattedTime}`
            : lang === "kk"
              ? `✅ «${taskName}» туралы ${reminderMinutes} мин кейін еске саламын — ${formattedTime}-де`
              : `✅ I'll remind you about «${taskName}» in ${reminderMinutes} min — at ${formattedTime}`,
        );
        return;
      }

      // Generic flow state handling (existing logic)
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      await ctx.reply(
        lang === "ru"
          ? "Пожалуйста, используйте кнопки для выбора даты и времени."
          : lang === "kk"
            ? "Күн мен уақытты таңдау үшін батырмаларды пайдаланыңыз."
            : "Please use the buttons to select date and time.",
      );
      return;
    }

    const rescheduleState = getRescheduleState(userId);
    if (rescheduleState) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      await ctx.reply(
        lang === "ru"
          ? "Пожалуйста, используйте кнопки для выбора даты и времени."
          : lang === "kk"
            ? "Күн мен уақытты таңдау үшін батырмаларды пайдаланыңыз."
            : "Please use the buttons to select date and time.",
      );
      return;
    }

    // 3. Intent detection
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "Analyzing...",
      );
    } catch {}

    // ── Process through shared pipeline ──
    const result = await processTextInput(transcript, ctx, userId, lang, statusMsg);
    if (result === 'pending_time_handled') return;

    logger.debug(`[Voice] Done: from @${username}`);
  } catch (error) {
    logger.error("[Voice] Error: %s", error);
    const msg = error instanceof Error ? error.message : "";
    try {
      if (msg.includes("Failed to transcribe") || msg.includes("rate limit") || msg.includes("429")) {
        if (msg.includes("rate limit") || msg.includes("429")) {
          const { handleRateLimit } = await import('../services/rateLimitStore.js');
          const userName = ctx.from?.first_name || ctx.from?.username || String(userId);
          const limitMsg = handleRateLimit(error, ctx.chat!.id, userId, 'whisper', userName);
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, limitMsg);
        } else {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            "Could not recognize speech.",
          );
        }
      } else if (msg.startsWith("TRANSCRIPT_FALLBACK:")) {
        const t = msg.substring("TRANSCRIPT_FALLBACK:".length);
        const text = t.length > 3900 ? t.substring(0, 3900) + "..." : t;
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          `Analysis failed. Transcript:\n\n${text}`,
        );
      } else if (msg.includes("rate limit") || msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("limit")) {
        const { handleRateLimit } = await import('../services/rateLimitStore.js');
        const userName = ctx.from?.first_name || ctx.from?.username || String(userId);
        const limitMsg = handleRateLimit(error, ctx.chat!.id, userId, 'analysis', userName);
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, limitMsg);
      } else {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          "Something went wrong.",
        );
      }
    } catch {}
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {}
    }
  }
}

// ─── Intent Handlers ──────────────────────────────────────────────────────────

export async function handlePlanIntent(
  ctx: Context,
  userId: number,
  transcript: string,
  statusMsg: any,
  defaultLang: string,
) {
  try {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      "Processing...",
    );
  } catch {}

  let analysis;
  try {
    analysis = await analyzeTranscript(transcript, userId);
  } catch (e) {
    logger.error("[Voice] Analysis failed: %s", e);
    const msg = e instanceof Error ? e.message : "";
    if (msg.startsWith("TRANSCRIPT_FALLBACK:")) {
      const t = msg.substring("TRANSCRIPT_FALLBACK:".length);
      const text = t.length > 3900 ? t.substring(0, 3900) + "..." : t;
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `Analysis failed. Transcript:\n\n${text}`,
      );
    } else {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "Analysis failed.",
      );
    }
    return;
  }

  const lang = analysis.language || defaultLang;

  // Before saving any task, check if the task name contains delete keywords
  const deleteKeywords = [
    "убери",
    "удали",
    "отмени",
    "убрать",
    "удалить",
    "remove",
    "delete",
    "cancel",
  ];
  analysis.todos = analysis.todos.filter((todo) => {
    const taskNameLower = todo.task.toLowerCase();
    if (deleteKeywords.some((kw) => taskNameLower.includes(kw))) {
      logger.warn("[Action] Skipping suspicious task that looks like a delete command: %s", todo.task);
      return false;
    }
    return true;
  });

  if (analysis.todos.length === 0) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    return;
  }

  // Location Assistant
  let locationAdvice = "";
  if (analysis.needs_location_check && analysis.location_query) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      "Checking location...",
    );
    const userSettings = getUserConfig(userId);
    const hasCoords =
      userSettings.lat !== undefined && userSettings.lng !== undefined;
    const targetTime = analysis.visit_datetime || DateTime.now().setZone(KZ_ZONE).toUTC().toISO()!;
    try {
      const placePromise = searchPlace(analysis.location_query);
      const weatherPromise = hasCoords
        ? getWeatherForecast(
            userSettings.lat!,
            userSettings.lng!,
            targetTime,
            analysis.language,
          )
        : Promise.resolve(null);
      const directionsPromise = hasCoords
        ? getDirections(
            userSettings.lat!,
            userSettings.lng!,
            analysis.location_query,
          )
        : Promise.resolve(null);
      const [place, weather, directions] = await Promise.all([
        placePromise,
        weatherPromise,
        directionsPromise,
      ]);
      locationAdvice = await generateLocationAdvice(
        analysis.location_query,
        targetTime,
        place,
        weather,
        directions,
        analysis.language,
      );
    } catch (err) {
      logger.error("[Voice] Location assistant error: %s", err);
    }
  }

  // Conflict detection — collect all conflicts (date-aware)
  const targetDate = analysis.todos[0]?.date || getKzToday();
  const conflicts = ctx.from ? getConflicts(userId, analysis.todos, targetDate) : [];

  // Pattern-based conflict detection: compare new tasks against known daily patterns
  const patterns = getUserMemory(userId).patterns;
  const patternWarnings: string[] = [];
  if (Object.keys(patterns).length > 0) {
    for (const todo of analysis.todos) {
      if (!todo.time) continue;
      const newMinutes = parseTimeToMinutes(todo.time);

      for (const [patternName, patternTime] of Object.entries(patterns)) {
        if (!patternTime) continue;

        // Parse pattern time: could be "08:00-10:00" (range) or "22:00" (single)
        const rangeMatch = patternTime.match(/^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/);
        if (rangeMatch) {
          const rangeStart = parseTimeToMinutes(rangeMatch[1]);
          const rangeEnd = parseTimeToMinutes(rangeMatch[2]);
          const todoEnd = newMinutes + (todo.duration || 30);

          if (newMinutes < rangeEnd && todoEnd > rangeStart) {
            const patternLabel = lang === 'ru'
              ? `У тебя обычно ${getPatternLabel(patternName, lang)} в ${patternTime}`
              : lang === 'kk'
                ? `Әдетте ${getPatternLabel(patternName, lang)} ${patternTime} болады`
                : `You usually have ${getPatternLabel(patternName, lang)} at ${patternTime}`;
            patternWarnings.push(`⚠️ ${patternLabel}. Конфликт?`);
          }
        }
      }
    }
  }

  // Show pattern warnings before conflict flow
  if (patternWarnings.length > 0) {
    await ctx.reply(patternWarnings.join('\n\n'));
  }

  // Separate conflicting vs clean tasks
  const conflictedIds = new Set(conflicts.map((c) => c.newTodo.id));
  const cleanTodos = analysis.todos.filter((t) => !conflictedIds.has(t.id));
  const conflictTodos = analysis.todos.filter((t) => conflictedIds.has(t.id));

  // Save non-conflicting tasks immediately (only when there ARE conflicts — otherwise the single save at the end handles it)
  if (conflicts.length > 0 && ctx.chat && cleanTodos.length > 0) {
    const cleanAnalysis = { ...analysis, todos: cleanTodos };
    savePlan(ctx.chat.id, userId, cleanAnalysis, 'voice');
  }

  // Refresh per-day memory with all tasks for this date
  const allTasksForDate = getUserTasks(userId).filter(t => !t.done);
  refreshDayMemory(userId, allTasksForDate, targetDate);
  if (conflicts.length > 0) {
    setPendingConflict(userId, conflicts[0].newTodo);
  }

  recordAskedDate(userId, targetDate);

  const pendingData = {
    userId,
    chatId: ctx.chat!.id,
    analysis,
    conflicts,
    phase: conflicts.length > 0 ? ("conflict" as const) : ("reminder" as const),
    resolvedTodos: analysis.todos,
    reminderIndex: 0,
    conflictIndex: 0,
    source: 'voice' as const,
  };

  const pendingId = savePending(pendingData);

  if (conflicts.length > 0) {
    // Show combined conflict message
    const conflictMsg = buildCombinedConflictMessage(
      conflicts,
      analysis.language,
    );
    const keyboard = getCombinedConflictKeyboard(pendingId, analysis.language);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      conflictMsg,
      { reply_markup: keyboard },
    );
    return;
  }

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}

  if (ctx.chat) {
    savePlan(ctx.chat.id, userId, analysis, 'voice');

    // Prompt for time on untimed tasks
    const untimedTasks = analysis.todos.filter((t: TodoItem) => !t.time);
    console.log('[Plan] Untimed tasks:', untimedTasks.map((t: TodoItem) => t.task));
    if (untimedTasks.length > 0 && analysis.timeframe === 'day') {
      const names = untimedTasks.map((t: TodoItem) => `— ${t.task}`).join('\n');
      const promptMsg = lang === 'ru'
        ? `⚠️ Не указано время для:\n${names}\n\nВ какое время?`
        : lang === 'kk'
          ? `⚠️ Уақыты көрсетілмеген:\n${names}\n\nҚай уақытта?`
          : `⚠️ No time set for:\n${names}\n\nWhat time?`;
      await ctx.reply(promptMsg);

      // Store pending state so follow-up voice/text can set times
      pendingTimeUpdate.set(userId, {
        tasks: untimedTasks,
        askedAt: DateTime.now().toUTC().toISO()!,
        step: 0,
      });
    }

    if (analysis.timeframe === "day") {
      const timedTasks = analysis.todos.filter((t) => t.time);
      if (timedTasks.length > 0) {
        scheduleReminders(
          ctx.chat.id,
          userId,
          analysis.todos,
          analysis.language,
        );
      }
    }
  }

  if (locationAdvice) {
    const locationHeader =
      analysis.language === "ru"
        ? "LOCATION\n\n"
        : analysis.language === "kk"
          ? "LOCATION\n\n"
          : "LOCATION\n\n";
    await ctx.reply(locationHeader + locationAdvice);
  }

  // Long-term plans: simple confirmation, no delivery flow
  if (analysis.timeframe !== "day") {
    const tfLabel =
      analysis.timeframe === "week"
        ? "week"
        : analysis.timeframe === "month"
          ? "month"
          : "year";
    const msg =
      lang === "ru"
        ? `Готово! Сохранил план на ${tfLabel}: "${analysis.title}"`
        : lang === "kk"
          ? `Дайын! ${tfLabel} жоспары сақталды: "${analysis.title}"`
          : `Done! Saved ${tfLabel} plan: "${analysis.title}"`;
    await ctx.reply(msg);
    logger.debug(
      `[Voice] Long-term plan saved: "${analysis.title}" [${analysis.timeframe}]`,
    );
    return;
  }

  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  await startDeliveryFlow(ctx, {
    ...pendingData,
    id: pendingId,
    createdAt: DateTime.now().toMillis(),
  });

  logger.debug(
    `[Voice] Plan processed: "${analysis.title}" [${analysis.language}]`,
  );
}

export async function handleQuestionIntent(
  ctx: Context,
  userId: number,
  transcript: string,
  statusMsg: any,
  lang: string,
) {
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  const plansData = getAllPlansForLLM(userId);
  const memoryData = JSON.stringify(getUserMemory(userId));
  const answer = await askQuestion(transcript, plansData, memoryData, lang);
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}
  await ctx.reply(answer);
}

async function handleRescheduleIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
  transcript?: string,
) {
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");

  let taskQuery = intentResult.target_task;
  let targetTime = intentResult.target_time;
  let targetDate = intentResult.target_date;
  let fromTime = intentResult.from_time;

  // Normalize time: add leading zero if format is "H:MM" → "HH:MM", replace "." with ":"
  if (targetTime) {
    targetTime = targetTime.replace('.', ':');
    const norm = targetTime.match(/^(\d):(\d{2})$/);
    if (norm) targetTime = `0${norm[1]}:${norm[2]}`;
  }
  if (fromTime) {
    fromTime = fromTime.replace('.', ':');
    const norm = fromTime.match(/^(\d):(\d{2})$/);
    if (norm) fromTime = `0${norm[1]}:${norm[2]}`;
  }

  // Validate time format: must be HH:MM with hours 00-23 and minutes 00-59
  if (targetTime) {
    const timeMatch = targetTime.match(/^(\d{2}):(\d{2})$/);
    if (!timeMatch) {
      logger.warn('[Reschedule] Invalid time format from LLM: "%s" — ignoring', targetTime);
      targetTime = null;
    } else {
      const h = parseInt(timeMatch[1]);
      const m = parseInt(timeMatch[2]);
      if (h > 23 || m > 59) {
        logger.warn('[Reschedule] Invalid time value from LLM: "%s" (h=%d, m=%d) — ignoring', targetTime, h, m);
        targetTime = null;
      }
    }
  }

  // Fallback: if LLM intent didn't extract task/time, call extractRescheduleInfo
  if (!taskQuery && transcript) {
    logger.debug(
      "[Reschedule] target_task missing, running extractRescheduleInfo...",
    );
    const extracted = await extractRescheduleInfo(transcript, userId);
    if (extracted) {
      taskQuery = extracted.task || taskQuery;
      targetTime = extracted.newTime || targetTime;
      targetDate = extracted.date || targetDate;
      logger.debug(
        `[Reschedule] Extracted: task="${taskQuery}" time="${targetTime}" date="${targetDate}"`,
      );
    }
  }

  if (!taskQuery) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    // Show all pending tasks so user can pick
    const allTasks = getUserTasks(userId).filter((t) => !t.done && t.time);
    if (allTasks.length > 0) {
      const list = allTasks
        .slice(0, 8)
        .map((t, i) => `${i + 1}. ${t.task} · ${t.time}`)
        .join("\n");
      const hint =
        lang === "ru"
          ? `Какую задачу перенести?\n\n${list}\n\nОтправь голосовое с названием задачи.`
          : lang === "kk"
            ? `Қай тапсырманы жылжытамыз?\n\n${list}\n\nДауыстық хабар жіберіп, тапсырма атын айт.`
            : `Which task to reschedule?\n\n${list}\n\nSend a voice message with the task name.`;
      await ctx.reply(hint);
    } else {
      await ctx.reply(
        lang === "ru"
          ? "Не удалось определить задачу для переноса."
          : lang === "kk"
            ? "Тапсырманы анықтау мүмкін болмады."
            : "Could not identify the task to reschedule.",
      );
    }
    return;
  }

  // No time specified — find task and enter time-picker flow
  if (!targetTime) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    const matches = findTasksByName(userId, taskQuery);
    if (matches.length === 0) {
      await ctx.reply(
        lang === "ru"
          ? "Задача не найдена."
          : lang === "kk"
            ? "Тапсырма табылмады."
            : "Task not found.",
      );
      return;
    }
    if (matches.length > 1) {
      setUserState(userId, {
        flow: "reschedule",
        step: "picker",
        pendingTasks: matches,
      });
      const list = matches
        .map((m, i) => `${i + 1}. ${m.todo.task} · ${m.todo.time || "—"}`)
        .join("\n");
      await ctx.reply(
        lang === "ru"
          ? `Найдено несколько задач:\n\n${list}\n\nВведите номер.`
          : lang === "kk"
            ? `Бірнеше тапсырма табылды:\n\n${list}\n\nНөмірін енгізіңіз.`
            : `Found multiple tasks:\n\n${list}\n\nEnter the number.`,
      );
      return;
    }
    const found = matches[0];
    setUserState(userId, {
      flow: "reschedule",
      step: "time",
      pendingTaskId: found.todo.id,
    });
    await ctx.reply(
      lang === "ru"
        ? `Найдено: "${found.todo.task}". Укажите новое время (HH:MM).`
        : lang === "kk"
          ? `Табылды: "${found.todo.task}". Жаңа уақытты енгізіңіз (HH:MM).`
          : `Found: "${found.todo.task}". Enter new time (HH:MM).`,
    );
    return;
  }

  // Both task and time specified — reschedule directly
  let found = findTaskByText(userId, taskQuery, targetDate);

  // Fallback: if task not found by name and from_time is available, search by time
  if (!found && fromTime) {
    logger.info('[Reschedule] Name search failed, trying fallback by from_time="%s"', fromTime);
    const dateFilter = targetDate || undefined;
    const candidates = getUserTasks(userId).filter((t) =>
      !t.done && t.time === fromTime && (!dateFilter || t.date === dateFilter)
    );
    if (candidates.length === 1) {
      found = { plan: { id: 0 } as any, todo: candidates[0] };
      logger.info('[Reschedule] Fallback by time matched: "%s"', candidates[0].task);
    } else if (candidates.length > 1) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      const list = candidates.map((t, i) => `${i + 1}. ${t.task} · ${t.time}`).join('\n');
      await ctx.reply(
        lang === 'ru'
          ? `Найдено несколько задач на ${fromTime}:\n\n${list}\n\nВведите номер.`
          : `Found multiple tasks at ${fromTime}:\n\n${list}\n\nEnter the number.`
      );
      return;
    }
  }

  if (!found) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    const allTasks = getUserTasks(userId).filter((t) => !t.done);
    const suggestions = allTasks
      .slice(0, 5)
      .map((t) => `"${t.task}"`)
      .join(", ");
    await ctx.reply(
      lang === "ru"
        ? `Задача не найдена. Возможно, вы имели в виду: ${suggestions}`
        : lang === "kk"
          ? `Тапсырма табылмады. Мүмкін: ${suggestions}`
          : `Task not found. Did you mean: ${suggestions}`,
    );
    return;
  }

  if (found.todo.id) {
    const newDate = targetDate || found.todo.date || "";
    updateTaskDateTime(userId, found.todo.id, newDate, targetTime);
    cancelReminderByTaskId(found.todo.id);

    // Update linked DB reminders (parent_task_id)
    const { updateLinkedReminders } = await import("../services/db.js");
    const newScheduledAt = kzLocalToUTC(newDate, targetTime);
    updateLinkedReminders(found.todo.id, newScheduledAt);

    // Re-fetch task from DB to get updated time for the in-memory reminder
    const refreshedTasks = getUserTasks(userId);
    const refreshedTask = refreshedTasks.find((t) => t.id === found.todo.id);
    if (ctx.chat && refreshedTask) {
      scheduleReminders(ctx.chat.id, userId, [refreshedTask], lang);
    }
    await applyPendingReminder(userId, found.todo.id, ctx, lang);
  }

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}

  const offset = getUserConfig(userId).reminder_offset_minutes || 30;
  const triggerTime = getTriggerTimeStr(targetTime, offset);
  await ctx.reply(
    lang === "ru"
      ? `Перенесено "${found.todo.task}" на ${targetTime}. Напомню в ${triggerTime}`
      : lang === "kk"
        ? `"${found.todo.task}" ${targetTime} ауыстырылды. ${triggerTime} еске саламын`
        : `Moved "${found.todo.task}" to ${targetTime}. I'll remind you at ${triggerTime}`,
  );
}

async function handleDeleteIntent(
  ctx: Context,
  userId: number,
  transcript: string,
  statusMsg: any,
  lang: string,
) {
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  const info = await extractDeleteInfo(transcript, userId);
  if (!info) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    await ctx.reply(
      lang === "ru"
        ? "Не удалось понять, что удалить."
        : lang === "kk"
          ? "Нені өшіру керектігін түсінбедім."
          : "Could not understand what to delete.",
    );
    return;
  }

  if (info.type === "day") {
    const dateStr = info.date || DateTime.now().setZone(KZ_ZONE).toFormat('yyyy-MM-dd');
    const formattedDate = formatViewDate(DateTime.fromISO(dateStr, { zone: KZ_ZONE }), lang);
    const count = deletePlansByDate(userId, dateStr);
    if (count > 0) {
      // Cancel all reminders for tasks on that date
      const allTasks = getUserTasks(userId);
      for (const t of allTasks) {
        if (t.id) cancelReminderByTaskId(t.id);
      }
    }
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    await ctx.reply(
      lang === "ru"
        ? `Deleted plan for ${formattedDate}`
        : lang === "kk"
          ? `${formattedDate} жоспары жойылды`
          : `Deleted plan for ${formattedDate}`,
    );
  } else if (info.type === "task" && info.task) {
    const found = findTaskByText(userId, info.task);
    if (found && found.todo.id) {
      const removed = deleteTaskById(userId, found.todo.id);
      cancelReminderByTaskId(found.todo.id);
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      const taskTime = removed?.time ? ` at ${removed.time}` : "";
      await ctx.reply(
        lang === "ru"
          ? `Removed: ${found.todo.task}${taskTime}`
          : lang === "kk"
            ? `Жойылды: ${found.todo.task}${taskTime}`
            : `Removed: ${found.todo.task}${taskTime}`,
      );
    } else {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      await ctx.reply(
        lang === "ru"
          ? "Задача не найдена."
          : lang === "kk"
            ? "Тапсырма табылмады."
            : "Task not found.",
      );
    }
  }
}

async function handleCompleteIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
) {
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  const targetTask = intentResult.target_task;
  if (!targetTask) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    await ctx.reply(
      lang === "ru"
        ? "Не удалось определить задачу."
        : lang === "kk"
          ? "Тапсырманы анықтау мүмкін болмады."
          : "Could not identify the task.",
    );
    return;
  }

  const matches = findTasksByName(userId, targetTask);

  if (matches.length === 0) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    await ctx.reply(
      lang === "ru"
        ? "Задача не найдена."
        : lang === "kk"
          ? "Тапсырма табылмады."
          : "Task not found.",
    );
    return;
  }

  if (matches.length > 1) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    const list = matches
      .map((m, i) => `${i + 1}. ${m.todo.task} · ${m.todo.time || "—"}`)
      .join("\n");
    await ctx.reply(
      lang === "ru"
        ? `Найдено несколько:\n\n${list}\n\nВведите номер.`
        : lang === "kk"
          ? `Бірнеше табылды:\n\n${list}\n\nНөмірін енгізіңіз.`
          : `Found multiple:\n\n${list}\n\nReply with the number.`,
    );
    return;
  }

  const found = matches[0];
  if (found.todo.id) {
    markTaskDone(userId, found.todo.id);
    await applyPendingReminder(userId, found.todo.id, ctx, lang);
  }

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}
  await ctx.reply(
    lang === "ru"
      ? `DONE\n— ${found.todo.task}`
      : lang === "kk"
        ? `ОРЫНДАЛДЫ\n— ${found.todo.task}`
        : `DONE\n— ${found.todo.task}`,
  );
}

async function handleSummaryIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
) {
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  const period = intentResult.period || "today";
  const tasks = getTasksForPeriod(userId, period);
  const done = tasks.filter((t) => t.done).length;
  const pending = tasks.filter((t) => !t.done).length;

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}

  const periodLabel =
    period === "today"
      ? lang === "ru"
        ? "СЕГОДНЯ"
        : lang === "kk"
          ? "БҮГІН"
          : "TODAY"
      : period === "tomorrow"
        ? lang === "ru"
          ? "ЗАВТРА"
          : lang === "kk"
            ? "ЕРТЕҢ"
            : "TOMORROW"
        : period === "week"
          ? lang === "ru"
            ? "НЕДЕЛЯ"
            : lang === "kk"
              ? "АПТА"
              : "WEEK"
          : lang === "ru"
            ? "ВСЕ"
            : lang === "kk"
              ? "БАРЛЫҒЫ"
              : "ALL";

  await ctx.reply(
    `SUMMARY — ${periodLabel}\n\n` +
      `— Pending: ${pending}\n` +
      `— Done: ${done}\n` +
      `— Total: ${tasks.length}`,
  );
}

async function handleChatIntent(
  ctx: Context,
  userId: number,
  transcript: string,
  statusMsg: any,
  lang: string,
) {
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  const memoryData = JSON.stringify(getUserMemory(userId));
  const answer = await chatReply(transcript, memoryData, lang);
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}
  await ctx.reply(answer);
}

export async function continueFlow(
  ctx: Context,
  userId: number,
  state: UserState,
  input: string,
  statusMsg: any,
  lang: string,
) {
  if (statusMsg?.message_id && statusMsg.message_id > 0) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
  }

  if (state.flow === "reschedule") {
    if (state.step === "picker") {
      const tasks = state.pendingTasks;
      let selected = null;

      const idx = parseInt(input.trim()) - 1;
      if (!isNaN(idx) && tasks && idx >= 0 && idx < tasks.length) {
        selected = tasks[idx];
      } else if (tasks && tasks.length > 0) {
        const lower = input.trim().toLowerCase();
        selected = tasks.find((t: any) =>
          t.todo.task.toLowerCase().includes(lower) ||
          lower.includes(t.todo.task.toLowerCase())
        );
        if (!selected && tasks.length === 1) {
          selected = tasks[0];
        }
      }

      if (!selected) {
        const list = tasks
          ?.map((t: any, i: number) => `${i + 1}. ${t.todo.task}`)
          .join("\n") || "";
        await ctx.reply(
          lang === "ru"
            ? `Не удалось распознать задачу. Попробуйте снова.\n\n${list}`
            : lang === "kk"
              ? `Тапсырма танылмады. Қайталап көріңіз.\n\n${list}`
              : `Could not identify the task. Try again.\n\n${list}`,
        );
        return;
      }

      setUserState(userId, {
        flow: "reschedule",
        step: "time",
        pendingTaskId: selected.todo.id,
      });
      await ctx.reply(
        lang === "ru"
          ? `Выбрано: "${selected.todo.task}". Укажите новое время (HH:MM).`
          : lang === "kk"
            ? `Таңдалды: "${selected.todo.task}". Жаңа уақытты енгізіңіз (HH:MM).`
            : `Selected: "${selected.todo.task}". Enter new time (HH:MM).`,
      );
      return;
    }

    if (state.step === "time") {
      let newTime = parseNaturalTime(input);
      if (!newTime) {
        const extracted = await extractRescheduleInfo(input, userId);
        if (extracted?.newTime) {
          newTime = extracted.newTime;
        }
      }
      if (!newTime) {
        await ctx.reply(
          lang === "ru"
            ? "Неверный формат. Используйте HH:MM (например 15:30) или скажите словами."
            : lang === "kk"
              ? "Қате формат. HH:MM пайдаланыңыз (мысалы 15:30) немесе сөзбен айтыңыз."
              : "Invalid format. Use HH:MM (e.g. 15:30) or say it in words.",
        );
        return;
      }
      const taskId = state.pendingTaskId;
      if (taskId) {
        // Get task from DB to find its current date
        const allTasks = getUserTasks(userId);
        const taskObj = allTasks.find((t) => t.id === taskId);
        const taskDate = taskObj?.date || "";
        updateTaskDateTime(userId, taskId, taskDate, newTime);
        cancelReminderByTaskId(taskId);
        // Update linked DB reminders
        const { updateLinkedReminders } = await import("../services/db.js");
        const newScheduledAt = kzLocalToUTC(taskDate, newTime);
        updateLinkedReminders(taskId, newScheduledAt);
        // Re-fetch task from DB to get updated time for the in-memory reminder
        const refreshedTasks = getUserTasks(userId);
        const refreshedTask = refreshedTasks.find((t) => t.id === taskId);
        if (ctx.chat && refreshedTask) {
          scheduleReminders(ctx.chat.id, userId, [refreshedTask], lang);
        }
        await applyPendingReminder(userId, taskId, ctx, lang);
      }
      clearUserState(userId);
      await ctx.reply(
        lang === "ru"
          ? `Время обновлено на ${newTime}.`
          : lang === "kk"
            ? `Уақыт ${newTime} өзгертілді.`
            : `Time updated to ${newTime}.`,
      );
      return;
    }
  }

  if (state.flow === "delete") {
    if (state.step === "picker") {
      const idx = parseInt(input.trim()) - 1;
      const tasks = state.pendingTasks;
      if (isNaN(idx) || !tasks || idx < 0 || idx >= tasks.length) {
        await ctx.reply(
          lang === "ru"
            ? "Неверный номер. Попробуйте снова."
            : lang === "kk"
              ? "Қате нөмір. Қайталап көріңіз."
              : "Invalid number. Try again.",
        );
        return;
      }
      const selected = tasks[idx];
      if (selected.todo.id) {
        deleteTaskById(userId, selected.todo.id);
        cancelReminderByTaskId(selected.todo.id);
      }
      clearUserState(userId);
      await ctx.reply(
        lang === "ru"
          ? `Удалено: "${selected.todo.task}"`
          : lang === "kk"
            ? `Жойылды: "${selected.todo.task}"`
            : `Deleted: "${selected.todo.task}"`,
      );
      return;
    }
  }
}

async function handleReminderIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
  transcript?: string,
) {
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}

  const reminderMinutes = intentResult.reminder_minutes;
  const targetTask = intentResult.target_task;

  if (!reminderMinutes || reminderMinutes <= 0) {
    await ctx.reply(
      lang === "ru"
        ? "Укажите, через сколько минут напомнить. Например: «Напомни через 15 минут»"
        : lang === "kk"
          ? "Неше минуттан кейін еске салуды көрсетіңіз. Мысалы: «15 минуттан кейін еске сал»"
          : "Specify how many minutes from now. E.g.: 'Remind me in 15 minutes'",
    );
    return;
  }

  if (!targetTask) {
    await ctx.reply(
      lang === "ru"
        ? "О чём напомнить? Укажите тему."
        : lang === "kk"
          ? "Не туралы еске салу керек? Тақырыпты көрсетіңіз."
          : "What should I remind you about? Please specify the topic.",
    );
    return;
  }

  // Calculate scheduled time: NOW + reminderMinutes (free-standing reminder, no task time)
  const { nowKZ } = await import("../utils/timezone.js");
  const kzNow = nowKZ();
  const scheduledAtKZ = kzNow.plus({ minutes: reminderMinutes });
  const scheduledAtUtc = scheduledAtKZ.toUTC().toISO()!;

  // Daily reminder limit: max 10 per day
  const { getTodayReminderCount } = await import("../services/db.js");
  const todayCount = getTodayReminderCount(userId);
  if (todayCount >= 10) {
    await ctx.reply(
      lang === "ru"
        ? "На сегодня уже 10 напоминаний. Удали старые через /reminders"
        : lang === "kk"
          ? "Бүгінге 10 еске салу бар. Ескілерін /reminders арқылы өшіріңіз"
          : "You already have 10 reminders for today. Delete old ones via /reminders",
    );
    return;
  }

  // Check for conflicts: non-reminder tasks within ±15 min of the scheduled time
  const { checkReminderConflicts, insertReminder } = await import("../services/db.js");
  const conflicts = checkReminderConflicts(userId, scheduledAtUtc, 15);

  if (conflicts.length > 0) {
    // Store pending reminder for confirmation
    const { setUserFlowState } = await import("../services/pendingStore.js");
    setUserFlowState(userId, {
      type: 'awaiting_reminder_conflict_confirm',
      userId,
      taskName: targetTask,
      reminderMinutes,
      scheduledAtUtc,
      conflicts,
    });

    const conflictTask = conflicts[0];
    const conflictTime = conflictTask.scheduled_time_kz || conflictTask.time || '??:??';
    const conflictTimeShort = String(conflictTime).slice(11, 16) || conflictTime;

    await ctx.reply(
      lang === "ru"
        ? `⚠️ Конфликт: в ${conflictTimeShort} у тебя уже «${conflictTask.task}».\n\nПоставить напоминание «${targetTask}» через ${reminderMinutes} мин всё равно? (да / нет)`
        : lang === "kk"
          ? `⚠️ Қақтығыс: ${conflictTimeShort}-де сенде «${conflictTask.task}» бар.\n\n«${targetTask}» еске салуын ${reminderMinutes} мин кейін қою керек пе? (иә / жоқ)`
          : `⚠️ Conflict: at ${conflictTimeShort} you already have «${conflictTask.task}».\n\nSet reminder «${targetTask}» in ${reminderMinutes} min anyway? (yes / no)`,
    );
    return;
  }

  // No conflicts — save directly
  const taskId = insertReminder(userId, ctx.chat!.id, targetTask, scheduledAtUtc);

  // Schedule push notification
  const { reminders } = await import("../services/scheduler.js");
  reminders.push({
    chatId: ctx.chat!.id,
    taskId,
    task: targetTask,
    timeStr: scheduledAtKZ.toFormat('HH:mm'),
    triggerAt: scheduledAtKZ.toMillis(),
    notified: false,
    language: lang,
    offsetMinutes: 0,
  });

  const formattedTime = scheduledAtKZ.toFormat('HH:mm');
  logger.debug({ userId, task: targetTask, at: scheduledAtUtc }, '[Reminder] Saved');

  await ctx.reply(
    lang === "ru"
      ? `✅ Напомню о «${targetTask}» через ${reminderMinutes} мин — в ${formattedTime}`
      : lang === "kk"
        ? `✅ «${targetTask}» туралы ${reminderMinutes} мин кейін еске саламын — ${formattedTime}-де`
        : `✅ I'll remind you about «${targetTask}» in ${reminderMinutes} min — at ${formattedTime}`,
  );
}

async function handleListRemindersIntent(
  ctx: Context,
  userId: number,
  statusMsg: any,
  lang: string,
) {
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}

  const { getActiveReminders } = await import("../services/db.js");
  const reminders = getActiveReminders(userId);

  if (reminders.length === 0) {
    await ctx.reply(
      lang === "ru" ? "Активных напоминаний нет."
        : lang === "kk" ? "Белсенді еске салулар жоқ."
          : "No active reminders.",
    );
    return;
  }

  const lines: string[] = [];
  const keyboard = new InlineKeyboard();

  for (const r of reminders) {
    const dt = r.scheduled_time_kz || r.datetime || '';
    let timeLabel = '??:??';
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

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
}

async function handleCancelReminderIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
) {
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}

  const targetTask = intentResult.target_task;

  if (!targetTask) {
    await ctx.reply(
      lang === "ru"
        ? "Какое напоминание отменить? Укажите тему."
        : lang === "kk"
          ? "Қай еске салуды болдыру керек? Тақырыпты көрсетіңіз."
          : "Which reminder to cancel? Please specify the topic.",
    );
    return;
  }

  const { findReminderByTask, deleteReminderById } = await import("../services/db.js");
  const match = findReminderByTask(userId, targetTask);

  if (!match) {
    await ctx.reply(
      lang === "ru"
        ? `Не нашёл активного напоминания о «${targetTask}»`
        : lang === "kk"
          ? `«${targetTask}» туралы белсенді еске салу табылмады`
          : `No active reminder found about "${targetTask}"`,
    );
    return;
  }

  const deleted = deleteReminderById(userId, match.id);
  if (deleted) {
    const { cancelReminderByTaskId } = await import("../services/scheduler.js");
    cancelReminderByTaskId(match.id);
  }

  await ctx.reply(
    lang === "ru"
      ? `✅ Напоминание о «${match.task}» отменено.`
      : lang === "kk"
        ? `✅ «${match.task}» еске салуы болдырылды.`
        : `✅ Reminder about "${match.task}" cancelled.`,
  );
}


async function handleFreeTimeIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
  transcript?: string,
) {
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}

  let targetDate = intentResult.target_date;
  if (!targetDate && transcript) {
    targetDate = parseTargetDateFromText(transcript) || getKzToday();
  }
  if (!targetDate) targetDate = getKzToday();

  try {
    const { getFreeTimeAndBreaks } = await import("../services/planStore.js");
    const { buildFreeTimeMessage } = await import("../services/messages.js");
    const { gaps, breaks } = getFreeTimeAndBreaks(userId, targetDate);

    const dateLabel = DateTime.fromISO(targetDate, { zone: KZ_ZONE })
      .setLocale(lang === "ru" ? "ru-RU" : lang === "kk" ? "kk-KZ" : "en-US")
      .toFormat('cccc, d MMMM');

    const msg = buildFreeTimeMessage(dateLabel, gaps, breaks, lang);
    console.log('[FreeTime] Sending response to user:', ctx.chat?.id);
    await ctx.reply(msg);
  } catch (err) {
    logger.error('[FreeTime] Error calculating free time: %s', err);
    await ctx.reply(
      lang === "ru"
        ? "Не удалось рассчитать свободное время."
        : lang === "kk"
          ? "Бос уақытты есептеу мүмкін болмады."
          : "Could not calculate free time.",
    );
  }
}

function buildReportSummary(
  tasks: TodoItem[],
  overdue: TodoItem[],
  lang: string,
): string {
  const pending = tasks.filter((t) => !t.done);
  const completed = tasks.filter((t) => t.done);
  const base =
    lang === "ru"
      ? `Всего задач: ${tasks.length}. Выполнено: ${completed.length}, осталось: ${pending.length}.`
      : lang === "kk"
        ? `Барлық тапсырмалар: ${tasks.length}. Орындалды: ${completed.length}, қалды: ${pending.length}.`
        : `Total tasks: ${tasks.length}. Completed: ${completed.length}, remaining: ${pending.length}.`;

  if (overdue.length === 0) return base;

  const overdueHeader =
    lang === "ru" ? "ПРОСРОЧЕНО:" : lang === "kk" ? "МЕРЗІМІ ӨТКЕН:" : "OVERDUE:";
  const overdueLines = overdue
    .map((t) => `— ${t.task}${t.time ? ` · ${t.time}` : ""}${t.date ? ` · ${t.date}` : ""}`)
    .join("\n");
  return `${overdueHeader}\n${overdueLines}\n\n${base}`;
}

/**
 * Shared handler for both text and voice input.
 * Runs the core pipeline: pending time check → intent detection → memory update → routeByIntent.
 */
export async function processTextInput(
  transcript: string,
  ctx: Context,
  userId: number,
  lang: string,
  statusMsg?: any,
) {
  // ── If message is a new plan, clear stale pending time update ──
  if (looksLikeNewPlan(transcript)) {
    pendingTimeUpdate.delete(userId);
  }

  // ── Pending time update: user is answering "В какое время?" ──
  const pendingTime = pendingTimeUpdate.get(userId);
  if (pendingTime && pendingTime.tasks.length > 0) {
    if (DateTime.fromISO(pendingTime.askedAt).diffNow('minutes').minutes < -5) {
      pendingTimeUpdate.delete(userId);
    } else {
      const timeMatch = transcript.match(/\b(\d{1,2})[.:](\d{2})\b/);
      const wordTime = extractWordTime(transcript);
      const extractedTime = timeMatch
        ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`
        : wordTime;

      if (!extractedTime) {
        await ctx.reply(
          lang === 'ru'
            ? 'Напиши время, например "в 11 утра" или "14:30"'
            : lang === 'kk'
              ? 'Уақытты жаз, мысалы "таңғы 11" немесе "14:30"'
              : 'Say the time, e.g. "at 11 am" or "14:30"',
        );
        return 'pending_time_handled';
      }

      const task = pendingTime.tasks[pendingTime.step];
      const { db } = await import('../services/db.js');
      const newScheduledAt = DateTime.fromObject(
        {
          year: parseInt(task.date!.split('-')[0]),
          month: parseInt(task.date!.split('-')[1]),
          day: parseInt(task.date!.split('-')[2]),
          hour: parseInt(normalizeTime(extractedTime).split(':')[0]),
          minute: parseInt(normalizeTime(extractedTime).split(':')[1]),
        },
        { zone: 'Asia/Almaty' },
      ).toUTC().toISO()!;

      db.prepare('UPDATE todos SET time = ?, datetime = ?, scheduled_time_kz = ? WHERE id = ?').run(
        extractedTime,
        newScheduledAt,
        `${task.date}T${extractedTime}`,
        task.id,
      );

      console.log('[PendingTime] Updated:', task.task, '→', extractedTime);
      pendingTime.step++;

      if (pendingTime.step < pendingTime.tasks.length) {
        const nextTask = pendingTime.tasks[pendingTime.step];
        await ctx.reply(
          lang === 'ru'
            ? `✅ ${task.task} → ${extractedTime}\n\nВ какое время "${nextTask.task}"?`
            : lang === 'kk'
              ? `✅ ${task.task} → ${extractedTime}\n\n"${nextTask.task}" қай уақытта?`
              : `✅ ${task.task} → ${extractedTime}\n\nWhat time for "${nextTask.task}"?`,
        );
      } else {
        pendingTimeUpdate.delete(userId);
        await ctx.reply(
          lang === 'ru'
            ? `✅ ${task.task} → ${extractedTime}\n\nВсе времена указаны!`
            : lang === 'kk'
              ? `✅ ${task.task} → ${extractedTime}\n\nБарлық уақыттар көрсетілді!`
              : `✅ ${task.task} → ${extractedTime}\n\nAll times set!`,
        );
      }
      return 'pending_time_handled';
    }
  }

  // ── Intent detection ──
  const override = quickIntentOverride(transcript);
  const intentResult = override ?? (await detectIntent(transcript, userId));

  // ── Auto-update memory ──
  try {
    const currentMem = JSON.stringify(getUserMemory(userId));
    const memUpdateRaw = await extractMemoryUpdate(transcript, currentMem);
    if (memUpdateRaw) {
      const parsed = JSON.parse(memUpdateRaw);
      if (parsed.should_update) {
        updateUserMemory(userId, parsed.memory_update);
      }
    }
  } catch (e) {
    logger.error("[Voice] Memory update error: %s", e);
  }

  // ── Route by intent ──
  await routeByIntent(intentResult, ctx, userId, transcript, statusMsg, lang);
  return 'routed';
}

export async function routeByIntent(
  intentResult: any,
  ctx: Context,
  userId: number,
  transcript: string,
  statusMsg: any,
  lang: string,
) {
  const chatId = ctx.chat?.id;
  if (chatId && isAwaitingVoiceFollowup(chatId)) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    const handled = await routeImageFollowup(ctx, userId, transcript, lang, chatId);
    if (handled) return;
  }

  const intent = intentResult.intent;

  // Low confidence or incomplete reminder → ask user to clarify
  if (
    intentResult.confidence < 0.6 ||
    (intent === 'reminder' && (!intentResult.target_task || !intentResult.reminder_minutes))
  ) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    await ctx.reply(
      lang === "ru"
        ? "Не совсем понял. Уточни: ты хочешь добавить задачу, поставить напоминание или посмотреть план?"
        : lang === "kk"
          ? "Түсінбедім. Нақтылаңыз: тапсырма қосқыңыз келе ме, еске салу қою керек пе, жоспарды көргіңіз келе ме?"
          : "Not quite sure. Could you clarify: do you want to add a task, set a reminder, or view your plan?",
    );
    return;
  }

  switch (intent) {
    case "action":
      await handlePlanIntent(ctx, userId, transcript, statusMsg, lang);
      break;

    case "query":
      await handleQuestionIntent(ctx, userId, transcript, statusMsg, lang);
      break;

    case "reschedule": {
      const reminderMinutes = extractReminderFromTranscript(transcript);
      if (reminderMinutes) {
        pendingSecondaryActions.set(userId, { reminderMinutes });
      }
      await handleRescheduleIntent(
        ctx,
        userId,
        intentResult,
        statusMsg,
        lang,
        transcript,
      );
      await detectAndHandleSecondaryAction(transcript, userId, ctx, lang);
      break;
    }

    case "delete":
      await handleDeleteIntent(ctx, userId, transcript, statusMsg, lang);
      await detectAndHandleSecondaryAction(transcript, userId, ctx, lang);
      break;

    case "complete": {
      const reminderMinutes = extractReminderFromTranscript(transcript);
      if (reminderMinutes) {
        pendingSecondaryActions.set(userId, { reminderMinutes });
      }
      await handleCompleteIntent(ctx, userId, intentResult, statusMsg, lang);
      await detectAndHandleSecondaryAction(transcript, userId, ctx, lang);
      break;
    }

    case "report": {
      logger.debug("[Report] intent received: %s", JSON.stringify(intentResult));

      // Determine report mode: default to today when no date specified
      const dateFrom = intentResult.date_from;
      const dateTo = intentResult.date_to;
      let targetDate = intentResult.target_date;

      // FIX: When no date is specified at all, default to today (not weekly/range)
      if (!targetDate && !dateFrom) {
        targetDate = DateTime.now().setZone(KZ_ZONE).toISODate()!;
      }

      console.log('[Report] Mode:', dateFrom && dateTo ? 'weekly' : 'daily', targetDate ?? dateFrom);

      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}

      const waitMsg = await ctx.reply(
        lang === "ru" ? "Генерирую отчёт..." : lang === "kk" ? "Есеп жасалуда..." : "Generating report...",
      );

      try {
        let pdfBuf: Buffer;
        let dateLabel: string;

        if (dateFrom && dateTo) {
          // Date range report (week / multi-day) — only when BOTH are explicitly set
          pdfBuf = await generateRangeReportPdf(userId, dateFrom, dateTo, lang);
          dateLabel = `${dateFrom}_${dateTo}`;
        } else {
          // Single day report (default: today)
          const day = targetDate || getKzToday();
          pdfBuf = await generateDailyReportPdf(userId, day, lang);
          dateLabel = day;
        }

        try {
          await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id);
        } catch {}

        await ctx.replyWithDocument(
          new InputFile(pdfBuf, `report_${dateLabel}_${DateTime.now().toMillis()}.pdf`),
          { caption: "Report", reply_markup: getNavKeyboard(lang) },
        );
      } catch (err: any) {
        logger.error("[PDF] Generation failed: %s %s", err.message, err.stack);
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            waitMsg.message_id,
            `[PDF] ${err.message}`,
          );
        } catch {}
      }
      break;
    }

    case "clear":
      await handleCommandIntent(
        ctx,
        userId,
        { command: "clear" },
        statusMsg,
        lang,
      );
      break;

    case "summary":
      await handleSummaryIntent(ctx, userId, intentResult, statusMsg, lang);
      break;

    case "free_time_query":
      await handleFreeTimeIntent(
        ctx,
        userId,
        intentResult,
        statusMsg,
        lang,
        transcript,
      );
      break;

    case "social":
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      await ctx.reply(
        lang === "ru"
          ? "Готов слушать."
          : lang === "kk"
            ? "Тыңдауға дайынмын."
            : "Ready to listen.",
      );
      break;

    case "reminder":
      await handleReminderIntent(ctx, userId, intentResult, statusMsg, lang, transcript);
      break;

    case "list_reminders":
      await handleListRemindersIntent(ctx, userId, statusMsg, lang);
      break;

    case "cancel_reminder":
      await handleCancelReminderIntent(ctx, userId, intentResult, statusMsg, lang);
      break;
  }
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = normalizeTime(time).split(':').map(Number);
  return h * 60 + m;
}

function getPatternLabel(patternName: string, lang: string): string {
  const labels: Record<string, Record<string, string>> = {
    sleep_time: { ru: 'спишь', en: 'sleep', kk: 'ұйықтайсың' },
    wake_up_time: { ru: 'просыпаешься', en: 'wake up', kk: 'оянасың' },
    work_time: { ru: 'работаешь', en: 'work', kk: 'жұмыс істейсің' },
    lunch_time: { ru: 'обедаешь', en: 'lunch', kk: 'түскі ас' },
    dinner_time: { ru: 'ужинаешь', en: 'dinner', kk: 'кешкі ас' },
    breakfast_time: { ru: 'завтракаешь', en: 'breakfast', kk: 'таңғы ас' },
    gym_time: { ru: 'тренировка', en: 'gym', kk: 'жаттығу' },
  };
  return labels[patternName]?.[lang] || patternName;
}

function getTriggerTimeStr(time: string, offsetMinutes: number): string {
  const [h, m] = normalizeTime(time).split(":").map(Number);
  const d = DateTime.now().setZone(KZ_ZONE).set({ hour: h, minute: m, second: 0, millisecond: 0 }).minus({ minutes: offsetMinutes });
  return d.toFormat('HH:mm');
}

async function handleCommandIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
) {
  const chatId = ctx.chat?.id;
  if (chatId && isAwaitingVoiceFollowup(chatId)) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    const hint =
      lang === "ru"
        ? "Жду голосовое сообщение после скриншота. Отправьте инструкцию голосом."
        : lang === "kk"
          ? "Скриншоттан кейін дауыстық хабарлама күтемін."
          : "Waiting for a voice message after the screenshot. Send your instruction.";
    await ctx.reply(hint);
    return;
  }

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}
  const command = intentResult.command;

  if (command === "report" || command === "report_pdf") {
    console.log('[Report] handleCommandIntent input:', JSON.stringify(intentResult));
    let dateRanges = intentResult.date_ranges;
    let hasMultiDate = Array.isArray(dateRanges) && dateRanges.length > 1;
    let hasDateRange = intentResult.date_from || intentResult.date_to;
    let hasPeriod = intentResult.period && intentResult.period !== "all";
    let hasFilters =
      intentResult.target_date ||
      intentResult.target_time ||
      intentResult.after_time ||
      intentResult.priority_filter ||
      intentResult.source_filter ||
      hasDateRange ||
      hasPeriod;

    if (!hasFilters && !hasMultiDate && intentResult.raw_transcript) {
      const extracted = await extractReportInfo(intentResult.raw_transcript, userId);
      if (extracted) {
        if (extracted.target_date) intentResult.target_date = extracted.target_date;
        if (extracted.target_time) intentResult.target_time = extracted.target_time;
        if (extracted.after_time) intentResult.after_time = extracted.after_time;
        if (extracted.priority_filter) intentResult.priority_filter = extracted.priority_filter;
        if (extracted.source) intentResult.source_filter = extracted.source;
        if (extracted.date_from) intentResult.date_from = extracted.date_from;
        if (extracted.date_to) intentResult.date_to = extracted.date_to;
        if (extracted.date_ranges && extracted.date_ranges.length > 0) {
          intentResult.date_ranges = extracted.date_ranges;
          dateRanges = extracted.date_ranges;
          hasMultiDate = extracted.date_ranges.length > 1;
        }
        if (extracted.period) {
          intentResult.period = extracted.period;
          hasPeriod = extracted.period !== "all";
        }
        hasDateRange = intentResult.date_from || intentResult.date_to;
        hasFilters =
          intentResult.target_date ||
          intentResult.target_time ||
          intentResult.after_time ||
          intentResult.priority_filter ||
          intentResult.source_filter ||
          hasDateRange ||
          hasPeriod;
      }
    }

    // Parse explicit date from transcript if still missing (e.g. "отчёт на 16 июня")
    if (!hasFilters && !hasMultiDate && intentResult.raw_transcript) {
      const parsed = parseTargetDateFromText(intentResult.raw_transcript);
      if (parsed) {
        intentResult.target_date = parsed;
        hasFilters = true;
      }
    }

    if (hasMultiDate) {
      const sections: { label: string; tasks: TodoItem[] }[] = [];
      for (const dr of dateRanges) {
        const rawTasks = getTasksFiltered(userId, {
          date: dr.date ?? null,
          beforeTime: dr.beforeTime ?? null,
          afterTime: dr.afterTime ?? null,
          priority: null,
          includeDone: true,
        });
        const tasks = dedupeReportTasks(rawTasks);
        if (tasks.length > 0) {
          const d = dr.date ? DateTime.fromISO(dr.date, { zone: KZ_ZONE }) : null;
          const dateLabel = d
            ? d.setLocale(lang === "ru" ? "ru-RU" : lang === "kk" ? "kk-KZ" : "en-US")
                .toFormat('ccc, MMM d')
            : dr.date;
          let label = dateLabel;
          if (dr.beforeTime)
            label += ` ${lang === "ru" ? "до" : lang === "kk" ? "дейін" : "before"} ${dr.beforeTime}`;
          if (dr.afterTime)
            label += ` ${lang === "ru" ? "после" : lang === "kk" ? "кейін" : "after"} ${dr.afterTime}`;
          sections.push({ label, tasks });
        }
      }
      if (sections.length === 0) {
        await ctx.reply(
          lang === "ru"
            ? "Задач пока нет."
            : lang === "kk"
              ? "Тапсырмалар жоқ."
              : "No tasks recorded yet.",
        );
        return;
      }
      const waitMsg = await ctx.reply(
        lang === "ru"
          ? "Загрузка задач..."
          : lang === "kk"
            ? "Тапсырмалар жүктелуде..."
            : "Loading tasks...",
      );
      try {
        const pdfBuf = await generateMultiDateReportPdf(sections, lang);
        try {
          await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id);
        } catch {}
        await ctx.replyWithDocument(
          new InputFile(pdfBuf, `report_${userId}_${DateTime.now().toMillis()}.pdf`),
          { caption: "Report", reply_markup: getNavKeyboard(lang) },
        );
      } catch (err) {
        logger.error("[Report] Multi-date PDF generation failed: %s", err);
        await ctx.api.editMessageText(
          ctx.chat!.id,
          waitMsg.message_id,
          lang === "ru"
            ? "Не удалось создать PDF. Попробуйте ещё раз."
            : lang === "kk"
              ? "PDF жасау мүмкін болмады. Қайталап көріңіз."
              : "Failed to generate PDF. Please try again.",
        );
      }
    } else {
      const kzNow = DateTime.now().setZone(KZ_ZONE);
      const kzToday = getKzToday();

      // Resolve period to explicit dates (only when period is explicitly set)
      if (hasPeriod && !intentResult.target_date && !intentResult.date_from) {
        const period = intentResult.period;
        if (period === "today") {
          intentResult.target_date = kzToday;
        } else if (period === "tomorrow") {
          intentResult.target_date = getKzTomorrow();
        } else if (period === "week") {
          const weekStart = kzNow.startOf('week');
          const weekEnd = weekStart.plus({ days: 6 });
          intentResult.date_from = weekStart.toFormat('yyyy-MM-dd');
          intentResult.date_to = weekEnd.toFormat('yyyy-MM-dd');
        } else if (period === "month") {
          const monthStart = kzNow.startOf('month');
          const monthEnd = kzNow.endOf('month');
          intentResult.date_from = monthStart.toFormat('yyyy-MM-dd');
          intentResult.date_to = monthEnd.toFormat('yyyy-MM-dd');
        }
        hasDateRange = !!intentResult.date_from && !!intentResult.date_to;
        hasFilters = hasFilters || !!intentResult.target_date || hasDateRange;
      }

      // FIX: Default to today when no date specified at all
      const targetDate = intentResult.target_date || kzToday;
      const hasRange = !!(intentResult.date_from && intentResult.date_to);

      console.log('[Report] Mode:', hasRange ? 'weekly' : 'daily', targetDate);

      const queryDateFrom = hasRange ? intentResult.date_from : null;
      const queryDateTo = hasRange ? intentResult.date_to : null;

      const rawTasks = getTasksFiltered(userId, {
        date: hasRange ? null : targetDate,
        beforeTime: intentResult.target_time ?? null,
        afterTime: intentResult.after_time ?? null,
        priority: intentResult.priority_filter ?? null,
        dateFrom: queryDateFrom,
        dateTo: queryDateTo,
        source: intentResult.source_filter ?? null,
        includeDone: true,
      });

      const { tasks, overdue } = prepareReportTasks(rawTasks, targetDate);
      if (tasks.length === 0 && overdue.length === 0) {
        await ctx.reply(
          lang === "ru"
            ? "Задач пока нет."
            : lang === "kk"
              ? "Тапсырмалар жоқ."
              : "No tasks recorded yet.",
        );
        return;
      }
      const waitMsg = await ctx.reply(
        lang === "ru"
          ? "Загрузка задач..."
          : lang === "kk"
            ? "Тапсырмалар жүктелуде..."
            : "Loading tasks...",
      );
      try {
        const summary = buildReportSummary(tasks, overdue, lang);
        const pdfBuf = await generateReportPdf(tasks, lang, { summary });
        try {
          await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id);
        } catch {}
        await ctx.replyWithDocument(
          new InputFile(pdfBuf, `report_${userId}_${DateTime.now().toMillis()}.pdf`),
          { caption: "Report", reply_markup: getNavKeyboard(lang) },
        );
      } catch (err: any) {
        logger.error("[PDF] Generation failed: %s %s", err.message, err.stack);
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            waitMsg.message_id,
            `[PDF] ${err.message}`,
          );
        } catch {}
      }
    }
  } else if (command === "weekly") {
    const plans = getWeeklyPlans(userId);
    if (plans.length === 0) {
      await ctx.reply(
        lang === "ru"
          ? "За последние 7 дней записей нет."
          : lang === "kk"
            ? "Соңғы 7 күнде жазбалар жоқ."
            : "No notes in the past 7 days.",
      );
      return;
    }
    const waitMsg = await ctx.reply(
      lang === "ru"
        ? "Загрузка задач..."
        : lang === "kk"
          ? "Тапсырмалар жүктелуде..."
          : "Loading tasks...",
    );
    try {
      const tasks = plans.flatMap((p) => p.todos);
      const pdfBuf = await generateReportPdf(tasks, lang);
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id);
      } catch {}
      await ctx.replyWithDocument(
        new InputFile(pdfBuf, `weekly_${userId}_${DateTime.now().toMillis()}.pdf`),
        { caption: "Weekly Report", reply_markup: getNavKeyboard(lang) },
      );
    } catch (err: any) {
      logger.error("[PDF] Generation failed: %s %s", err.message, err.stack);
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          waitMsg.message_id,
          `[PDF] ${err.message}`,
        );
      } catch {}
    }
  } else if (command === "clear") {
    const archived = archiveCompletedTasks(userId);
    if (archived === 0) {
      await ctx.reply(
        lang === "ru"
          ? "Выполненных задач нет."
          : lang === "kk"
            ? "Мұрағатталатын орындалған тапсырма жоқ."
            : "No completed tasks to archive.",
        { reply_markup: getNavKeyboard(lang) },
      );
    } else {
      const msg =
        lang === "ru"
          ? `Архивировано задач: ${archived}.`
          : lang === "kk"
            ? `Мұрағатталды: ${archived} тапсырма.`
            : `Archived: ${archived} task${archived === 1 ? "" : "s"}.`;
      await ctx.reply(msg, { reply_markup: getNavKeyboard(lang) });
    }
  } else if (command === "language") {
    const newLang = intentResult.command_arg;
    if (["ru", "en", "kk"].includes(newLang)) {
      setUserLanguage(userId, newLang as "ru" | "en" | "kk");
      const msg =
        newLang === "ru"
          ? "Язык изменен на русский."
          : newLang === "kk"
            ? "Тіл қазақшаға өзгертілді."
            : "Language set to English.";
      await ctx.reply(msg);
    } else {
      await ctx.reply("Invalid language. Valid: ru, en, kk.");
    }
  }
}
