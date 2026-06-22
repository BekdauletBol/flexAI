import { config } from "../config.js";
import { TaskSource } from "../types/analysis.js";
import { getKzToday, getKzTomorrow } from './planStore.js';
import { getTemporalContext } from './userConfig.js';
import { DateTime } from 'luxon';
import { logger } from '../logger.js';
import { callLLM, withTimeout } from './llm-client.js';

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
    | "free_time_query"
    | "reminder"
    | "list_reminders"
    | "cancel_reminder";
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
  reminder_minutes?: number | null;
}

const SYSTEM_PROMPT = `Classify the user's message into ONE intent. Return ONLY this JSON.

INTENTS:
- "action" — new task/plan/schedule. User describes what they will/should/must do. "завтра в 10 должен", "нужно позвонить", "план на пятницу". Greeting + plan → ignore greeting.
- "query" — asking what tasks exist. "что у меня на завтра", "покажи план", "what's on my schedule"
- "report" — wants PDF/document/list of tasks. "отчёт", "покажи задачи", "send report", "скинь план"
- "reschedule" — move existing task. "перенеси встречу", "reschedule the meeting"
- "complete" — mark done. "выполнил", "сделал", "done"
- "delete" — remove task. "удали встречу", "cancel the meeting"
- "reminder" — remind at time offset. "напомни через 15 мин", "remind me in 1 hour". Extract reminder_minutes (number) and target_task (name or null).
- "list_reminders" — show active reminders. "покажи напоминания", "my reminders"
- "cancel_reminder" — cancel a reminder. "отмени напоминание о встрече". Extract target_task.
- "free_time_query" — asking WHEN free (a question, not a plan). "когда свободен", "find a gap", "есть ли время"
- "clear" — archive/done all. "очисти план", "clear plan"
- "social" — greeting/chat. "привет", "как дела"
- "summary" — daily summary. "итоги дня", "daily summary"

CRITICAL RULES:
1. "покажи задачи/план" → "report" (NOT "query", NOT "action")
2. Schedule/plan description → "action" even with greeting. "Привет, завтра в 10 план" → "action"
3. "напомни сделать X" (no time offset) → "action". "напомни через X [о task]" → "reminder"
4. "перерыв в 14:00" (stating a break time) → "action". "когда перерыв?" (asking) → "free_time_query"
5. For reschedule/complete/delete: extract target_task from the noun after the verb.
6. Set fields to null if they don't apply to the detected intent. Never fill fields that belong to other intents.

FIELDS PER INTENT (only populate these, set all others to null):
- "action": target_date, target_time ONLY. Do NOT set date_ranges, reminder_minutes, or filter fields.
- "report", "query": target_date, target_time, after_time, date_from, date_to, date_ranges, period, priority_filter, source_filter. Do NOT set reminder_minutes.
- "reminder": reminder_minutes, target_task ONLY. Do NOT set date_ranges or filter fields.
- "reschedule", "complete", "delete": target_task, target_date, target_time ONLY.
- "free_time_query": target_date ONLY.
- "cancel_reminder": target_task ONLY.
- "social", "clear", "summary", "list_reminders": no extra fields needed (all null).

{ "intent": "action|query|reschedule|delete|complete|report|clear|summary|social|free_time_query|reminder|list_reminders|cancel_reminder", "confidence": 0.0-1.0, "target_task": "string|null", "target_date": "YYYY-MM-DD|null", "target_time": "HH:MM|null", "after_time": "HH:MM|null", "date_from": "YYYY-MM-DD|null", "date_to": "YYYY-MM-DD|null", "date_ranges": [{"date":"YYYY-MM-DD","beforeTime":"HH:MM|null","afterTime":"HH:MM|null"}], "priority_filter": "high|medium|low|null", "source_filter": "teams|telegram|voice|manual|null", "reminder_minutes": "number|null" }`;

const MONTHS_RU: Record<string, number> = {
  'января': 1, 'январь': 1, 'февраля': 2, 'февраль': 2, 'марта': 3, 'март': 3,
  'апреля': 4, 'апрель': 4, 'мая': 5, 'май': 5, 'июня': 6, 'июнь': 6,
  'июля': 7, 'июль': 7, 'августа': 8, 'август': 8, 'сентября': 9, 'сентябрь': 9,
  'октября': 10, 'октябрь': 10, 'ноября': 11, 'ноябрь': 11, 'декабря': 12, 'декабрь': 12,
};

const MONTHS_KK: Record<string, number> = {
  'қаңтар': 1, 'ақпан': 2, 'наурыз': 3, 'сәуір': 4, 'мамыр': 5, 'маусым': 6,
  'шілде': 7, 'тамыз': 8, 'қыркүйек': 9, 'қазан': 10, 'қараша': 11, 'желтоқсан': 12,
};

const MONTHS_EN: Record<string, number> = {
  'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5, 'june': 6,
  'july': 7, 'august': 8, 'september': 9, 'october': 10, 'november': 11, 'december': 12,
};

const WEEKDAYS_RU: Record<string, number> = {
  'понедельник': 1, 'вторник': 2, 'среду': 3, 'среда': 3, 'четверг': 4,
  'пятницу': 5, 'пятница': 5, 'субботу': 6, 'суббота': 6, 'воскресенье': 0, 'воскресенья': 0,
};

const WEEKDAYS_KK: Record<string, number> = {
  'дүйсенбі': 1, 'сейсенбі': 2, 'сәрсенбі': 3, 'бейсенбі': 4,
  'жұма': 5, 'сенбі': 6, 'жексенбі': 0,
};

const WEEKDAYS_EN: Record<string, number> = {
  'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4,
  'friday': 5, 'saturday': 6, 'sunday': 0,
};

function formatKzDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseTargetDateFromText(text: string): string | null {
  const lower = text.toLowerCase();

  const ddmmyyyy = lower.match(/(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?/);
  if (ddmmyyyy) {
    const day = parseInt(ddmmyyyy[1], 10);
    const month = parseInt(ddmmyyyy[2], 10);
    let year = ddmmyyyy[3] ? parseInt(ddmmyyyy[3], 10) : DateTime.now().setZone('Asia/Almaty').year;
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatKzDate(year, month, day);
    }
  }

  const dayMonth = lower.match(/(\d{1,2})\s+([а-яёa-z]+)/);
  if (dayMonth) {
    const day = parseInt(dayMonth[1], 10);
    const monthWord = dayMonth[2];
    const month = MONTHS_RU[monthWord] || MONTHS_KK[monthWord] || MONTHS_EN[monthWord];
    if (month) {
      const year = DateTime.now().setZone('Asia/Almaty').year;
      return formatKzDate(year, month, day);
    }
  }

  for (const [word, dow] of Object.entries({ ...WEEKDAYS_RU, ...WEEKDAYS_KK, ...WEEKDAYS_EN })) {
    if (lower.includes(word)) {
      const kzNow = DateTime.now().setZone('Asia/Almaty');
      const currentDow = kzNow.weekday % 7; // luxon weekday: 1=Mon..7=Sun, JS: 0=Sun..6=Sat
      let diff = dow - currentDow;
      if (diff <= 0) diff += 7;
      const target = kzNow.plus({ days: diff });
      return target.toFormat('yyyy-MM-dd');
    }
  }

  return null;
}

function detectFreeTimeQuery(transcript: string): Partial<IntentResult> | null {
  const lower = transcript.toLowerCase();
  // Only trigger on explicit availability QUESTIONS, not plan descriptions
  const isFreeTimeQuestion =
    /когда\s*(я\s*)?(свободен|буду свободен|есть время|можно)|есть\s*ли\s*время|найди\s*(окно|свободное)|свободное\s*время\s*(сегодня|завтра|в)|when\s*am\s*i\s*free|do\s*i\s*have\s*time/.test(lower) &&
    !/у меня (есть |)план|должен|планирую|сделаю|запиши|добавь/.test(lower);

  if (!isFreeTimeQuestion) return null;

  const targetDate = parseTargetDateFromText(transcript) || getKzToday();
  logger.debug({ targetDate }, '[Intent] Quick override → free_time_query');
  return { intent: 'free_time_query', confidence: 1.0, target_date: targetDate };
}

function detectReminderIntent(
  lower: string,
): Partial<IntentResult> | null {
  // === Compound intent: time/event + reminder → "action" (not "reminder") ===
  // If the transcript mentions BOTH a scheduled event AND a reminder request,
  // classify as "action" so the full analysis pipeline extracts the task properly.
  const hasReminder = /напомни|remind|предупреди|скажи\s+мне\s+через|напомнить/i.test(lower);
  if (hasReminder) {
    const hasTimeEvent = /в\s+\d{1,2}[:.]\d{2}|at\s+\d{1,2}[:.]\d{2}|будет|планирую|должен|scheduled|supposed\s+to|have\s+.*\d{1,2}[:.]\d{2}/i.test(lower);
    if (hasTimeEvent) {
      logger.debug('[Intent] Compound intent detected (event + reminder) → action');
      return { intent: 'action', confidence: 1.0 };
    }
  }
  // === Pattern 1: "напомни за X минут/час(ов) до [task]" ===
  const ruBefore = /напомни\s+за\s+(\d+)\s+(минут(?:у|ы|а)?|час(?:а|ов|ы)?|полчаса)\s+до\s+(.+)$/i;
  const ruBeforeMatch = lower.match(ruBefore);
  if (ruBeforeMatch) {
    let minutes = parseInt(ruBeforeMatch[1], 10);
    const unit = ruBeforeMatch[2].toLowerCase();
    if (unit.startsWith("час")) minutes *= 60;
    else if (unit === "полчаса") minutes = 30;
    const targetTask = ruBeforeMatch[3].trim();
    logger.debug({ minutes, targetTask }, '[Intent] Quick override → reminder');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes, target_task: targetTask };
  }

  // === Pattern 2: "напомни через X минут/час(ов) [task]" (free reminder) ===
  const ruThrough = /напомни\s+через\s+(\d+)\s+(минут(?:у|ы|а)?|час(?:а|ов|ы)?|полчаса)(?:\s+(.+))?$/i;
  const ruThroughMatch = lower.match(ruThrough);
  if (ruThroughMatch) {
    let minutes = parseInt(ruThroughMatch[1], 10);
    const unit = ruThroughMatch[2].toLowerCase();
    if (unit.startsWith("час")) minutes *= 60;
    else if (unit === "полчаса") minutes = 30;
    const targetTask = ruThroughMatch[3]?.trim() || null;
    logger.debug({ minutes, targetTask }, '[Intent] Quick override → reminder (free)');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes, target_task: targetTask || undefined };
  }

  // === Pattern 3: "скажи мне через X минут/час(ов)" (free reminder) ===
  const ruSay = /скажи\s+(?:мне\s+)?через\s+(\d+)\s+(минут(?:у|ы|а)?|час(?:а|ов|ы)?|полчаса)/i;
  const ruSayMatch = lower.match(ruSay);
  if (ruSayMatch) {
    let minutes = parseInt(ruSayMatch[1], 10);
    const unit = ruSayMatch[2].toLowerCase();
    if (unit.startsWith("час")) minutes *= 60;
    else if (unit === "полчаса") minutes = 30;
    logger.debug({ minutes }, '[Intent] Quick override → reminder (free)');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes };
  }

  // === Pattern 4: "предупреди за X минут/час(ов) [task]" ===
  const ruWarn = /предупреди\s+за\s+(\d+)\s+(минут(?:у|ы|а)?|час(?:а|ов|ы)?|полчаса)(?:\s+до\s+(.+))?$/i;
  const ruWarnMatch = lower.match(ruWarn);
  if (ruWarnMatch) {
    let minutes = parseInt(ruWarnMatch[1], 10);
    const unit = ruWarnMatch[2].toLowerCase();
    if (unit.startsWith("час")) minutes *= 60;
    else if (unit === "полчаса") minutes = 30;
    const targetTask = ruWarnMatch[3]?.trim() || null;
    logger.debug({ minutes, targetTask }, '[Intent] Quick override → reminder');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes, target_task: targetTask || undefined };
  }

  // === Pattern 5: "поставь напоминание через X минут/час(ов)" ===
  const ruSet = /поставь\s+напоминание\s+через\s+(\d+)\s+(минут(?:у|ы|а)?|час(?:а|ов|ы)?|полчаса)/i;
  const ruSetMatch = lower.match(ruSet);
  if (ruSetMatch) {
    let minutes = parseInt(ruSetMatch[1], 10);
    const unit = ruSetMatch[2].toLowerCase();
    if (unit.startsWith("час")) minutes *= 60;
    else if (unit === "полчаса") minutes = 30;
    logger.debug({ minutes }, '[Intent] Quick override → reminder (free)');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes };
  }

  // === Pattern 6: "напомни про [task] за X минут" ===
  const ruAbout = /напомни\s+про\s+(.+?)\s+за\s+(\d+)\s+(минут(?:у|ы|а)?|час(?:а|ов|ы)?|полчаса)/i;
  const ruAboutMatch = lower.match(ruAbout);
  if (ruAboutMatch) {
    const targetTask = ruAboutMatch[1].trim();
    let minutes = parseInt(ruAboutMatch[2], 10);
    const unit = ruAboutMatch[3].toLowerCase();
    if (unit.startsWith("час")) minutes *= 60;
    else if (unit === "полчаса") minutes = 30;
    logger.debug({ minutes, targetTask }, '[Intent] Quick override → reminder');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes, target_task: targetTask };
  }

  // === Pattern 7: English "remind me in X min/minutes" (free reminder) ===
  const enIn = /remind\s+me\s+in\s+(\d+)\s+min(?:ute)?s?/i;
  const enInMatch = lower.match(enIn);
  if (enInMatch) {
    const minutes = parseInt(enInMatch[1], 10);
    logger.debug({ minutes }, '[Intent] Quick override → reminder (free)');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes };
  }

  // === Pattern 8: English "remind me about [task] in X min" ===
  const enAboutIn = /remind\s+me\s+about\s+(.+?)\s+in\s+(\d+)\s+min(?:ute)?s?/i;
  const enAboutInMatch = lower.match(enAboutIn);
  if (enAboutInMatch) {
    const targetTask = enAboutInMatch[1].trim();
    const minutes = parseInt(enAboutInMatch[2], 10);
    logger.debug({ minutes, targetTask }, '[Intent] Quick override → reminder');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes, target_task: targetTask };
  }

  // === Pattern 9: English "remind me about [task] X min before" ===
  const enBefore = /remind\s+me\s+about\s+(.+?)\s+(\d+)\s+min(?:ute)?s?\s+before/i;
  const enBeforeMatch = lower.match(enBefore);
  if (enBeforeMatch) {
    const targetTask = enBeforeMatch[1].trim();
    const minutes = parseInt(enBeforeMatch[2], 10);
    logger.debug({ minutes, targetTask }, '[Intent] Quick override → reminder');
    return { intent: 'reminder', confidence: 1.0, reminder_minutes: minutes, target_task: targetTask };
  }

  // === Pattern 10: "напомни" without time (will prompt for time) ===
  if (/^напомни$/i.test(lower.trim())) {
    logger.debug('[Intent] Quick override → reminder (no time)');
    return { intent: 'reminder', confidence: 0.8, reminder_minutes: 0 };
  }

  return null;
}

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

  const freeTime = detectFreeTimeQuery(transcript);
  if (freeTime) return freeTime;

  // === REMINDER (fast path — "напомни за X минут/часов до [task]") ===
  const reminderMatch = detectReminderIntent(lower);
  if (reminderMatch) return reminderMatch;

  // === LIST_REMINDERS (fast path) ===
  const listRemindersPatterns = [
    /покажи\s+(?:мои\s+)?напоминания/i,
    /какие\s+напоминания/i,
    /список\s+напоминаний/i,
    /мои\s+напоминания/i,
    /show\s+(?:my\s+)?reminders/i,
    /list\s+(?:my\s+)?reminders/i,
    /what\s+reminders/i,
    /менің\s+еске\s+салуларым/i,
    /қандай\s+еске\s+салулар/i,
  ];
  if (listRemindersPatterns.some(p => p.test(lower))) {
    logger.debug('[Intent] Quick override → list_reminders');
    return { intent: 'list_reminders', confidence: 1.0 };
  }

  // === CANCEL_REMINDER (fast path) ===
  const cancelReminderMatch = lower.match(
    /(?:отмени|удали|убери|отменить|болдырма|өшір|жой)\s+напоминание(?:\s+(?:о|про|about)\s+(.+))?$/i
  ) || lower.match(
    /напоминание\s+(?:о|про)\s+(.+?)\s+(?:отмени|удали|убери|отменить)/i
  );
  if (cancelReminderMatch) {
    const targetTask = cancelReminderMatch[1]?.trim() || null;
    logger.debug({ targetTask }, '[Intent] Quick override → cancel_reminder');
    return { intent: 'cancel_reminder', confidence: 1.0, target_task: targetTask || undefined };
  }

  const reportWords = [
    "отчёт",
    "репорт",
    "отчет",
    "скинь задачи",
    "покажи задачи",
    "скинь план",
    "покажи план",
    "планы на",
    "план на",
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
      logger.debug("[Intent] Quick override → query");
      return { intent: "query", confidence: 1.0 };
    }
    return null;
  }

  // Report intent confirmed. Resolve date context from transcript using luxon.
  logger.debug({ transcript }, '[Report Override] transcript');
  const now = DateTime.now().setZone('Asia/Almaty')

  // WEEK RANGES (loose regex — handles Whisper transcription noise)
  if (/эт\w*\s*недел|текущ\w*\s*недел|за\s*недел/.test(lower)) {
    logger.debug('[Intent] Quick override → report this week');
    return { intent: 'report', confidence: 1, date_from: now.startOf('week').toISODate()!, date_to: now.endOf('week').toISODate()! };
  }
  if (/прошл\w*\s*недел|прошедш\w*\s*недел/.test(lower)) {
    const last = now.minus({ weeks: 1 });
    logger.debug('[Intent] Quick override → report last week');
    return { intent: 'report', confidence: 1, date_from: last.startOf('week').toISODate()!, date_to: last.endOf('week').toISODate()! };
  }

  // RELATIVE DAYS (loose regex)
  if (/вчер\w*/.test(lower)) {
    logger.debug('[Intent] Quick override → report yesterday');
    return { intent: 'report', confidence: 1, target_date: now.minus({ days: 1 }).toISODate()! };
  }
  if (/позавчер\w*/.test(lower)) {
    logger.debug('[Intent] Quick override → report day-before-yesterday');
    return { intent: 'report', confidence: 1, target_date: now.minus({ days: 2 }).toISODate()! };
  }
  if (/сегодня|бугин|сейча/.test(lower) || !/недел|вчер|понедел|вторник|среду|четверг|пятниц|суббот|воскресен|\d{1,2}\s?(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/.test(lower)) {
    logger.debug('[Intent] Quick override → report today');
    return { intent: 'report', confidence: 1, target_date: now.toISODate()! };
  }

  // WEEKDAYS — find most recent past occurrence (loose regex)
  const weekdays: Array<[RegExp, number]> = [
    [/понедел/, 1], [/вторник/, 2], [/сред[уа]/, 3],
    [/четверг/, 4], [/пятниц/, 5], [/суббот/, 6], [/воскресен/, 7]
  ];
  for (const [re, dayNum] of weekdays) {
    if (re.test(lower)) {
      let target = now.set({ weekday: dayNum as 1 | 2 | 3 | 4 | 5 | 6 | 7 });
      if (target > now) target = target.minus({ weeks: 1 });
      logger.debug({ weekday: re.source }, '[Intent] Quick override → report weekday match');
      return { intent: 'report', confidence: 1, target_date: target.toISODate()! };
    }
  }

  // SPECIFIC DATE e.g. «16 июня» (loose month regex)
  const months: Record<string, number> = {
    'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4,
    'мая': 5, 'июн': 6, 'июл': 7, 'август': 8,
    'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12
  };
  const dateMatch = lower.match(/(\d{1,2})\s?(январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1]);
    const month = months[dateMatch[2]];
    const target = now.set({ month, day });
    logger.debug({ targetDate: target.toISODate() }, '[Intent] Quick override → report specific date');
    return { intent: 'report', confidence: 1, target_date: target.toISODate()! };
  }

  // DEFAULT: today
  logger.debug('[Intent] Quick override → report (default today)');
  return {
    intent: 'report',
    confidence: 1.0,
    target_date: now.toISODate()!,
  };
}

function sanitizeIntentResult(result: IntentResult): void {
  const intent = result.intent;
  // action: keep target_date, target_time only — strip filter/reminder fields
  if (intent === 'action') {
    result.reminder_minutes = null;
    result.date_ranges = undefined;
    result.date_from = undefined;
    result.date_to = undefined;
    result.after_time = undefined;
    result.priority_filter = undefined;
    result.source_filter = undefined;
    result.period = undefined;
  }
  // report/query: keep filter fields — strip reminder_minutes
  else if (intent === 'report' || intent === 'query') {
    result.reminder_minutes = null;
  }
  // reminder: keep reminder_minutes and target_task — strip filter fields
  else if (intent === 'reminder') {
    result.date_ranges = undefined;
    result.date_from = undefined;
    result.date_to = undefined;
    result.after_time = undefined;
    result.priority_filter = undefined;
    result.source_filter = undefined;
    result.period = undefined;
  }
  // reschedule/complete/delete: keep target_task, target_date, target_time only
  else if (intent === 'reschedule' || intent === 'complete' || intent === 'delete') {
    result.reminder_minutes = null;
    result.date_ranges = undefined;
    result.date_from = undefined;
    result.date_to = undefined;
    result.after_time = undefined;
    result.priority_filter = undefined;
    result.source_filter = undefined;
    result.period = undefined;
  }
  // social/clear/summary/free_time_query/list_reminders/cancel_reminder: minimal fields
  else {
    result.reminder_minutes = null;
    result.date_ranges = undefined;
    result.date_from = undefined;
    result.date_to = undefined;
    result.after_time = undefined;
    result.target_time = undefined;
    result.priority_filter = undefined;
    result.source_filter = undefined;
    result.period = undefined;
  }
}

export async function detectIntent(transcript: string, userId?: number): Promise<IntentResult> {
  logger.debug("[Intent] Starting detectIntent");

  // Get user-specific temporal context
  const temporal = getTemporalContext(userId || 0);
  const localDt = DateTime.fromISO(temporal.localISO, { zone: temporal.timezone });
  const dayOfWeek = localDt.toFormat('cccc');
  const monthDay = localDt.toFormat('MMMM d');
  const year = localDt.year;

  const systemPromptWithDate = `Today is ${dayOfWeek}, ${monthDay}, ${year} in ${temporal.timezone}. Current local time: ${temporal.localTime}. Today's date: ${temporal.localDate}.\n\n${SYSTEM_PROMPT}`;

  logger.debug('[Intent Prompt] %s', systemPromptWithDate);

  const messages = [
    { role: "system" as const, content: systemPromptWithDate },
    { role: "user" as const, content: transcript },
  ];

  // Retry loop with backoff on 429
  let attempts = 0;
  while (attempts < 3) {
    try {
      const { content, provider, model } = await callLLM(messages, {
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 500,
        timeout: 60000,
      });

      logger.debug({ provider, model }, "[Intent] Got response");
      logger.debug({ content }, "[Intent] Response content");
      const result = JSON.parse(content) as IntentResult;
      result.intent = result.intent || "action";
      result.confidence = result.confidence || 0.5;
      sanitizeIntentResult(result);

      logger.debug(
        `[Intent] "${result.intent}" (${(result.confidence * 100).toFixed(0)}%)`,
      );
      return result;
    } catch (error: any) {
      const is429 = error?.status === 429 || error?.message?.includes('429');
      if (is429 && attempts < 2) {
        const wait = (attempts + 1) * 10000;
        logger.warn(`[Intent] Rate limited, retrying in ${wait / 1000}s... (attempt ${attempts + 1}/3)`);
        await new Promise(r => setTimeout(r, wait));
        attempts++;
        continue;
      }
      logger.error(`[Intent] Failed (attempt ${attempts + 1}/3):`, error?.message || error);
      break;
    }
  }

  // Fallback to gpt-4.1 via GitHub token
  if (config.openaiModel !== 'gpt-4.1') {
    logger.debug('[Intent] Falling back to gpt-4.1 for intent detection');
    try {
      const { content } = await callLLM(messages, {
        preferGitHub: true,
        fallbackModel: 'gpt-4.1',
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 500,
        timeout: 60000,
      });

      logger.debug({ content }, "[Intent] Fallback response");
      const result = JSON.parse(content) as IntentResult;
      result.intent = result.intent || "action";
      result.confidence = result.confidence || 0.5;
      sanitizeIntentResult(result);

      logger.debug(
        `[Intent] fallback "${result.intent}" (${(result.confidence * 100).toFixed(0)}%)`,
      );
      return result;
    } catch (fallbackError) {
      logger.error({ err: fallbackError }, "[Intent] Fallback also failed");
    }
  }

  return { intent: "action", confidence: 0.5 };
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
    const { content } = await callLLM([
      {
        role: "system",
        content: `You are a personal AI assistant. You have access to all the user's plans and memory. Reply briefly, in ${lang}, like a smart assistant. Data: ${plansData} ${memoryData}`,
      },
      { role: "user", content: transcript },
    ], {
      temperature: 0.3,
      max_tokens: 500,
      timeout: 60000,
    });
    return content || "...";
  } catch (error) {
    logger.error({ err: error }, "[Intent] Question failed");
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
    const { content } = await callLLM([
      {
        role: "system",
        content: `You are the user's personal AI assistant. Reply briefly and to the point in ${lang}. User context: ${memoryData}`,
      },
      { role: "user", content: transcript },
    ], {
      temperature: 0.5,
      max_tokens: 500,
      timeout: 60000,
    });
    return content || "...";
  } catch (error) {
    logger.error({ err: error }, "[Intent] Chat failed");
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
  userId?: number,
): Promise<RescheduleExtraction | null> {
  try {
    const temporal = getTemporalContext(userId || 0);
    const localDt = DateTime.fromISO(temporal.localISO, { zone: temporal.timezone });
    const dayOfWeek = localDt.toFormat('cccc');
    const monthDay = localDt.toFormat('MMMM d');
    const year = localDt.year;

    const { content } = await callLLM([
      {
        role: "system",
        content: `Extract reschedule information. Today is ${dayOfWeek}, ${monthDay}, ${year} (${temporal.timezone}). Current time: ${temporal.localTime}. Today's date: ${temporal.localDate}. Preserve foreign terms, acronyms, and brand names verbatim in the task description. Return ONLY JSON: { "task": "task description to find", "newTime": "HH:MM", "date": "YYYY-MM-DD or null if today" }`,
      },
      { role: "user", content: transcript },
    ], {
      response_format: { type: "json_object" },
      temperature: 0.1,
      timeout: 60000,
    });
    if (!content) return null;
    return JSON.parse(content) as RescheduleExtraction;
  } catch (error) {
    logger.error({ err: error }, "[Intent] Reschedule extraction failed");
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
  userId?: number,
): Promise<DeleteExtraction | null> {
  try {
    const temporal = getTemporalContext(userId || 0);
    const localDt = DateTime.fromISO(temporal.localISO, { zone: temporal.timezone });
    const dayOfWeek = localDt.toFormat('cccc');
    const monthDay = localDt.toFormat('MMMM d');
    const year = localDt.year;

    const { content } = await callLLM([
      {
        role: "system",
        content: `Extract delete information. Today is ${dayOfWeek}, ${monthDay}, ${year} (${temporal.timezone}). Current date: ${temporal.localDate}. Preserve foreign terms, acronyms, and brand names verbatim in the task name. Return ONLY JSON: { "type": "task" | "day", "task": "task name if type=task", "date": "YYYY-MM-DD date to delete if type=day, or null" }`,
      },
      { role: "user", content: transcript },
    ], {
      response_format: { type: "json_object" },
      temperature: 0.1,
      timeout: 60000,
    });
    if (!content) return null;
    return JSON.parse(content) as DeleteExtraction;
  } catch (error) {
    logger.error({ err: error }, "[Intent] Delete extraction failed");
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
    const now = DateTime.now().setZone('Asia/Almaty');
    const dateStr = now.toFormat('cccc, MMMM d, yyyy');
    const { content } = await callLLM([
      {
        role: "system",
        content: `Extract view/plans information. Today is ${dateStr}. Return ONLY JSON: { "date": "YYYY-MM-DD specific date or null", "period": "today" | "tomorrow" | "week" | "month" | null }`,
      },
      { role: "user", content: transcript },
    ], {
      response_format: { type: "json_object" },
      temperature: 0.1,
      timeout: 60000,
    });
    if (!content) return null;
    return JSON.parse(content) as ViewExtraction;
  } catch (error) {
    logger.error({ err: error }, "[Intent] View extraction failed");
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
  userId?: number,
): Promise<ReportExtraction | null> {
  try {
    const temporal = getTemporalContext(userId || 0);
    const localDt = DateTime.fromISO(temporal.localISO, { zone: temporal.timezone });
    const dayOfWeek = localDt.toFormat('cccc');
    const monthDay = localDt.toFormat('MMMM d');
    const year = localDt.year;

    const { content } = await callLLM([
      {
        role: "system",
        content: `Extract report filters from the user's message. Today is ${dayOfWeek}, ${monthDay}, ${year} (${temporal.timezone}). Current local time: ${temporal.localTime}. Today's date: ${temporal.localDate}. All dates must be in YYYY-MM-DD format in the user's local timezone. Return ONLY JSON: { "target_date": "YYYY-MM-DD or null", "target_time": "HH:MM or null (tasks before this time)", "after_time": "HH:MM or null (tasks after this time)", "date_from": "YYYY-MM-DD or null", "date_to": "YYYY-MM-DD or null", "date_ranges": [{"date": "YYYY-MM-DD", "beforeTime": "HH:MM or null", "afterTime": "HH:MM or null"}], "period": "today|tomorrow|week|month|all or null", "priority_filter": "high|medium|low or null", "source": "teams|telegram|voice|manual or null" }.
            Date/period examples: "на сегодня"/"бүгін"/"today" → period="today"; "на завтра"/"ертең"/"tomorrow" → period="tomorrow"; "отчёт на 16 июня"/"планы на завтра" → target_date="YYYY-MM-DD"; "на этой неделе"/"осы аптада"/"this week" → period="week"; "за этот месяц"/"бұл ай"/"this month" → period="month".
            If user asks for a report without specifying a date, set period="today".
            Source examples: "from the team/Teams", "из Teams/команды", "Teams-тен" → "teams"; "from Telegram", "Telegram-дан" → "telegram"; "voice tasks", "дауыстық тапсырмалар" → "voice"; "manual", "қолмен қосылған" → "manual".
            Time examples: "до 17:00", "17:00-ға дейін", "before 17:00" → target_time="17:00"; "после 17:00", "17:00-ден кейін", "after 17:00" → after_time="17:00". `,
      },
      { role: "user", content: transcript },
    ], {
      response_format: { type: "json_object" },
      temperature: 0.1,
      timeout: 60000,
    });
    if (!content) return null;
    return JSON.parse(content) as ReportExtraction;
  } catch (error) {
    logger.error({ err: error }, "[Intent] Report extraction failed");
    return null;
  }
}

export async function extractMemoryUpdate(
  transcript: string,
  currentMemory: string,
): Promise<string | null> {
  try {
    const { content } = await callLLM([
      {
        role: "system",
        content: `You update the user's long-term memory based on their messages. Current memory: ${currentMemory}

Return ONLY JSON: { "should_update": boolean, "memory_update": { "habits": string[], "projects": string[], "preferences": Record<string,string>, "important_dates": string[], "patterns": Record<string,string>, "places": string[] } }

Only set should_update=true if there is genuinely new info worth remembering. Otherwise return {"should_update":false}.`,
      },
      { role: "user", content: transcript },
    ], {
      response_format: { type: "json_object" },
      temperature: 0.2,
      timeout: 60000,
    });
    if (!content) return null;
    return content;
  } catch (error) {
    logger.error({ err: error }, "[Intent] Memory update failed");
    return null;
  }
}
