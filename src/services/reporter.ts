import { logger } from '../logger.js';
import OpenAI from 'openai';
import { config } from '../config.js';
import { TodoItem } from '../types/analysis.js';
import { groq, GROQ_MODEL, hasGroq } from './groq.js';

const fallback = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  timeout: 30000,
  maxRetries: 0,
});

const llm = hasGroq ? groq : fallback;
const MODEL = hasGroq ? GROQ_MODEL : config.openaiModel;

const SEP = '———————————————';

function formatPriority(p: string): string {
  if (p === 'high') return 'High';
  if (p === 'medium') return 'Medium';
  return 'Low';
}

function formatTodoLine(t: TodoItem): string {
  let line = `— ${t.task} · ${formatPriority(t.priority)}`;
  if (t.time) line += ` · ${t.time}`;
  if (t.location) line += ` · ${t.location}`;
  return line;
}

/**
 * Generates an AI-powered report based on tasks.
 */
export async function generateFullReport(tasks: TodoItem[], language: string): Promise<string> {
  if (tasks.length === 0) {
    if (language === 'ru') return 'Задач пока нет.';
    if (language === 'kk') return 'Тапсырмалар жоқ.';
    return 'No tasks recorded.';
  }

  const langMap: Record<string, string> = { ru: 'Russian', en: 'English', kk: 'Kazakh', mixed: 'English' };
  const lang = langMap[language] || 'English';

  const taskList = tasks.map(t => {
    const status = t.done ? '[COMPLETED]' : '[PENDING]';
    const priority = t.priority.toUpperCase();
    const time = t.time ? ` at ${t.time}` : '';
    return `- ${status} (${priority}) ${t.task}${time}`;
  }).join('\n');

  const prompt = `
Analyze the following list of tasks and provide a comprehensive report in ${lang}.
The report should include:
1. A brief summary of overall progress (how many completed vs pending).
2. Key focus areas based on priorities.
3. A motivational closing statement.

Keep it professional, concise and encouraging. No emojis.

TASKS:
${taskList}
`;

  try {
    const response = await llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a productivity coach.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    return response.choices[0]?.message?.content || 'Failed to generate report.';
  } catch (error) {
    logger.error(error, '[Reporter] AI error:');
    // Fallback to plain text report
    return generatePlainTextReport(tasks, language);
  }
}

function generatePlainTextReport(tasks: TodoItem[], language: string): string {
  const pending = tasks.filter(t => !t.done);
  const completed = tasks.filter(t => t.done);

  const lines: string[] = [];

  if (pending.length > 0) {
    if (language === 'ru') lines.push('ЗАДАЧИ');
    else if (language === 'kk') lines.push('ТАПСЫРМАЛАР');
    else lines.push('TASKS');

    lines.push('');
    for (const t of pending) lines.push(formatTodoLine(t));
  }

  if (completed.length > 0) {
    if (pending.length > 0) {
      lines.push('');
      lines.push(SEP);
      lines.push('');
    }

    if (language === 'ru') lines.push('ВЫПОЛНЕНО');
    else if (language === 'kk') lines.push('ОРЫНДАЛДЫ');
    else lines.push('COMPLETED');

    lines.push('');
    for (const t of completed) lines.push(formatTodoLine(t));
  }

  lines.push('');
  lines.push(SEP);
  lines.push('');

  const total = tasks.length;
  const doneCount = completed.length;

  if (language === 'ru') {
    lines.push(`Всего: ${total}. Выполнено: ${doneCount}. Осталось: ${total - doneCount}.`);
  } else if (language === 'kk') {
    lines.push(`Барлығы: ${total}. Орындалды: ${doneCount}. Қалды: ${total - doneCount}.`);
  } else {
    lines.push(`Total: ${total}. Completed: ${doneCount}. Remaining: ${total - doneCount}.`);
  }

  return lines.join('\n');
}

/**
 * Generate a weekly summary string (plain text).
 */
export function generateWeeklyReport(
  plans: Array<{ title: string; createdAt: string; todos: TodoItem[]; language: string }>,
  language: string
): string {
  if (plans.length === 0) {
    if (language === 'ru') return 'За последние 7 дней записей нет.';
    if (language === 'kk') return 'Соңғы 7 күнде жазбалар жоқ.';
    return 'No notes in the past 7 days.';
  }

  const lines: string[] = [];

  if (language === 'ru') lines.push('ОТЧЕТ ЗА НЕДЕЛЮ');
  else if (language === 'kk') lines.push('АПТАЛЫК ЕСЕП');
  else lines.push('WEEKLY REPORT');

  lines.push('');

  for (const plan of plans) {
    const date = new Date(plan.createdAt).toLocaleDateString(
      language === 'ru' ? 'ru-RU' : language === 'kk' ? 'kk-KZ' : 'en-US',
      { weekday: 'long', month: 'short', day: 'numeric' }
    );
    lines.push(date);
    lines.push('');

    if (plan.todos.length === 0) {
      lines.push('— No tasks');
    } else {
      for (const t of plan.todos) lines.push(formatTodoLine(t));
    }
    lines.push('');
    lines.push(SEP);
    lines.push('');
  }

  const allTodos = plans.flatMap(p => p.todos);
  const done = allTodos.filter(t => t.done).length;

  if (language === 'ru') {
    lines.push(`Всего за неделю: ${allTodos.length} задач. Выполнено: ${done}.`);
  } else if (language === 'kk') {
    lines.push(`Аптасына барлығы: ${allTodos.length} тапсырма. Орындалды: ${done}.`);
  } else {
    lines.push(`Week total: ${allTodos.length} tasks. Completed: ${done}.`);
  }

  return lines.join('\n');
}
