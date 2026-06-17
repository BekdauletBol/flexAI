import OpenAI from "openai";
import { config } from "../config.js";
import { TaskSource } from "../types/analysis.js";
import { groq, GROQ_MODEL, hasGroq } from "./groq.js";

const fallback = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  timeout: 60000,
  maxRetries: 1,
});

const llm = hasGroq ? groq : fallback;
const MODEL = hasGroq ? GROQ_MODEL : config.openaiModel;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export interface DateRange {
  date: string;
  beforeTime?: string;
  afterTime?: string;
}

export interface IntentResult {
  intent:
    | "action"
    | "query"
    | "reschedule"
    | "delete"
    | "complete"
    | "report"
    | "clear"
    | "summary"
    | "social"
    | "free_time_query";
  confidence: number;
  target_task?: string;
  target_date?: string;
  target_time?: string;
  after_time?: string;
  priority_filter?: "high" | "medium" | "low";
  source_filter?: TaskSource;
  period?: "today" | "tomorrow" | "week" | "month" | "all" | string;
  command_arg?: string;
  date_ranges?: DateRange[];
  date_from?: string;
  date_to?: string;
}

const SYSTEM_PROMPT = `Classify the user's message into ONE intent.

HIGHEST PRIORITY — check these BEFORE anything else:

REPORT RULES — If ANY of these words appear → intent is "report", NEVER "action":
  Russian: отчёт, репорт, скинь задачи, покажи задачи, PDF, пдф, покажи план, что у меня запланировано, мои задачи за, задачи на, скинь отчёт, покажи отчёт
  English: report, show tasks, send pdf, show my tasks, what's planned, my tasks for, what do I have, what's on
  Kazakh: есеп, есеп бер, тапсырмалар, тапсырмаларды көрсет, pdf, құжатты жібер
  Do NOT create a task from these. Do NOT save them. Do NOT reply with action.
  Also extract any filters mentioned: source (teams/telegram/voice/manual), target_date, target_time, after_time, date_from, date_to, period, priority_filter.

QUERY RULES — Use ONLY for general chat questions, NOT about tasks:
  "что ты умеешь", "как дела", "how are you", "привет", "hello", "сәлеметсіз бе", "қалайсыз"
  Do NOT use query for "какие планы", "что у меня", "покажи", "қайшы пландар", "маған жоспарларымды көрсет" — those are "report".

ACTION RULES — Only use "action" if the message clearly describes a NEW task/plan/todo:
  Russian: "запиши", "добавь", "создай", "напомни сделать", "нужно сделать", "план на"
  English: "add", "create", "remind me to", "need to do", "plan for"
  Kazakh: "қос", "жаса", "жоспар", "есте сақта", "жасау керек"
  NEVER use action if the message is asking about EXISTING tasks.

DELETE — ONLY if message contains: удали, убери, отмени, удалить, убрать, отменить, delete, remove, cancel, өшір, жой, болдырма

RESCHEDULE — ONLY if message contains: перенеси, передвинь, сдвинь, перенести, reschedule, move, жылжыт, басқа уақытқа қой

COMPLETE — ONLY if message contains: выполнил, сделал, готово, complete, done, finished, орындадым, біттім, дайын

TARGET TASK EXTRACTION (critical for reschedule/complete/delete):
- For "reschedule", "complete", and "delete" intents, you MUST extract the task name the user refers to and put it in "target_task".
- Preserve foreign terms, acronyms, brand names, and mixed-language phrases exactly as spoken.
  Examples: "CJM customer journey map", "UX review", "API integration", "Zoom call", "Notion", "Figma".
- If the user says "перенеси встречу на 5", target_task = "встреча".
- If the user says "complete the API task", target_task = "API task".
- If the user says "удали CJM customer journey map", target_task = "CJM customer journey map".
- If the task is unclear, set target_task to the exact noun phrase the user mentioned after the action verb.

For "report" intents, set these fields:
  target_date — specific date mentioned (YYYY-MM-DD)
  target_time — specific time filter (HH:MM) meaning "before this time"
  after_time — show tasks after this time
  period — "today", "tomorrow", "week", "month", "all"
  date_from — start of date range (YYYY-MM-DD). Examples:
    Russian: "за этот месяц" → first day of current month, "за этот год" → Jan 1, "неделя" → Monday of current week, "между 20 и 28 июня" → 2026-06-20, "на сегодня" → today, "на завтра" → tomorrow, "на этой неделе" → Mon-Sun
    Kazakh: "бүгін" → today, "ертең" → tomorrow, "осы аптада" → Mon-Sun, "бұл ай" → first-to-last of month
    English: "today", "tomorrow", "this week", "this month", "between June 20 and 28" → 2026-06-20 to 2026-06-28
  date_to — end of date range (YYYY-MM-DD). Examples:
    Russian: "за этот месяц" → last day, "за этот год" → Dec 31, "неделя" → Sunday, "между 20 и 28 июня" → 2026-06-28
    Kazakh: "осы аптада" → Sunday, "бұл ай" → last day
  date_ranges — for multiple dates/spans: [{"date": "YYYY-MM-DD", "beforeTime": "HH:MM or null", "afterTime": "HH:MM or null"}]
    Examples: "сегодня и завтра", "бүгін және ертең" → two entries, "на 2 дня" → today+tomorrow,
    "до 19 июня" → entries for each day from today to June 19,
    "на следующую неделю" → entries for next 7 days,
    "за эту неделю" → entries for current week (Mon-Sun)
  priority_filter — "high" | "medium" | "low" or null
  source_filter — task origin filter: "teams" | "telegram" | "voice" | "manual" or null. Examples:
    - "только из Teams", "from the team", "планы из команды", "отчет по Teams", "команда", "Teams-тен", "Teams дан" → "teams"
    - "задачи из Telegram", "Telegram-дан" → "telegram"
    - "голосовые задачи", "дауыстық тапсырмалар" → "voice"
    - "добавленные вручную", "қолмен қосылған" → "manual"
  time filter examples:
    Russian: "до 17:00" → target_time="17:00"; "после 17:00" → after_time="17:00"
    Kazakh: "17:00-ға дейін" → target_time="17:00"; "17:00-ден кейін" → after_time="17:00"
    English: "before 17:00" → target_time="17:00"; "after 17:00" → after_time="17:00"

Return ONLY this JSON:
{
  "intent": "action|query|reschedule|delete|complete|report|clear|summary|social",
  "confidence": 0.0-1.0,
  "target_task": "task name or null",
  "target_date": "YYYY-MM-DD or null",
  "target_time": "HH:MM or null",
  "after_time": "HH:MM or null",
  "date_from": "YYYY-MM-DD or null",
  "date_to": "YYYY-MM-DD or null",
  "date_ranges": [{"date": "YYYY-MM-DD", "beforeTime": "HH:MM or null", "afterTime": "HH:MM or null"}],
  "priority_filter": "high|medium|low or null",
  "source_filter": "teams|telegram|voice|manual or null"
}`;

export function detectTranscriptLanguage(
  transcript: string,
): "ru" | "kk" | "en" {
  const text = transcript.toLowerCase();
  // Kazakh-specific Cyrillic characters
  const kazakhChars = /[әіңғүұқөһ]/;
  if (kazakhChars.test(text)) return "kk";
  // General Cyrillic characters
  const cyrillicChars = /[а-яё]/;
  if (cyrillicChars.test(text)) return "ru";
  return "en";
}

export function quickIntentOverride(
  transcript: string,
): Partial<IntentResult> | null {
  const lower = transcript.toLowerCase().replace(/\s+/g, " ").trim();

  const reportWords = [
    "отчёт",
    "репорт",
    "отчет",
    "скинь задачи",
    "покажи задачи",
    "скинь план",
    "покажи план",
    "send report",
    "show report",
    "show tasks",
    "send pdf",
    "отправь отчёт",
    "скинь отчёт",
    "покажи отчёт",
    "отправь документ",
    "скинь документ",
    "скинь в формате",
    "скинь пдф",
    "в формате pdf",
    "в формате пдф",
    "pdf",
    "пдф",
    "есе",
    "есе бер",
    "тапсырмаларды көрсет",
    "құжатты жібер",
    "pdf жібер",
  ];

  if (!reportWords.some((w) => lower.includes(w))) {
    const queryWords = [
      "какие у меня",
      "что у меня",
      "есть ли у меня",
      "what do i have",
      "what's on my",
      "покажи что",
      "какой план",
      "что запланировано",
      "маған не жоспарланған",
      "жоспарларымды көрсет",
    ];
    if (queryWords.some((w) => lower.includes(w))) {
      console.log("[Intent] Quick override → query");
      return { intent: "query", confidence: 1.0 };
    }
    return null;
  }

  // Report intent confirmed. Try to resolve simple date/period filters directly.
  const today = new Date().toISOString().slice(0, 10);
  const tmr = new Date();
  tmr.setDate(tmr.getDate() + 1);
  const tomorrow = tmr.toISOString().slice(0, 10);

  if (lower.includes("сегодня") || lower.includes("today") || lower.includes("бүгін")) {
    console.log("[Intent] Quick override → report today");
    return { intent: "report", confidence: 1.0, target_date: today };
  }
  if (lower.includes("завтра") || lower.includes("tomorrow") || lower.includes("ертең")) {
    console.log("[Intent] Quick override → report tomorrow");
    return { intent: "report", confidence: 1.0, target_date: tomorrow };
  }
  if (lower.includes("неделя") || lower.includes("week") || lower.includes("апта")) {
    console.log("[Intent] Quick override → report week");
    return { intent: "report", confidence: 1.0, period: "week" };
  }
  if (lower.includes("месяц") || lower.includes("month") || lower.includes("ай")) {
    console.log("[Intent] Quick override → report month");
    return { intent: "report", confidence: 1.0, period: "month" };
  }

  console.log("[Intent] Quick override → report");
  return {
    intent: "report",
    confidence: 1.0,
    target_date: undefined,
    target_time: undefined,
    date_ranges: [],
  };
}

export async function detectIntent(transcript: string): Promise<IntentResult> {
  console.log(
    "[Intent] Starting detectIntent, model:",
    MODEL,
    "baseURL:",
    config.openaiBaseUrl,
  );
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const systemPromptWithDate = `Today is ${dateStr}.\n\n${SYSTEM_PROMPT}`;
  try {
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: systemPromptWithDate },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 500,
      }),
      60000,
    );

    console.log("[Intent] Got response from OpenAI");
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response");

    console.log("[Intent] Response content:", content);
    const result = JSON.parse(content) as IntentResult;
    result.intent = result.intent || "action";
    result.confidence = result.confidence || 0.5;

    console.log(
      `[Intent] "${result.intent}" (${(result.confidence * 100).toFixed(0)}%)`,
    );
    return result;
  } catch (error) {
    console.error("[Intent] Detection failed, defaulting to action:", error);
    return { intent: "action", confidence: 0.5 };
  }
}

export async function askQuestion(
  transcript: string,
  plansData: string,
  memoryData: string,
  language: string,
): Promise<string> {
  const lang =
    language === "ru" ? "Russian" : language === "kk" ? "Kazakh" : "English";
  try {
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `You are a personal AI assistant. You have access to all the user's plans and memory. Reply briefly, in ${lang}, like a smart assistant. Data: ${plansData} ${memoryData}`,
          },
          { role: "user", content: transcript },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      60000,
    );
    return response.choices[0]?.message?.content || "...";
  } catch (error) {
    console.error("[Intent] Question failed:", error);
    return "Error getting answer.";
  }
}

export async function chatReply(
  transcript: string,
  memoryData: string,
  language: string,
): Promise<string> {
  const lang =
    language === "ru" ? "Russian" : language === "kk" ? "Kazakh" : "English";
  try {
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `You are the user's personal AI assistant. Reply briefly and to the point in ${lang}. User context: ${memoryData}`,
          },
          { role: "user", content: transcript },
        ],
        temperature: 0.5,
        max_tokens: 500,
      }),
      60000,
    );
    return response.choices[0]?.message?.content || "...";
  } catch (error) {
    console.error("[Intent] Chat failed:", error);
    return "...";
  }
}

export interface RescheduleExtraction {
  task: string;
  newTime: string;
  date?: string;
}

export async function extractRescheduleInfo(
  transcript: string,
): Promise<RescheduleExtraction | null> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `Extract reschedule information. Today is ${dateStr}. Preserve foreign terms, acronyms, and brand names verbatim in the task description. Return ONLY JSON: { "task": "task description to find", "newTime": "HH:MM", "date": "YYYY-MM-DD or null if today" }`,
          },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      60000,
    );
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as RescheduleExtraction;
  } catch (error) {
    console.error("[Intent] Reschedule extraction failed:", error);
    return null;
  }
}

export interface DeleteExtraction {
  type: "task" | "day";
  task?: string;
  date?: string;
}

export async function extractDeleteInfo(
  transcript: string,
): Promise<DeleteExtraction | null> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `Extract delete information. Today is ${dateStr}. Preserve foreign terms, acronyms, and brand names verbatim in the task name. Return ONLY JSON: { "type": "task" | "day", "task": "task name if type=task", "date": "YYYY-MM-DD date to delete if type=day, or null" }`,
          },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      60000,
    );
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as DeleteExtraction;
  } catch (error) {
    console.error("[Intent] Delete extraction failed:", error);
    return null;
  }
}

export interface ViewExtraction {
  date?: string;
  period?: "today" | "tomorrow" | "week" | "month";
}

export async function extractViewInfo(
  transcript: string,
): Promise<ViewExtraction | null> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `Extract view/plans information. Today is ${dateStr}. Return ONLY JSON: { "date": "YYYY-MM-DD specific date or null", "period": "today" | "tomorrow" | "week" | "month" | null }`,
          },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      60000,
    );
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as ViewExtraction;
  } catch (error) {
    console.error("[Intent] View extraction failed:", error);
    return null;
  }
}

export interface ReportExtraction {
  target_date?: string;
  target_time?: string;
  after_time?: string;
  date_from?: string;
  date_to?: string;
  date_ranges?: DateRange[];
  period?: "today" | "tomorrow" | "week" | "month" | "all";
  priority_filter?: "high" | "medium" | "low";
  source?: TaskSource;
}

export async function extractReportInfo(
  transcript: string,
): Promise<ReportExtraction | null> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `Extract report filters from the user's message. Today is ${dateStr}. Return ONLY JSON: { "target_date": "YYYY-MM-DD or null", "target_time": "HH:MM or null (tasks before this time)", "after_time": "HH:MM or null (tasks after this time)", "date_from": "YYYY-MM-DD or null", "date_to": "YYYY-MM-DD or null", "date_ranges": [{"date": "YYYY-MM-DD", "beforeTime": "HH:MM or null", "afterTime": "HH:MM or null"}], "period": "today|tomorrow|week|month|all or null", "priority_filter": "high|medium|low or null", "source": "teams|telegram|voice|manual or null" }.
            Date/period examples: "на сегодня"/"бүгін"/"today" → period="today"; "на завтра"/"ертең"/"tomorrow" → period="tomorrow"; "на этой неделе"/"осы аптада"/"this week" → period="week"; "за этот месяц"/"бұл ай"/"this month" → period="month".
            Source examples: "from the team/Teams", "из Teams/команды", "Teams-тен" → "teams"; "from Telegram", "Telegram-дан" → "telegram"; "voice tasks", "дауыстық тапсырмалар" → "voice"; "manual", "қолмен қосылған" → "manual".
            Time examples: "до 17:00", "17:00-ға дейін", "before 17:00" → target_time="17:00"; "после 17:00", "17:00-ден кейін", "after 17:00" → after_time="17:00". `,
          },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      60000,
    );
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as ReportExtraction;
  } catch (error) {
    console.error("[Intent] Report extraction failed:", error);
    return null;
  }
}

export async function extractMemoryUpdate(
  transcript: string,
  currentMemory: string,
): Promise<string | null> {
  try {
    const response = await withTimeout(
      llm.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `You update the user's long-term memory based on their messages. Current memory: ${currentMemory}

Return ONLY JSON: { "should_update": boolean, "memory_update": { "habits": string[], "projects": string[], "preferences": Record<string,string>, "important_dates": string[], "patterns": Record<string,string>, "places": string[] } }

Only set should_update=true if there is genuinely new info worth remembering. Otherwise return {"should_update":false}.`,
          },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      60000,
    );
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return content;
  } catch (error) {
    console.error("[Intent] Memory update failed:", error);
    return null;
  }
}
