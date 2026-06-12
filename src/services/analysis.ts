import { logger } from '../logger.js';
import OpenAI from 'openai';
import { config } from '../config.js';
import { AnalysisResult } from '../types/analysis.js';
import { v4 as uuid } from 'uuid';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  timeout: 30000,
  maxRetries: 0,
});

const SYSTEM_PROMPT = `You are an expert assistant for analyzing voice notes.

LANGUAGE RULE (CRITICAL — you MUST write all output in the detected language):
- If any Russian text is present → write ALL text (title, summary, key_points, task descriptions) in Russian. Set "language": "ru".
- If any Kazakh text is present → write ALL text in Kazakh. Set "language": "kk".
- Only write in English if the transcript is 100% English. Set "language": "en".
- Example mixed input: "Today at 3pm call with the client. Вечером купить продукты." → Russian output, "language": "ru"
- The "language" field and the written language MUST match — no exceptions.

Return ONLY a JSON object in this EXACT format:
{
  "title": "Short title (5-7 words)",
  "summary": "2-3 sentence summary",
  "key_points": ["point 1", "point 2"],
  "todos": [
    { "task": "Task description", "priority": "high", "done": false, "time": "15:00", "datetime": "2026-06-15T15:00:00", "date": "2026-06-15", "duration": 30, "location": "Place name or null" }
  ],
  "tags": ["#tag1", "#tag2"],
  "raw_transcript": "original transcript unchanged",
  "language": "ru",
  "location_query": "ЦУМ Астана or null",
  "visit_datetime": "2026-05-29T14:00:00 or null",
  "needs_location_check": false,
  "user_city": "Almaty or null — extract the city the user seems to be in"
}

DATE & TIME EXTRACTION (CRITICAL):
- The user may mention relative dates: "today", "tomorrow", "next week", "in a month", "next Friday", "в следующую пятницу", "через месяц", "послезавтра", "келесі аптада".
- Resolve ALL relative dates using the CURRENT CONTEXT provided below into absolute ISO dates.
- Set "datetime" as full ISO string: "2026-07-15T15:00:00".
- Set "date" as "YYYY-MM-DD" for the calendar date.
- Set "time" as "HH:MM" 24h format for display (if a specific time is mentioned).
- If no date is mentioned → default to today.
- If no time is mentioned → set "time" to null, "datetime" to just the date.
- Examples:
  - "next Friday 3pm" → time: "15:00", date: "2026-06-19", datetime: "2026-06-19T15:00:00"
  - "in a month" → time: null, date: "2026-07-12", datetime: "2026-07-12T00:00:00"
  - "today at 5pm" → time: "17:00", date: today, datetime: "2026-06-12T17:00:00"
- "duration": estimated task duration in minutes (default 30).

LOCATION EXTRACTION:
- If user mentions visiting a specific place + time, set location_query (place name), visit_datetime (ISO), needs_location_check: true.
- If task mentions a place name, set "location" on that todo item.
- If no place → set all location fields to null.
- If the user mentions a city or area they are in or near ("I'm in Almaty", "around Astana", "в Алматы", "Астанада"), set user_city to that city name. Never ask the user to set their city — infer it from their speech.
- CRITICAL: If the user asks to "check weather", "look up weather", "проверь погоду", "какая погода", "нужен ли зонт" etc. → set needs_location_check: true and location_query to the place, but do NOT create a "Check weather" task. The weather lookup is handled automatically.
- Similarly, if the user says "look up a place", "find directions", "как добраться" → set needs_location_check: true. Do not create a task for it.
- CRITICAL for user_city: "Астана" is a city in Kazakhstan. "Мега Астана" is a mall IN Astana. Do NOT confuse with Moscow or any Russian city. When the user says "Мега Астана", "Мега Алматы", "ТРЦ Астана" etc., these are malls in Kazakhstan.

Guidelines:
- Be concise, action-oriented. Extract EVERY actionable item EXCEPT weather/location lookups.
- Priority: "high"=urgent, "medium"=standard, "low"=nice-to-have.
- Generate #tags. "language": "ru","en","kk". Keep raw_transcript unchanged.
- Return ONLY JSON.`;

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRetryable = err?.status >= 500 || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || err?.name === 'TimeoutError';
      if (attempt < retries && isRetryable) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn({ attempt, delay }, 'Retrying analysis after transient error');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

export async function analyzeTranscript(transcript: string): Promise<AnalysisResult> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const contextPrompt = `\n\nCURRENT CONTEXT:\n- Today is ${dateStr}\n- Current time is ${timeStr}\n\nUse this context to resolve relative dates like "tomorrow", "next Friday", etc. into absolute ISO strings.`;

    logger.info(`[Analysis] Analyzing (${transcript.length} chars)...`);

    const response = await withRetry(() => openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextPrompt },
        { role: 'user', content: `Analyze this transcript:\n\n"${transcript}"` },
      ],
      ...(config.isGitHubModels ? {} : { response_format: { type: 'json_object' as const } }),
      temperature: 0.3,
    }));

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');

    const result = JSON.parse(content) as AnalysisResult;
    result.raw_transcript = transcript;
    result.title = result.title || 'Voice Note';
    result.summary = result.summary || transcript.substring(0, 200);
    result.key_points = result.key_points || [];
    result.todos = result.todos || [];
    result.tags = result.tags || [];

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
      time: t.time || undefined,
      datetime: t.datetime || undefined,
      date: t.date || undefined,
      duration: t.duration || 30,
      location: t.location || undefined,
    }));

    const timed = result.todos.filter(t => t.time).length;
    const hasLoc = !!result.needs_location_check;
    logger.info(`[Analysis] "${result.title}" [${result.language}] — ${result.todos.length} todos (${timed} timed) ${hasLoc ? 'location check' : ''}${result.user_city ? ` city: ${result.user_city}` : ''}`);
    return result;
  } catch (error) {
    logger.error(error, '[Analysis] Error:');
    throw new Error(`Failed to analyze: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}
