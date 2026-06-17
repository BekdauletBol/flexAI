import { Context, InputFile, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { transcribeAudio } from "../services/whisper.js";
import { analyzeTranscript } from "../services/analysis.js";
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
  getAwaitingImageFollowup,
  clearAwaitingImageFollowup,
} from "../services/pendingStore.js";
import {
  buildConflictMessage,
  buildCombinedConflictMessage,
  getConflictKeyboard,
  getCombinedConflictKeyboard,
  getSingleConflictKeyboard,
  getNavKeyboard,
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
} from "../services/intent.js";
import { getUserMemory, updateUserMemory } from "../services/memoryStore.js";
import {
  generateReportPdf,
  generateMultiDateReportPdf,
} from "../services/pdf.js";
import { TodoItem } from "../types/analysis.js";
import {
  generateFullReport,
  generateWeeklyReport,
} from "../services/reporter.js";
import { pendingImageTasks, ExtractedTask } from "./image.js";
import { groq, GROQ_MODEL, hasGroq } from "../services/groq.js";
import { utcToKzLocalDate } from "../utils/timezone.js";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

// ─── Compound command helpers ─────────────────────────────
const pendingSecondaryActions = new Map<number, { reminderMinutes?: number }>();

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
    console.error("[Compound] Failed to apply reminder:", e);
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

function formatViewDate(date: Date, lang: string): string {
  return date.toLocaleDateString(
    lang === "ru" ? "ru-RU" : lang === "kk" ? "kk-KZ" : "en-US",
    {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    },
  );
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
    const date = formatViewDate(new Date(plan.createdAt), lang);
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

  const fallback = new (await import("openai")).OpenAI({
    apiKey: config.openaiApiKey,
    ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
    timeout: 60000,
    maxRetries: 1,
  });

  const llm = hasGroq ? groq : fallback;
  const MODEL = hasGroq ? GROQ_MODEL : config.openaiModel;

  const response = await llm.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: `You are a personal secretary bot processing a screenshot + voice command.

SCREENSHOT TASKS (extracted from image):
${imageTasksText}

USER'S EXISTING SCHEDULE:
${existingTasksText || "No existing tasks"}

Analyze the user's voice command about the screenshot tasks.
Current date/time: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}

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
    ],
    max_tokens: 1024,
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const content = response.choices[0]?.message?.content || "{}";
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
          expiresAt: Date.now() + 60000,
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
    tempFile = path.join(tmpDir, `v_${Date.now()}.ogg`);
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
    console.log("[Voice] Language:", {
      configured: configuredLang,
      detected: detectedLang,
      used: lang,
    });

    // Clean up expired pending image data
    for (const [uid, data] of pendingImageTasks) {
      if (data.expiresAt < Date.now()) pendingImageTasks.delete(uid);
    }

    // Check for pending image tasks — route to voice-with-image flow
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
      clearAwaitingImageFollowup(userId);
      return;
    }

    // Check for awaiting image followup state (when user sends voice after image without using buttons)
    const awaitingImage = getAwaitingImageFollowup(userId);
    if (awaitingImage) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      await handleVoiceWithImageContext(
        ctx,
        userId,
        transcript,
        lang,
        awaitingImage.imageData.tasks,
      );
      pendingImageTasks.delete(userId);
      clearAwaitingImageFollowup(userId);
      return;
    }

    const state = getUserState(userId);
    if (state?.flow) {
      await continueFlow(ctx, userId, state, transcript, statusMsg, lang);
      return;
    }

    const flowState = getUserFlowState(userId);
    if (flowState) {
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
    const override = quickIntentOverride(transcript);
    const intentResult = override ?? (await detectIntent(transcript));
    console.log("[DEBUG] Transcript:", transcript.substring(0, 150));
    console.log("[DEBUG] Intent result:", JSON.stringify(intentResult));

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
    } catch (e) {
      console.error("[Voice] Memory update error:", e);
    }

    await routeByIntent(intentResult, ctx, userId, transcript, statusMsg, lang);

    console.log(`[Voice] Done: ${intentResult.intent} from @${username}`);
  } catch (error) {
    console.error("[Voice] Error:", error);
    const msg = error instanceof Error ? error.message : "";
    try {
      if (msg.includes("Failed to transcribe")) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          "Could not recognize speech.",
        );
      } else if (msg.startsWith("TRANSCRIPT_FALLBACK:")) {
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
    analysis = await analyzeTranscript(transcript);
  } catch (e) {
    console.error("[Voice] Analysis failed:", e);
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
      console.warn(
        "[Action] Skipping suspicious task that looks like a delete command:",
        todo.task,
      );
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
    const targetTime = analysis.visit_datetime || new Date().toISOString();
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
      console.error("[Voice] Location assistant error:", err);
    }
  }

  // Conflict detection — collect all conflicts
  const conflicts = ctx.from ? getConflicts(userId, analysis.todos) : [];

  // Separate conflicting vs clean tasks
  const conflictedIds = new Set(conflicts.map((c) => c.newTodo.id));
  const cleanTodos = analysis.todos.filter((t) => !conflictedIds.has(t.id));
  const conflictTodos = analysis.todos.filter((t) => conflictedIds.has(t.id));

  // Save non-conflicting tasks immediately
  if (ctx.chat && cleanTodos.length > 0) {
    const cleanAnalysis = { ...analysis, todos: cleanTodos };
    savePlan(ctx.chat.id, userId, cleanAnalysis, 'voice');
  }

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
    console.log(
      `[Voice] Long-term plan saved: "${analysis.title}" [${analysis.timeframe}]`,
    );
    return;
  }

  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  await startDeliveryFlow(ctx, {
    ...pendingData,
    id: pendingId,
    createdAt: Date.now(),
  });

  console.log(
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

  // Fallback: if LLM intent didn't extract task/time, call extractRescheduleInfo
  if (!taskQuery && transcript) {
    console.log(
      "[Reschedule] target_task missing, running extractRescheduleInfo...",
    );
    const extracted = await extractRescheduleInfo(transcript);
    if (extracted) {
      taskQuery = extracted.task || taskQuery;
      targetTime = extracted.newTime || targetTime;
      targetDate = extracted.date || targetDate;
      console.log(
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
  const found = findTaskByText(userId, taskQuery, targetDate);
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
    updateTaskDateTime(
      userId,
      found.todo.id,
      targetDate || found.todo.date || "",
      targetTime,
    );
    cancelReminderByTaskId(found.todo.id);
    if (ctx.chat) scheduleReminders(ctx.chat.id, userId, [found.todo], lang);
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
  const info = await extractDeleteInfo(transcript);
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
    const dateStr = info.date || new Date().toISOString().substring(0, 10);
    const formattedDate = formatViewDate(new Date(dateStr + "T12:00:00"), lang);
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
        const extracted = await extractRescheduleInfo(input);
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
        const tasks = getUserTasks(userId);
        const task = tasks.find((t) => t.id === taskId);
        if (task) {
          updateTaskDateTime(userId, taskId, task.date || "", newTime);
          cancelReminderByTaskId(taskId);
          if (ctx.chat) scheduleReminders(ctx.chat.id, userId, [task], lang);
          await applyPendingReminder(userId, taskId, ctx, lang);
        }
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

export async function routeByIntent(
  intentResult: any,
  ctx: Context,
  userId: number,
  transcript: string,
  statusMsg: any,
  lang: string,
) {
  const intent = intentResult.intent;

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

    case "report":
      await handleCommandIntent(
        ctx,
        userId,
        { ...intentResult, command: "report_pdf", raw_transcript: transcript },
        statusMsg,
        lang,
      );
      break;

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
  }
}

function getTriggerTimeStr(time: string, offsetMinutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m - offsetMinutes, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function handleCommandIntent(
  ctx: Context,
  userId: number,
  intentResult: any,
  statusMsg: any,
  lang: string,
) {
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
  } catch {}
  const command = intentResult.command;

  if (command === "report" || command === "report_pdf") {
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
      const extracted = await extractReportInfo(intentResult.raw_transcript);
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

    if (hasMultiDate) {
      const sections: { label: string; tasks: TodoItem[] }[] = [];
      for (const dr of dateRanges) {
        const tasks = getTasksFiltered(userId, {
          date: dr.date ?? null,
          beforeTime: dr.beforeTime ?? null,
          afterTime: dr.afterTime ?? null,
          priority: null,
        });
        if (tasks.length > 0) {
          const d = dr.date ? new Date(dr.date + "T12:00:00") : null;
          const dateLabel = d
            ? d.toLocaleDateString(
                lang === "ru" ? "ru-RU" : lang === "kk" ? "kk-KZ" : "en-US",
                { weekday: "short", month: "short", day: "numeric" },
              )
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
          new InputFile(pdfBuf, `report_${userId}_${Date.now()}.pdf`),
          { caption: "Report", reply_markup: getNavKeyboard(lang) },
        );
      } catch (err) {
        console.error("[Report] Multi-date PDF generation failed:", err);
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
      if (hasPeriod && !hasDateRange && !intentResult.target_date) {
        // Use Kazakhstan time (UTC+5) for date calculations
        const now = new Date();
        const kzToday = utcToKzLocalDate(now.toISOString());
        const period = intentResult.period;
        if (period === "today") {
          intentResult.target_date = kzToday;
        } else if (period === "tomorrow") {
          const tmr = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          intentResult.target_date = utcToKzLocalDate(tmr.toISOString());
        } else if (period === "week") {
          const kzNow = new Date(now.getTime() + 5 * 60 * 60 * 1000); // KZ time
          const weekStart = new Date(kzNow);
          weekStart.setDate(kzNow.getDate() - kzNow.getDay() + 1);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekStart.getDate() + 6);
          intentResult.date_from = weekStart.toISOString().slice(0, 10);
          intentResult.date_to = weekEnd.toISOString().slice(0, 10);
        } else if (period === "month") {
          const kzNow = new Date(now.getTime() + 5 * 60 * 60 * 1000); // KZ time
          const monthStart = new Date(kzNow.getFullYear(), kzNow.getMonth(), 1);
          const monthEnd = new Date(kzNow.getFullYear(), kzNow.getMonth() + 1, 0);
          intentResult.date_from = monthStart.toISOString().slice(0, 10);
          intentResult.date_to = monthEnd.toISOString().slice(0, 10);
        }
      }

      const tasks = hasFilters
        ? getTasksFiltered(userId, {
            date: intentResult.target_date ?? null,
            beforeTime: intentResult.target_time ?? null,
            afterTime: intentResult.after_time ?? null,
            priority: intentResult.priority_filter ?? null,
            dateFrom: intentResult.date_from ?? null,
            dateTo: intentResult.date_to ?? null,
            source: intentResult.source_filter ?? null,
          })
        : getUserTasks(userId);
      if (tasks.length === 0) {
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
        const pdfBuf = await generateReportPdf(tasks, lang);
        try {
          await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id);
        } catch {}
        await ctx.replyWithDocument(
          new InputFile(pdfBuf, `report_${userId}_${Date.now()}.pdf`),
          { caption: "Report", reply_markup: getNavKeyboard(lang) },
        );
      } catch (err) {
        console.error("[Report] PDF generation failed:", err);
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
        new InputFile(pdfBuf, `weekly_${userId}_${Date.now()}.pdf`),
        { caption: "Weekly Report", reply_markup: getNavKeyboard(lang) },
      );
    } catch (err) {
      const report = generateWeeklyReport(plans, lang);
      await ctx.api.editMessageText(ctx.chat!.id, waitMsg.message_id, report, {
        reply_markup: getNavKeyboard(lang),
      });
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
