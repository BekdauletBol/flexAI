import OpenAI from 'openai';
import { config } from '../config.js';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  timeout: 30000,
  maxRetries: 1,
});

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
}

const SYSTEM_PROMPT = `You are a routing assistant for a personal secretary bot.

Your job: classify the user's voice transcript into exactly ONE intent.

INTENTS:

"action" — user is dictating new tasks, plans, or reminders to save.
Examples:
- "завтра в 9 утра встреча с командой"
- "напомни мне купить молоко"
- "запланируй тренировку на пятницу в 7 утра"
- "на следующей неделе нужно сдать отчёт"

"query" — user is asking about their existing schedule.
Examples:
- "какие у меня планы на завтра"
- "что у меня есть на этой неделе"
- "есть ли у меня что-то в пятницу"
- "покажи мои задачи на сегодня"
- "what do I have tomorrow"

"reschedule" — user wants to move an existing task to a different time or date.
Examples:
- "перенеси встречу с командой на пятницу"
- "сдвинь тренировку на час позже"
- "перенеси дантиста на следующую неделю"
- "move the dentist appointment to 3pm"
- "передвинь встречу"

"delete" — user wants to remove a task.
Examples:
- "удали встречу с командой"
- "отмени ужин сегодня вечером"
- "убери задачу купить билеты"
- "cancel the dentist appointment"

CRITICAL RULE:
If the user says "убери", "удали", "отмени", "убрать", "удалить", "remove", "delete", "cancel" + a task name → intent is ALWAYS "delete".
NEVER create a new task from a delete request.
Even if the sentence is complex: "убери задачу X после того как Y" → delete intent, target_task: "X"

"complete" — user is saying they finished something.
Examples:
- "я выполнил задачу купить билеты"
- "встреча с командой прошла"
- "отметь тренировку как выполненную"
- "done with the report"

"report" — user wants to see their task list or a PDF report.
Examples:
- "покажи мой отчёт"
- "скинь пдф с задачами"
- "дай недельный отчёт"
- "show my report"
- "weekly report"
- "все мои задачи"
- "скинь задачи только до 17:00" → report, target_time: "17:00"
- "отчёт только на утро" → report, target_time: "12:00"
- "покажи только высокий приоритет" → report, priority_filter: "high"
- "задачи только на сегодня" → report, target_date: today

"clear" — user wants to delete completed tasks.
Examples:
- "очисти выполненные"
- "удали всё что сделано"
- "clear done tasks"

"summary" — user wants a quick stats overview.
Examples:
- "сколько у меня задач"
- "как мои дела на этой неделе"
- "how many tasks do I have"

"social" — greeting, thanks, small talk, no actionable request.
Examples:
- "привет"
- "спасибо"
- "окей"
- "как дела"

RULES:
- If the user says "передвинь X" or "перенеси X" → ALWAYS "reschedule", never "action"
- If the user asks a question about their schedule → ALWAYS "query", never "action"  
- If the user says they completed/finished something → ALWAYS "complete", never "action"
- Default to "action" ONLY when user is clearly dictating new plans
- When in doubt between "action" and another intent → choose the other intent

Return ONLY this JSON:
{
  "intent": "action|query|reschedule|delete|complete|report|clear|summary|social",
  "confidence": 0.0-1.0,
  "target_task": "task name mentioned, or null",
  "target_date": "YYYY-MM-DD or relative word like tomorrow/friday, or null",
  "target_time": "HH:MM or null",
  "after_time": "HH:MM filter for tasks after this time, or null",
  "priority_filter": "high|medium|low or null",
  "period": "today|tomorrow|week|month|all or null",
  "command_arg": "language code if language change, or null"
}`;

export async function detectIntent(transcript: string): Promise<IntentResult> {
  console.log('[Intent] Starting detectIntent, model:', config.openaiModel, 'baseURL:', config.openaiBaseUrl);
  try {
    const response = await withTimeout(openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 200,
    }), 30000);

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
    const response = await withTimeout(openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: `You are a personal AI assistant. You have access to all the user's plans and memory. Reply briefly, in ${lang}, like a smart assistant. Data: ${plansData} ${memoryData}` },
        { role: 'user', content: transcript },
      ],
      temperature: 0.3,
      max_tokens: 500,
    }), 30000);
    return response.choices[0]?.message?.content || '...';
  } catch (error) {
    console.error('[Intent] Question failed:', error);
    return 'Error getting answer.';
  }
}

export async function chatReply(transcript: string, memoryData: string, language: string): Promise<string> {
  const lang = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
  try {
    const response = await withTimeout(openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: `You are the user's personal AI assistant. Reply briefly and to the point in ${lang}. User context: ${memoryData}` },
        { role: 'user', content: transcript },
      ],
      temperature: 0.5,
      max_tokens: 500,
    }), 30000);
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
    const response = await withTimeout(openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: `Extract reschedule information. Today is ${dateStr}. Return ONLY JSON: { "task": "task description to find", "newTime": "HH:MM", "date": "YYYY-MM-DD or null if today" }` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }), 30000);
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
    const response = await withTimeout(openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: `Extract delete information. Today is ${dateStr}. Return ONLY JSON: { "type": "task" | "day", "task": "task name if type=task", "date": "YYYY-MM-DD date to delete if type=day, or null" }` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }), 30000);
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
    const response = await withTimeout(openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: `Extract view/plans information. Today is ${dateStr}. Return ONLY JSON: { "date": "YYYY-MM-DD specific date or null", "period": "today" | "tomorrow" | "week" | "month" | null }` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }), 30000);
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
    const response = await withTimeout(openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: `You update the user's long-term memory based on their messages. Current memory: ${currentMemory}

Return ONLY JSON: { "should_update": boolean, "memory_update": { "habits": string[], "projects": string[], "preferences": Record<string,string>, "important_dates": string[], "patterns": Record<string,string>, "places": string[] } }

Only set should_update=true if there is genuinely new info worth remembering. Otherwise return {"should_update":false}.` },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }), 30000);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return content;
  } catch (error) {
    console.error('[Intent] Memory update failed:', error);
    return null;
  }
}
