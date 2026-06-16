import OpenAI from 'openai';
import { config } from '../config.js';
import { groq, GROQ_MODEL, hasGroq } from './groq.js';

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
    timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
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
  intent: 'action' | 'query' | 'reschedule' | 'delete' | 'complete' | 'report' | 'clear' | 'summary' | 'social';
  confidence: number;
  target_task?: string;
  target_date?: string;
  target_time?: string;
  after_time?: string;
  priority_filter?: 'high' | 'medium' | 'low';
  period?: 'today' | 'tomorrow' | 'week' | 'month' | 'all' | string;
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
  Kazakh: есеп, тапсырмалар
  Do NOT create a task from these. Do NOT save them. Do NOT reply with action.

QUERY RULES — Use ONLY for general chat questions, NOT about tasks:
  "что ты умеешь", "how are you", "привет", "hello"
  Do NOT use query for "какие планы", "что у меня", "покажи" — those are "report".

ACTION RULES — Only use "action" if the message clearly describes a NEW task/plan/todo:
  "запиши", "добавь", "создай", "напомни сделать", "нужно сделать"
  NEVER use action if the message is asking about EXISTING tasks.

DELETE — ONLY if message contains: удали, убери, отмени, удалить, убрать, отменить, delete, remove, cancel

RESCHEDULE — ONLY if message contains: перенеси, передвинь, сдвинь, перенести, reschedule, move

For "report" intents, set these fields:
  target_date — specific date mentioned (YYYY-MM-DD)
  target_time — specific time filter (HH:MM)
  after_time — show tasks after this time
  period — "today", "tomorrow", "week", "month", "all"
  date_from — start of date range (YYYY-MM-DD). Examples: "за этот месяц" → first day of current month, "за этот год" → Jan 1, "неделя" → Monday of current week, "между 20 и 28 июня" → 2026-06-20
  date_to — end of date range (YYYY-MM-DD). Examples: "за этот месяц" → last day of current month, "за этот год" → Dec 31, "неделя" → Sunday of current week, "между 20 и 28 июня" → 2026-06-28
  date_ranges — for multiple dates/spans: [{date: "YYYY-MM-DD", beforeTime: "HH:MM or null", afterTime: "HH:MM or null"}]
    Examples: "сегодня и завтра" → two entries, "на 2 дня" → today+tomorrow, 
    "до 19 июня" → entries for each day from today to June 19,
    "на следующую неделю" → entries for next 7 days,
    "за эту неделю" → entries for current week (Mon-Sun)

Return ONLY this JSON:
{
  "intent": "action|query|reschedule|delete|complete|report|clear|summary|social",
  "confidence": 0.0-1.0,
  "target_date": "YYYY-MM-DD or null",
  "target_time": "HH:MM or null",
  "after_time": "HH:MM or null",
  "date_from": "YYYY-MM-DD or null",
  "date_to": "YYYY-MM-DD or null",
  "date_ranges": [{"date": "YYYY-MM-DD", "beforeTime": "HH:MM or null", "afterTime": "HH:MM or null"}]
}`;

export function quickIntentOverride(transcript: string): Partial<IntentResult> | null {
  const lower = transcript.toLowerCase().replace(/\s+/g, ' ').trim();

  const reportWords = [
    'отчёт', 'репорт', 'отчет',
    'скинь задачи', 'покажи задачи', 'скинь план', 'покажи план',
    'send report', 'show report', 'отправь отчёт', 'скинь отчёт',
    'отправь документ', 'скинь документ', 'скинь в формате',
    'скинь пдф', 'в формате pdf', 'в формате пдф',
    'pdf', 'пдф',
  ];
  if (reportWords.some(w => lower.includes(w))) {
    console.log('[Intent] Quick override → report');
    return { intent: 'report', confidence: 1.0, target_date: undefined, target_time: undefined, date_ranges: [] };
  }

  const queryWords = [
    'какие у меня', 'что у меня', 'есть ли у меня',
    'what do i have', "what's on my", 'покажи что',
    'какой план', 'что запланировано',
  ];
  if (queryWords.some(w => lower.includes(w))) {
    console.log('[Intent] Quick override → query');
    return { intent: 'query', confidence: 1.0 };
  }

  const deleteWords = ['удали', 'убери', 'отмени', 'удалить', 'убрать', 'отменить', 'delete', 'remove', 'cancel'];
  if (deleteWords.some(w => lower.includes(w))) {
    console.log('[Intent] Quick override → delete');
    return { intent: 'delete', confidence: 1.0 };
  }

  const rescheduleWords = ['перенеси', 'передвинь', 'сдвинь', 'перенести', 'reschedule', 'move'];
  if (rescheduleWords.some(w => lower.includes(w))) {
    console.log('[Intent] Quick override → reschedule');
    return { intent: 'reschedule', confidence: 1.0 };
  }

  return null;
}

export async function detectIntent(transcript: string): Promise<IntentResult> {
  console.log('[Intent] Starting detectIntent, model:', MODEL, 'baseURL:', config.openaiBaseUrl);
  try {
    const response = await withTimeout(llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 200,
    }), 60000);

    console.log('[Intent] Got response from OpenAI');
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');

    console.log('[Intent] Response content:', content);
    const result = JSON.parse(content) as IntentResult;
    result.intent = result.intent || 'action';
    result.confidence = result.confidence || 0.5;

    console.log(`[Intent] "${result.intent}" (${(result.confidence * 100).toFixed(0)}%)`);
    return result;
  } catch (error) {
    console.error('[Intent] Detection failed, defaulting to action:', error);
    return { intent: 'action', confidence: 0.5 };
  }
}

export async function askQuestion(transcript: string, plansData: string, memoryData: string, language: string): Promise<string> {
  const lang = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
  try {
    const response = await withTimeout(llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `You are a personal AI assistant. You have access to all the user's plans and memory. Reply briefly, in ${lang}, like a smart assistant. Data: ${plansData} ${memoryData}` },
        { role: 'user', content: transcript },
      ],
      temperature: 0.3,
      max_tokens: 500,
    }), 60000);
    return response.choices[0]?.message?.content || '...';
  } catch (error) {
    console.error('[Intent] Question failed:', error);
    return 'Error getting answer.';
  }
}

export async function chatReply(transcript: string, memoryData: string, language: string): Promise<string> {
  const lang = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
  try {
    const response = await withTimeout(llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `You are the user's personal AI assistant. Reply briefly and to the point in ${lang}. User context: ${memoryData}` },
        { role: 'user', content: transcript },
      ],
      temperature: 0.5,
      max_tokens: 500,
    }), 60000);
    return response.choices[0]?.message?.content || '...';
  } catch (error) {
    console.error('[Intent] Chat failed:', error);
    return '...';
  }
}


export interface RescheduleExtraction {
  task: string;
  newTime: string;
  date?: string;
}

export async function extractRescheduleInfo(transcript: string): Promise<RescheduleExtraction | null> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const response = await withTimeout(llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `Extract reschedule information. Today is ${dateStr}. Return ONLY JSON: { "task": "task description to find", "newTime": "HH:MM", "date": "YYYY-MM-DD or null if today" }` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }), 60000);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as RescheduleExtraction;
  } catch (error) {
    console.error('[Intent] Reschedule extraction failed:', error);
    return null;
  }
}

export interface DeleteExtraction {
  type: 'task' | 'day';
  task?: string;
  date?: string;
}

export async function extractDeleteInfo(transcript: string): Promise<DeleteExtraction | null> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const response = await withTimeout(llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `Extract delete information. Today is ${dateStr}. Return ONLY JSON: { "type": "task" | "day", "task": "task name if type=task", "date": "YYYY-MM-DD date to delete if type=day, or null" }` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }), 60000);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as DeleteExtraction;
  } catch (error) {
    console.error('[Intent] Delete extraction failed:', error);
    return null;
  }
}

export interface ViewExtraction {
  date?: string;
  period?: 'today' | 'tomorrow' | 'week' | 'month';
}

export async function extractViewInfo(transcript: string): Promise<ViewExtraction | null> {
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const response = await withTimeout(llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `Extract view/plans information. Today is ${dateStr}. Return ONLY JSON: { "date": "YYYY-MM-DD specific date or null", "period": "today" | "tomorrow" | "week" | "month" | null }` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }), 60000);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as ViewExtraction;
  } catch (error) {
    console.error('[Intent] View extraction failed:', error);
    return null;
  }
}

export async function extractMemoryUpdate(transcript: string, currentMemory: string): Promise<string | null> {
  try {
    const response = await withTimeout(llm.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system', content: `You update the user's long-term memory based on their messages. Current memory: ${currentMemory}

Return ONLY JSON: { "should_update": boolean, "memory_update": { "habits": string[], "projects": string[], "preferences": Record<string,string>, "important_dates": string[], "patterns": Record<string,string>, "places": string[] } }

Only set should_update=true if there is genuinely new info worth remembering. Otherwise return {"should_update":false}.` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }), 60000);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return content;
  } catch (error) {
    console.error('[Intent] Memory update failed:', error);
    return null;
  }
}
