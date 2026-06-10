import OpenAI from 'openai';
import { config } from '../config.js';
import { TodoItem } from '../types/analysis.js';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
});

export async function generateFullReport(tasks: TodoItem[], language: 'ru' | 'en' | 'kk' | 'mixed'): Promise<string> {
  if (tasks.length === 0) {
    return language === 'ru' ? 'У вас пока нет задач.' : language === 'kk' ? 'Сізде әлі тапсырмалар жоқ.' : 'You have no tasks yet.';
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

Keep it professional yet encouraging. Use emojis.

TASKS:
${taskList}
`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: 'You are a productivity coach.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    return response.choices[0]?.message?.content || 'Failed to generate report.';
  } catch (error) {
    console.error('[Reporter] AI error:', error);
    return 'Error generating report with AI.';
  }
}
