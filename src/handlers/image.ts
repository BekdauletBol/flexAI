import { Context, InlineKeyboard } from "grammy";
import OpenAI from "openai";
import { config } from "../config.js";
import { getUserTasks } from "../services/planStore.js";
import { getUserConfig } from "../services/userConfig.js";
import { logger } from "../logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedTask {
  task: string;
  date: string | null;
  time: string | null;
  end_time: string | null;
  duration_minutes: number;
  priority: string;
  notes: string | null;
}

interface ScheduleSlot {
  time: string;
  end_time: string;
  label: string;
  type: "busy" | "free";
}

interface ScreenshotAnalysis {
  source_app: string;
  detected_date: string | null;
  events: ExtractedTask[];
  free_slots: ScheduleSlot[];
  busy_slots: ScheduleSlot[];
  summary: string;
}

export interface PendingImageData {
  tasks: ExtractedTask[];
  source: string;
  analysis: ScreenshotAnalysis;
  expiresAt: number;
}

export const pendingImageTasks = new Map<number, PendingImageData>();

// ─── OpenAI Vision client (must use OpenAI, not Groq — Groq has no vision) ───

function getVisionClient(): OpenAI {
  return new OpenAI({
    apiKey: config.openaiApiKey,
    ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
    timeout: 60000,
    maxRetries: 1,
  });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleImage(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const photo = ctx.message?.photo;
  if (!photo || photo.length === 0) return;

  const lang = getUserConfig(userId).language || "ru";

  const statusMsg = await ctx.reply(
    lang === "ru"
      ? "Анализирую скриншот..."
      : lang === "kk"
        ? "Скриншотты талдап жатырмын..."
        : "Analyzing screenshot...",
  );

  try {
    // Download highest resolution photo
    const highRes = photo[photo.length - 1];
    const file = await ctx.api.getFile(highRes.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok)
      throw new Error(`Failed to download image: ${response.status}`);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    // Get user's existing tasks for free/busy cross-reference
    const existingTasks = getUserTasks(userId).filter((t) => !t.done);

    // Analyze screenshot with GPT-4o Vision
    const analysis = await analyzeScheduleScreenshot(
      base64,
      existingTasks,
      lang,
    );

    if (analysis.events.length === 0) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {}
      await ctx.reply(
        lang === "ru"
          ? "Не вижу задач или расписания на этом скриншоте. Попробуй другой."
          : lang === "kk"
            ? "Бұл скриншотта тапсырмалар немесе кесте жоқ. Басқасын жіберіп көр."
            : "No tasks or schedule found in this screenshot. Try a different one.",
      );
      return;
    }

    // Store for voice follow-up
    pendingImageTasks.set(userId, {
      tasks: analysis.events,
      source: analysis.source_app,
      analysis,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    });

    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}

    // Build and send the full schedule analysis message
    const message = buildAnalysisMessage(analysis, existingTasks, lang);

    const keyboard = new InlineKeyboard()
      .text(
        lang === "ru"
          ? `Добавить все (${analysis.events.length})`
          : lang === "kk"
            ? `Барлығын қосу (${analysis.events.length})`
            : `Add all (${analysis.events.length})`,
        `img_add_all_${userId}`,
      )
      .text(
        lang === "ru" ? "Отмена" : lang === "kk" ? "Болдырмау" : "Cancel",
        `img_cancel_${userId}`,
      );

    // Split into chunks if message is too long (Telegram 4096 limit)
    const chunks = splitMessage(message, 3800);
    for (let i = 0; i < chunks.length; i++) {
      if (i === chunks.length - 1) {
        await ctx.reply(chunks[i], { reply_markup: keyboard });
      } else {
        await ctx.reply(chunks[i]);
      }
    }
  } catch (err) {
    logger.error(err, "[Image] Analysis failed");
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}
    await ctx.reply(
      lang === "ru"
        ? "Не удалось проанализировать скриншот. Попробуй ещё раз."
        : lang === "kk"
          ? "Скриншотты талдау мүмкін болмады. Қайталап көр."
          : "Failed to analyze screenshot. Please try again.",
    );
  }
}

// ─── Screenshot Analysis via GPT-4o Vision ───────────────────────────────────

async function analyzeScheduleScreenshot(
  base64: string,
  existingTasks: any[],
  lang: string,
): Promise<ScreenshotAnalysis> {
  const client = getVisionClient();

  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

  const existingScheduleText =
    existingTasks.length > 0
      ? existingTasks
          .filter((t) => t.time)
          .map(
            (t) => `- ${t.task} at ${t.time}${t.date ? " on " + t.date : ""}`,
          )
          .join("\n")
      : "No existing schedule.";

  const prompt = `Today is ${todayStr}, current time is ${timeStr}.

The user's EXISTING schedule (already saved):
${existingScheduleText}

Analyze this screenshot carefully. It may be from Microsoft Teams, Outlook, Google Calendar, Notion, Apple Calendar, WhatsApp, Telegram, handwritten notes, or any other app.

Your job:
1. Identify the source app
2. Extract ALL events/tasks/meetings visible with their times
3. Identify BUSY time slots (when user has events)
4. Identify FREE time slots between events (gaps of 30+ minutes)
5. Cross-reference with the user's existing schedule to find conflicts
6. Write a clear summary in ${lang === "ru" ? "Russian" : lang === "kk" ? "Kazakh" : "English"}

Return ONLY this JSON (no markdown, no extra text):
{
  "source_app": "app name (e.g. Microsoft Teams, Google Calendar, Notion, WhatsApp, etc.)",
  "detected_date": "YYYY-MM-DD if visible, null if not clear",
  "events": [
    {
      "task": "event/meeting/task name in original language",
      "date": "YYYY-MM-DD or null",
      "time": "HH:MM start time or null",
      "end_time": "HH:MM end time or null",
      "duration_minutes": 30,
      "priority": "high/medium/low",
      "notes": "additional context or null"
    }
  ],
  "free_slots": [
    {
      "time": "HH:MM",
      "end_time": "HH:MM",
      "label": "Free time description",
      "type": "free"
    }
  ],
  "busy_slots": [
    {
      "time": "HH:MM",
      "end_time": "HH:MM",
      "label": "Meeting/event name",
      "type": "busy"
    }
  ],
  "summary": "2-3 sentence summary in ${lang === "ru" ? "Russian" : lang === "kk" ? "Kazakh" : "English"} describing what was found, when the person is free/busy, and any conflicts with existing tasks"
}`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64}`,
              detail: "high",
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: 2048,
    temperature: 0.1,
  });

  const content = response.choices[0]?.message?.content || "{}";

  try {
    // Strip markdown code blocks if present
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as ScreenshotAnalysis;

    // Ensure arrays exist
    parsed.events = parsed.events || [];
    parsed.free_slots = parsed.free_slots || [];
    parsed.busy_slots = parsed.busy_slots || [];
    parsed.summary = parsed.summary || "";

    return parsed;
  } catch (err) {
    logger.error(err, "[Image] Failed to parse vision response");
    return {
      source_app: "Unknown",
      detected_date: null,
      events: [],
      free_slots: [],
      busy_slots: [],
      summary: "",
    };
  }
}

// ─── Message Builder ──────────────────────────────────────────────────────────

function buildAnalysisMessage(
  analysis: ScreenshotAnalysis,
  existingTasks: any[],
  lang: string,
): string {
  const lines: string[] = [];
  const SEP = "———————————————";

  // Header
  if (lang === "ru") {
    lines.push(`СКРИНШОТ — ${analysis.source_app}`);
  } else if (lang === "kk") {
    lines.push(`СКРИНШОТ — ${analysis.source_app}`);
  } else {
    lines.push(`SCREENSHOT — ${analysis.source_app}`);
  }

  if (analysis.detected_date) {
    const d = new Date(analysis.detected_date + "T12:00:00");
    const dateLabel = d.toLocaleDateString(
      lang === "ru" ? "ru-RU" : lang === "kk" ? "kk-KZ" : "en-US",
      { weekday: "long", day: "numeric", month: "long" },
    );
    lines.push(dateLabel);
  }

  lines.push("");

  // Summary
  if (analysis.summary) {
    lines.push(analysis.summary);
    lines.push("");
    lines.push(SEP);
    lines.push("");
  }

  // Busy slots
  if (analysis.busy_slots.length > 0) {
    if (lang === "ru") lines.push("ЗАНЯТО");
    else if (lang === "kk") lines.push("БОС ЕМЕС");
    else lines.push("BUSY");
    lines.push("");

    for (const slot of analysis.busy_slots) {
      const timeRange = slot.end_time
        ? `${slot.time}–${slot.end_time}`
        : slot.time;
      lines.push(`🔴 ${timeRange}  ${slot.label}`);
    }
    lines.push("");
  }

  // Free slots
  if (analysis.free_slots.length > 0) {
    if (lang === "ru") lines.push("СВОБОДНО");
    else if (lang === "kk") lines.push("БОС УАҚЫТ");
    else lines.push("FREE");
    lines.push("");

    for (const slot of analysis.free_slots) {
      const timeRange = slot.end_time
        ? `${slot.time}–${slot.end_time}`
        : slot.time;
      lines.push(`🟢 ${timeRange}  ${slot.label}`);
    }
    lines.push("");
  }

  // All extracted events
  if (analysis.events.length > 0) {
    lines.push(SEP);
    lines.push("");

    if (lang === "ru")
      lines.push(`НАЙДЕНО СОБЫТИЙ — ${analysis.events.length}`);
    else if (lang === "kk")
      lines.push(`ТАБЫЛҒАН ОҚИҒАЛАР — ${analysis.events.length}`);
    else lines.push(`EVENTS FOUND — ${analysis.events.length}`);
    lines.push("");

    for (const event of analysis.events) {
      let line = `— ${event.task}`;
      if (event.time) {
        line += `  ·  ${event.time}`;
        if (event.end_time) line += `–${event.end_time}`;
      }
      if (event.date) {
        const d = new Date(event.date + "T12:00:00");
        const dateLabel = d.toLocaleDateString(
          lang === "ru" ? "ru-RU" : lang === "kk" ? "kk-KZ" : "en-US",
          { month: "short", day: "numeric" },
        );
        line += `  ·  ${dateLabel}`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  // Conflicts with existing tasks
  const conflicts = findConflictsWithExisting(analysis.events, existingTasks);
  if (conflicts.length > 0) {
    lines.push(SEP);
    lines.push("");

    if (lang === "ru") lines.push(`⚠️ КОНФЛИКТЫ — ${conflicts.length}`);
    else if (lang === "kk") lines.push(`⚠️ ҚАЙШЫЛЫҚТАР — ${conflicts.length}`);
    else lines.push(`⚠️ CONFLICTS — ${conflicts.length}`);
    lines.push("");

    for (const c of conflicts.slice(0, 5)) {
      // max 5 to avoid message too long
      if (lang === "ru") {
        lines.push(
          `— "${c.newEvent}" (${c.time}) пересекается с "${c.existing}"`,
        );
      } else if (lang === "kk") {
        lines.push(
          `— "${c.newEvent}" (${c.time}) "${c.existing}" қайшы келеді`,
        );
      } else {
        lines.push(
          `— "${c.newEvent}" (${c.time}) conflicts with "${c.existing}"`,
        );
      }
    }
    lines.push("");
  }

  // Footer hint
  lines.push(SEP);
  lines.push("");
  if (lang === "ru") {
    lines.push(
      "Отправь голосовое — скажи что добавить, объединить или проверить.",
    );
  } else if (lang === "kk") {
    lines.push(
      "Дауыстық хабар жібер — не қосу, біріктіру немесе тексеру керектігін айт.",
    );
  } else {
    lines.push("Send a voice message — tell me what to add, merge, or check.");
  }

  return lines.join("\n");
}

// ─── Conflict Detection ───────────────────────────────────────────────────────

function findConflictsWithExisting(
  newEvents: ExtractedTask[],
  existingTasks: any[],
): { newEvent: string; existing: string; time: string }[] {
  const conflicts: { newEvent: string; existing: string; time: string }[] = [];

  for (const event of newEvents) {
    if (!event.time) continue;
    const [newH, newM] = event.time.split(":").map(Number);
    const newStart = newH * 60 + newM;
    const newEnd = newStart + (event.duration_minutes || 30);

    for (const task of existingTasks) {
      if (!task.time) continue;
      const [exH, exM] = task.time.split(":").map(Number);
      const exStart = exH * 60 + exM;
      const exEnd = exStart + (task.duration || 30);

      // Check date match if both have dates
      if (event.date && task.date && event.date !== task.date) continue;

      // Check time overlap
      const overlaps = newStart < exEnd && newEnd > exStart;
      if (overlaps) {
        conflicts.push({
          newEvent: event.task,
          existing: task.task,
          time: event.time,
        });
      }
    }
  }

  return conflicts;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > maxLength) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
