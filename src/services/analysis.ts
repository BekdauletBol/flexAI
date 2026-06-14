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

const SYSTEM_PROMPT = `You are an expert assistant for analyzing voice notes and messages.

INTENT DETECTION (check this FIRST, in this order):
- "social": user is saying hello, thank you, okay, bye, or any phrase with no tasks or questions.
  Examples: "спасибо", "окей", "привет", "thanks", "got it", "👍", "ok", "понял", "хорошо"
- "reschedule": user wants to MOVE a task to a different time or date. Do NOT extract as tasks.
  Examples: "перенеси задач на 13 июня", "move my 3pm meeting to 4pm", "сдвинь купить билеты на 9:05", "перенести на завтра"
- "query": user is ASKING about existing plans, tasks, or schedule
  Examples: "What do I have tomorrow?", "Какие у меня планы на завтра?", "Am I free on Friday?"
- "action": user is STATING a new task, plan, or idea
  Examples: "Buy groceries today at 6pm", "Нужно купить продукты", "Meeting with the team at 3pm"
- Default to "action" if unclear.

When "intent" is "social":
- Set "todos" to empty array []
- Set "title" to empty string
- Set "summary" to empty string
- Set "key_points" to empty array
- Set "tags" to empty array
- Set "query_date" to null

When "intent" is "reschedule":
- Set "todos" to empty array []
- Set "title" to empty string
- Set "summary" to empty string
- Set "key_points" to empty array
- Set "tags" to empty array
- Set "query_date" to null

When "intent" is "query":
- Set "todos" to empty array []
- Set "query_date" to the date being asked about (YYYY-MM-DD, resolved from relative dates)
- Set "title", "summary", "key_points", "tags" to minimal values
- Do NOT extract any tasks or create any TODO items

When "intent" is "action":
- Extract all tasks normally into "todos"
- Set "query_date" to null

LANGUAGE RULE (CRITICAL — you MUST write all output in the detected language):
- If any Russian text is present → write ALL text in Russian. Set "language": "ru".
- If any Kazakh text is present → write ALL text in Kazakh. Set "language": "kk".
- Only write in English if 100% English. Set "language": "en".
- Example: "Today at 3pm call with the client. Вечером купить продукты." → Russian output, "language": "ru"

Return ONLY a JSON object in this EXACT format:
{
  "intent": "query" or "action" or "social" or "reschedule",
  "query_date": "YYYY-MM-DD or null",
  "title": "Short title (5-7 words)",
  "summary": "2-3 sentence summary",
  "key_points": ["point 1", "point 2"],
  "todos": [
    { "task": "Task description", "priority": "high", "done": false, "time": "15:00", "date": "2026-05-29", "duration": 30, "location": "Place name or null" }
  ],
  "tags": ["#tag1", "#tag2"],
  "raw_transcript": "original transcript unchanged",
  "language": "ru",
  "location_query": null,
  "visit_datetime": null,
  "needs_location_check": false,
  "user_city": null
}

DATE & TIME EXTRACTION (for "action" intent):
- Resolve relative dates using CURRENT CONTEXT into absolute ISO dates.
- Set "datetime" as full ISO: "2026-07-15T15:00:00".
- Set "date" as "YYYY-MM-DD".
- Set "time" as "HH:MM" 24h.
- If no date → default to today.
- Examples: "next Friday 3pm" → time: "15:00", date: "2026-06-19", datetime: "2026-06-19T15:00:00"
- "duration": default 30 minutes.

DATE EXTRACTION:
- If the user mentions a date, extract as "date" in "YYYY-MM-DD" format using the current date context below.
- "today" → today's date, "tomorrow" → tomorrow's date, "next Friday" → resolve to absolute ISO date.
- If no date mentioned → set "date" to null.

PRIORITY RULES (apply strictly):
- "high": "срочно", "обязательно", "до [date]", "urgent", "asap", "must", "важно", "маңызды", "шұғыл"
- "medium": "хочу", "планирую", "надо бы", "want to", "planning to", "need to", "керек"
- "low": "возможно", "когда-нибудь", "maybe", "someday", "мүмкін", "бір кезде"
- Default to "medium" when no clear signal.

LOCATION EXTRACTION:
- If user mentions visiting a specific place + time, set location_query (place name), visit_datetime (ISO), needs_location_check: true.
- If the user asks about weather → set needs_location_check: true, do NOT create a "Check weather" task.
- "Астана" is a city in Kazakhstan, not Russia.
- Infer user_city from speech, never ask to set city.

Guidelines:
- "intent": "query" — only answer what date they're asking about, no task extraction
- "intent": "action" — extract EVERY actionable item except weather/location lookups
- Priority: "high"=urgent, "medium"=standard, "low"=nice-to-have
- Be concise, action-oriented. Extract EVERY actionable item.
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
    if (!['query', 'action', 'social', 'reschedule'].includes(result.intent)) result.intent = 'action';
    result.query_date = result.intent === 'query' ? (result.query_date || undefined) : undefined;
    const badTitles = ['short title (5-7 words)', 'short title', 'title'];
    if (!result.title || badTitles.some(b => result.title.toLowerCase().includes(b))) {
      result.title = result.intent === 'query' ? '' : result.intent === 'social' ? '' : result.intent === 'reschedule' ? '' : 'Voice Note';
    }
    result.summary = result.summary || (result.intent === 'query' || result.intent === 'social' || result.intent === 'reschedule' ? '' : transcript.substring(0, 200));
    result.key_points = result.key_points || [];
    result.todos = result.todos || [];
    result.tags = result.tags || [];

    // Validate all todo dates are absolute ISO YYYY-MM-DD, never relative
    result.todos = result.todos.map(todo => {
      if (todo.date) {
        const lower = todo.date.toLowerCase();
        if (lower === 'today') {
          todo.date = now.toISOString().split('T')[0];
        } else if (lower === 'tomorrow') {
          const tom = new Date(now);
          tom.setDate(tom.getDate() + 1);
          todo.date = tom.toISOString().split('T')[0];
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(todo.date)) {
          // If it's not YYYY-MM-DD, default to today
          todo.date = now.toISOString().split('T')[0];
        }
      }
      return todo;
    });

    // For non-action intents, skip todo processing
    if (result.intent !== 'action') {
      logger.info(`[Analysis] Intent=${result.intent}${result.intent === 'query' ? ` date=${result.query_date || 'none'}` : ''}`);
      return result;
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
