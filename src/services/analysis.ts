import { config } from '../config.js';
import { AnalysisResult } from '../types/analysis.js';
import { v4 as uuid } from 'uuid';
import { getTemporalContext } from './userConfig.js';
import { DateTime } from 'luxon';
import { KZ_ZONE } from '../utils/timezone.js';
import { getTasksForDate } from './db.js';
import { getKzToday } from '../utils/timezone.js';
import { getUserMemory } from './memoryStore.js';
import { logger } from '../logger.js';
import { callLLM } from './llm-client.js';

// Use OpenAI/GitHub Models for analysis because structured JSON extraction is more reliable
// than Groq's Llama models on complex multilingual transcripts.

function cleanJsonContent(content: string): string {
  // Strip markdown code fences and trailing/leading whitespace
  return content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function safeJsonParse(content: string): any | null {
  const cleaned = cleanJsonContent(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find the first JSON object in the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { return null; }
    }
    return null;
  }
}

/**
 * Calculate a future date from a YYYY-MM-DD base date.
 * @param baseDate - "YYYY-MM-DD" in user's local timezone
 * @param daysOffset - number of days to add
 * @returns "YYYY-MM-DD" string
 */
function getNextDate(baseDate: string, daysOffset: number): string {
  return DateTime.fromISO(baseDate, { zone: KZ_ZONE })
    .plus({ days: daysOffset })
    .toFormat('yyyy-MM-dd');
}

/** Build schedule context block for the AI prompt so it knows existing tasks */
function buildScheduleContextForPrompt(userId: number, todayDate: string): string {
  try {
    const todayTasks = getTasksForDate(userId, todayDate);
    if (todayTasks.length === 0) {
      return `User's schedule today (${todayDate}): (empty)\nConflicts today: 0`;
    }
    const taskLines = todayTasks.map((t: any) => {
      const time = t.time || '—:——';
      const src = t.source || 'manual';
      return `- ${t.task} at ${time} (${src})`;
    }).join('\n');
    return `User's schedule today (${todayDate}):\n${taskLines}\nConflicts today: ${todayTasks.length}`;
  } catch {
    return '';
  }
}

/** Build patterns context block from user's known recurring habits */
function buildPatternsContextForPrompt(userId: number): string {
  try {
    const patterns = getUserMemory(userId).patterns;
    const entries = Object.entries(patterns).filter(([, v]) => v);
    if (entries.length === 0) return '';

    const lines = entries.map(([key, val]) => {
      const label = key.replace(/_/g, ' ');
      return `- ${label}: ${val}`;
    }).join('\n');

    return `\nUser's known daily patterns (for reference only — do NOT use to fill missing times):\n${lines}\n`;
  } catch {
    return '';
  }
}

const SYSTEM_PROMPT = `You are an expert assistant for analyzing voice notes.

LANGUAGE RULE (critical):
- Russian transcript → respond in Russian
- English transcript → respond in English
- Kazakh transcript → respond in Kazakh
- Mixed → use the dominant language

PRESERVE FOREIGN TERMS (critical):
- Keep acronyms, brand names, product names, and English technical terms exactly as spoken.
- Examples: "CJM customer journey map", "UX review", "API integration", "Zoom call", "Notion", "Figma", "MVP", "KPI".
- Do NOT translate these into Russian or Kazakh. Write them verbatim in the task description.
- If the user says "сделать CJM customer journey map", the task must be "Сделать CJM customer journey map".

TIMEZONE RULE (critical):
- You will receive the user's LOCAL time and timezone in the CONTEXT section below.
- ALL times the user mentions ("в 12:00", "at 3pm", "сағат 15:00") are in their LOCAL time.
- When extracting dates/times, use the LOCAL time provided. Do NOT convert or shift.
- Store dates as "YYYY-MM-DD" and times as "HH:MM" in the user's local timezone.
- "tomorrow" means the next calendar day in the user's LOCAL timezone.

STRICT TIME EXTRACTION RULES (critical — never guess):
- Extract ONLY times the user explicitly stated with numbers + am/pm/час/утра/вечера
- "в 3" → no time (3 could mean anything). "в 15:00" → "15:00". "at 3pm" → "15:00". "в 8 утра" → "08:00".
- If no explicit time stated for a task → set "time": null. NO exceptions.
- NEVER infer time from context like "after lunch", "вечером", "после работы", "утром".
- NEVER use memory patterns to fill missing times.
- NEVER assign a time from one task to another.
- If user says "созвон в 11:00 и встреча" → only "созвон" gets time 11:00, "встреча" gets null.
- "через час" → set time to null (relative offset is handled separately, not as an absolute time).

TASK TITLE RULES (critical):
- Task title must be clean. Remove reminder prefixes:
  - "напомнить о встрече" → "Встреча"
  - "напомни про звонок" → "Звонок"
  - "напомнить сделать X" → "X"
  - "remind me about meeting" → "Meeting"
  - "remind me to do X" → "X"
- Never create a separate task for the reminder itself.

DURATION RULES:
- If user mentions a time range ("с 9 до 9:30", "from 9 to 9:30", "9:00-9:30"), calculate duration_minutes from the range.
- "с 9 до 9:30" → time: "09:00", duration: 30
- "с 14:00 до 15:00" → time: "14:00", duration: 60

TIME ASSIGNMENT RULES:
- Never assign the same time to two different tasks. If the user lists multiple tasks at different times, each gets its own time.
- If two tasks would have the same time, shift the second by duration_minutes of the first.
- Preserve the exact order of tasks as the user mentioned them.

Return ONLY a JSON object in this EXACT format:
{
  "title": "Short title (5-7 words)",
  "summary": "2-3 sentence summary",
  "key_points": ["point 1", "point 2"],
  "todos": [
    { "task": "Task description", "priority": "high", "done": false, "time": "15:00", "date": "2026-05-29", "duration": 30, "location": "Place name or null", "reminder_minutes": null }
  ],
  "tags": ["#tag1", "#tag2"],
  "raw_transcript": "original transcript unchanged",
  "language": "ru",
  "timeframe": "day",
  "periodStart": "2026-06-01",
  "periodEnd": "2026-06-30",
  "location_query": "ЦУМ Астана or null",
  "visit_datetime": "2026-05-29T14:00:00 or null",
  "needs_location_check": false
}

TIMEFRAME DETECTION:
- Detect the planning horizon from the transcript:
  - "day": daily tasks, today's agenda, "сегодня", "будни", "бүгін"
  - "week": this week's plan, "этой неделей", "расписание на неделю", "осы апта"
  - "month": monthly goals, "в этом месяце", "June goals", "осы айда", monthly budget
  - "year": yearly goals, "в этом году", "2026 goals", "yearly plan", "биылғы жыл"
- Set "timeframe" to the detected value. Default to "day".
- Set "periodStart" and "periodEnd" as ISO date boundaries if relevant (e.g. month start to month end).

TIME EXTRACTION:
- If the user mentions a specific time, extract as "time" in "HH:MM" 24h format.
- If no time or unknown time → set "time" to null (do NOT use "00:00").
- Parse smartly: "3pm"="15:00", "half past 2"="14:30", "в 8 утра"="08:00".
- "duration": estimated task duration in minutes (default 30).
- "datetime": ISO datetime "YYYY-MM-DDTHH:MM:00" combining the task's "date" and "time". Set null if no time is given.

DATE EXTRACTION:
- Use the LOCAL DATE from the CONTEXT section as "today".
- "today" → the LOCAL DATE from context
- "tomorrow" → next calendar day after the LOCAL DATE
- "next Friday" → resolve to absolute ISO string based on the LOCAL DATE
- If no date mentioned → set "date" to null.

PRIORITY RULES (apply strictly):
- "high": "срочно", "обязательно", "до [date]", "urgent", "asap", "must", "важно", "маңызды", "шұғыл"
- "medium": "хочу", "планирую", "надо бы", "want to", "planning to", "need to", "керек"
- "low": "возможно", "когда-нибудь", "maybe", "someday", "мүмкін", "бір кезде"
- Default to "medium" when no clear signal.

LOCATION EXTRACTION:
- If user mentions visiting a specific place + time, set location_query (place name), visit_datetime (ISO), needs_location_check: true.
- If task mentions a place name, set "location" on that todo item.
- If no place → set all location fields to null.

SUBTASK EXTRACTION:
If the user describes multiple sub-items within one activity (e.g. "meetings: 11:20 Абай, 12:00 Хасые"), extract EACH as a separate todo with its own time.
Do not collapse multiple named items into one task.
Example input: "с 11.20 Абай, в 12 Хасые, в 12.40 Ворк"
Example output:
  { "task": "Встреча с Абай", "time": "11:20" }
  { "task": "Встреча с Хасые", "time": "12:00" }
  { "task": "Встреча с Ворк", "time": "12:40" }

COMPOUND REMINDER RULE (critical):
If the user mentions a task/event AND says "remind me in X minutes/hours" (e.g. "у меня в 17.20 будет гольф, напомни через 10 минут" or "I have golf at 5:20pm, remind me in 10 minutes"), extract EXACTLY ONE todo object where:
- "task": the actual task description (e.g. "Гольф" / "Golf")
- "time": the event time (e.g. "17:20")
- "reminder_minutes": the user's specified offset (e.g. 10). Set to null if user said nothing about reminders.
- Do NOT create a second todo for the reminder itself.
- The reminder_minutes field tells the system to send a reminder X minutes BEFORE the scheduled time.

REMINDER_MINUTES RULE (critical — never set defaults):
- reminder_minutes must be null UNLESS the user explicitly said "напомни за X минут" for THIS specific task.
- If user said nothing about reminders → reminder_minutes = null. NO EXCEPTIONS.
- Never set reminder_minutes = 10 or any other number as a default.
- A task like "Обед в 14:00" with no reminder mention → reminder_minutes = null.

Guidelines:
- Be concise, action-oriented. Extract EVERY actionable item.
- Generate #tags. "language": "ru","en","kk". Keep raw_transcript unchanged.
- Return ONLY JSON.
IMPORTANT: Extract ALL tasks mentioned, no matter how many. Do not stop early. If the user mentions 10 tasks, return all 10 in the todos array.`;

export async function analyzeTranscript(transcript: string, userId?: number): Promise<AnalysisResult> {
  try {
    // Get user-specific temporal context (timezone-aware)
    const temporal = getTemporalContext(userId || 0);

    // Build context prompt with user's LOCAL time, not server time
    const localDt = DateTime.fromISO(temporal.localISO, { zone: temporal.timezone });
    const dayOfWeek = localDt.toFormat('cccc');
    const monthDay = localDt.toFormat('MMMM d');
    const year = localDt.year;

    const contextPrompt = `
CURRENT CONTEXT (critical — use this for ALL date/time calculations):
- User's timezone: ${temporal.timezone}
- Today is ${dayOfWeek}, ${monthDay}, ${year}
- Current local time: ${temporal.localTime}
- Today's date (YYYY-MM-DD): ${temporal.localDate}
- Current UTC time: ${temporal.utcISO}

RESOLUTION RULES:
- "today" → ${temporal.localDate}
- "tomorrow" → ${getNextDate(temporal.localDate, 1)}
- "послезавтра" → ${getNextDate(temporal.localDate, 2)}
- "next [weekday]" → calculate from ${temporal.localDate}
- All times the user says are in ${temporal.timezone} (${temporal.localTime} is NOW)
- NEVER use server/UTC time for user-facing dates. Always use the user's local date above.

${userId ? buildScheduleContextForPrompt(userId, temporal.localDate) : ''}

${userId ? buildPatternsContextForPrompt(userId) : ''}`;

    logger.debug(`[Analysis] Analyzing (${transcript.length} chars) for user ${userId || 'unknown'} [tz=${temporal.timezone}]...`);

    const { content } = await callLLM([
      { role: 'system', content: SYSTEM_PROMPT + contextPrompt },
      { role: 'user', content: `Analyze this transcript:\n\n"${transcript}"` },
    ], {
      preferGitHub: true,
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 4096,
      timeout: 120000,
    });

    if (!content) throw new Error('Empty response');

    let result: AnalysisResult;
    const parsed = safeJsonParse(content);
    if (parsed) {
      result = parsed as AnalysisResult;
    } else {
      logger.error('[Analysis] JSON Parse Error');
      logger.error('[Analysis] Raw content (first 2000 chars): %s', content?.substring(0, 2000));
      // Retry with simplified prompt focused only on todos
      try {
        logger.debug('[Analysis] Retrying with simplified prompt...');
        const { content: retryContent } = await callLLM([
          { role: 'system', content: `Extract ALL tasks with their times and priorities from the transcript. Return ONLY a JSON object with a "todos" array. Each todo has: task (string), priority ("high"/"medium"/"low"), time ("HH:MM" or null), date ("YYYY-MM-DD" or null), datetime ("YYYY-MM-DDTHH:MM:00" or null), duration (number, default 30), reminder_minutes (number or null — minutes before the task to send a reminder). If the user says "remind me in X minutes" about a task, set reminder_minutes on that task. Extract EVERY task mentioned, do not skip any. Preserve foreign terms, acronyms, and brand names verbatim. Language: same as transcript.` + contextPrompt },
          { role: 'user', content: transcript },
        ], {
          preferGitHub: true,
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 4096,
          timeout: 120000,
        });
        if (retryContent) {
          const retryParsed = safeJsonParse(retryContent);
          if (!retryParsed) throw new Error('Retry JSON parse failed');
          result = retryParsed as AnalysisResult;
          result.todos = result.todos || [];
          logger.debug(`[Analysis] Retry succeeded: ${result.todos.length} todos`);
        } else {
          throw new Error('Empty retry response');
        }
      } catch (retryErr) {
        logger.error('[Analysis] Retry also failed: %s', String(retryErr));
        throw new Error(`TRANSCRIPT_FALLBACK:${transcript}`);
      }
    }
    logger.debug(`[Analysis] Parsed ${result.todos.length} todos`);
    result.raw_transcript = transcript;
    result.title = result.title || 'Voice Note';
    result.summary = result.summary || transcript.substring(0, 200);
    result.key_points = result.key_points || [];
    result.todos = result.todos || [];
    result.tags = result.tags || [];
    result.timeframe = (['day','week','month','year'].includes(result.timeframe) ? result.timeframe : 'day') as any;
    if (result.timeframe !== 'day') {
      result.needs_location_check = false;
      result.location_query = undefined;
      result.visit_datetime = undefined;
    }

    const lang = result.language?.toLowerCase();
    if (lang === 'kk' || lang === 'kz') result.language = 'kk';
    else if (lang === 'ru') result.language = 'ru';
    else result.language = 'en';

    // Assign UUIDs to todos
    result.todos = result.todos.map(t => ({
      id: uuid(),
      task: t.task || '',
      priority: (['high','medium','low'].includes(t.priority) ? t.priority : 'medium') as any,
      done: t.done || false,
      time: t.time === "00:00" ? undefined : (t.time || undefined),
      date: t.date || undefined,
      duration: t.duration || 30,
      location: t.location || undefined,
      reminder_minutes: (t.reminder_minutes && Number(t.reminder_minutes) > 0) ? Number(t.reminder_minutes) : undefined,
    }));

    const timed = result.todos.filter(t => t.time).length;
    const hasLoc = !!result.needs_location_check;
    logger.debug(`[Analysis] "${result.title}" [${result.language}] — ${result.todos.length} todos (${timed} timed) ${hasLoc ? '📍 location check' : ''}`);
    return result;
  } catch (error) {
    logger.error('[Analysis] FULL ERROR: %s', String(error));
    throw new Error(`Failed to analyze: ${error instanceof Error ? error.message : String(error)}`);
  }
}
