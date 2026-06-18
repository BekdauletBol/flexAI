import OpenAI from 'openai';
import { config } from '../config.js';
import { AnalysisResult } from '../types/analysis.js';
import { v4 as uuid } from 'uuid';
import { getTemporalContext } from './userConfig.js';

const fallback = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  timeout: 120000,
  maxRetries: 1,
});

// Use OpenAI for analysis because structured JSON extraction is more reliable
// than Groq's Llama models on complex multilingual transcripts.
const analysisLlm = fallback;
const ANALYSIS_MODEL = config.openaiModel;

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
  const [y, m, d] = baseDate.split('-').map(Number);
  const date = new Date(y, m - 1, d + daysOffset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
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

Return ONLY a JSON object in this EXACT format:
{
  "title": "Short title (5-7 words)",
  "summary": "2-3 sentence summary",
  "key_points": ["point 1", "point 2"],
  "todos": [
    { "task": "Task description", "priority": "high", "done": false, "time": "15:00", "date": "2026-05-29", "duration": 30, "location": "Place name or null" }
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
    const localDateObj = new Date(temporal.localISO);
    const dayOfWeek = localDateObj.toLocaleDateString('en-US', { weekday: 'long' });
    const monthDay = localDateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const year = localDateObj.getFullYear();

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
- NEVER use server/UTC time for user-facing dates. Always use the user's local date above.`;

    console.log(`[Analysis] Analyzing (${transcript.length} chars) for user ${userId || 'unknown'} [tz=${temporal.timezone}]...`);

    const response = await withTimeout(analysisLlm.chat.completions.create({
      model: ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextPrompt },
        { role: 'user', content: `Analyze this transcript:\n\n"${transcript}"` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 4096,
    }), 120000);

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');

    let result: AnalysisResult;
    const parsed = safeJsonParse(content);
    if (parsed) {
      result = parsed as AnalysisResult;
    } else {
      console.error('[Analysis] JSON Parse Error');
      console.error('[Analysis] Raw content (first 2000 chars):', content?.substring(0, 2000));
      // Retry with simplified prompt focused only on todos
      try {
        console.log('[Analysis] Retrying with simplified prompt...');
        const retryResponse = await withTimeout(analysisLlm.chat.completions.create({
          model: ANALYSIS_MODEL,
          messages: [
            { role: 'system', content: `Extract ALL tasks with their times and priorities from the transcript. Return ONLY a JSON object with a "todos" array. Each todo has: task (string), priority ("high"/"medium"/"low"), time ("HH:MM" or null), date ("YYYY-MM-DD" or null), datetime ("YYYY-MM-DDTHH:MM:00" or null), duration (number, default 30). Extract EVERY task mentioned, do not skip any. Preserve foreign terms, acronyms, and brand names verbatim. Language: same as transcript.` + contextPrompt },
            { role: 'user', content: transcript },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 4096,
        }), 120000);
        const retryContent = retryResponse.choices[0]?.message?.content;
        if (retryContent) {
          const retryParsed = safeJsonParse(retryContent);
          if (!retryParsed) throw new Error('Retry JSON parse failed');
          result = retryParsed as AnalysisResult;
          result.todos = result.todos || [];
          console.log(`[Analysis] Retry succeeded: ${result.todos.length} todos`);
        } else {
          throw new Error('Empty retry response');
        }
      } catch (retryErr) {
        console.error('[Analysis] Retry also failed:', retryErr);
        throw new Error(`TRANSCRIPT_FALLBACK:${transcript}`);
      }
    }
    console.log(`[Analysis] Parsed ${result.todos.length} todos`);
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
    }));

    const timed = result.todos.filter(t => t.time).length;
    const hasLoc = !!result.needs_location_check;
    console.log(`[Analysis] "${result.title}" [${result.language}] — ${result.todos.length} todos (${timed} timed) ${hasLoc ? '📍 location check' : ''}`);
    return result;
  } catch (error) {
    console.error('[Analysis] FULL ERROR:', error);
    throw new Error(`Failed to analyze: ${error instanceof Error ? error.message : String(error)}`);
  }
}
