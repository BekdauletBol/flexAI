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
  intent: 'action' | 'query' | 'memory_query' | 'reschedule' | 'delete' | 'complete' | 'view' | 'chat' | 'command' | 'social' | 'summary';
  confidence: number;
  target_task?: string;
  period?: 'today' | 'tomorrow' | 'week' | 'all' | string;
  command?: 'report' | 'weekly' | 'clear' | 'language';
  command_arg?: string;
}

const SYSTEM_PROMPT = `You are an intent classifier for a voice task bot. The user speaks naturally. Determine their intent and return ONLY JSON:

{
  "intent": "action" | "query" | "memory_query" | "reschedule" | "delete" | "complete" | "view" | "chat" | "command" | "social" | "summary",
  "confidence": 0.0-1.0,
  "target_task": "task name the user wants to delete/complete (extract verbatim) or null",
  "period": "today" | "tomorrow" | "week" | "all" | null,
  "command": "report" | "weekly" | "clear" | "language" | null,
  "command_arg": "language code: ru/en/kk, or null"
}

INTENT DEFINITIONS:
action       — user is describing tasks/plans/todos to create ("запланируй", "сделать", "нужно", schedule)
query        — asking about existing plans/tasks ("что у меня", "when do I", "что запланировано")
memory_query — asking what the bot remembers about them
reschedule   — asking to move a task to a different time ("перенеси", "передвинь", move)
delete       — asking to delete a task ("удали", "отмени", remove)
complete     — marking a task as done ("выполнил", "сделал", "готово", done)
view         — asking to see plans for a day/period ("покажи", show)
chat         — general conversation, question unrelated to planning
command      — bot control by voice ("покажи задачи" -> report, "очисти выполненные" -> clear, "еженедельный отчет" -> weekly, "смени язык на английский" -> language + arg "en")
social       — greeting, thanks, small talk ("привет", "спасибо", "как дела", hi)
summary      — asking for overall status/stats ("сколько задач", "статистика", summary)

EXAMPLES:
"удали встречу с командой"                    -> {"intent":"delete", "target_task":"встречу с командой"}
"я выполнил задачу купить билеты"             -> {"intent":"complete", "target_task":"купить билеты"}
"сколько у меня задач на сегодня?"            -> {"intent":"summary", "period":"today"}
"покажи все мои задачи"                       -> {"intent":"command", "command":"report"}
"очисти выполненные"                          -> {"intent":"command", "command":"clear"}
"weekly report"                               -> {"intent":"command", "command":"weekly"}
"смени язык на русский"                       -> {"intent":"command", "command":"language", "command_arg":"ru"}
"перенеси тренировку на 9 утра"               -> {"intent":"reschedule"}
"какие планы на пятницу?"                     -> {"intent":"view"}
"отмени ужин в 20:00"                         -> {"intent":"delete", "target_task":"ужин"}`;

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
