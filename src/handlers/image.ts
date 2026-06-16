import { Context, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { addTodoToPlan } from '../services/planStore.js';
import { scheduleReminders } from '../services/scheduler.js';

interface ExtractedTask {
  task: string;
  date: string | null;
  time: string | null;
  duration_minutes: number;
  priority: string;
  notes: string | null;
}

interface AnalysisResult {
  source_type: string;
  tasks: ExtractedTask[];
}

const pendingImageTasks = new Map<number, ExtractedTask[]>();

export async function handleImage(ctx: Context) {
  const userId = ctx.from!.id;

  const photo = ctx.message!.photo!;
  const highRes = photo[photo.length - 1];

  const file = await ctx.api.getFile(highRes.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;

  const response = await fetch(fileUrl);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  await ctx.reply('Читаю скриншот...');

  const result = await analyzeScreenshot(base64);

  if (result.tasks.length === 0) {
    await ctx.reply('Не вижу задач на этом скриншоте. Попробуй другой.');
    return;
  }

  pendingImageTasks.set(userId, result.tasks);

  const preview = result.tasks
    .map((t, i) => `${i + 1}. ${t.task}${t.time ? ' · ' + t.time : ''}${t.date ? ' · ' + t.date : ''}`)
    .join('\n');

  const keyboard = new InlineKeyboard()
    .text('Добавить всё в план', `img_add_all_${userId}`)
    .row()
    .text('Выбрать нужные', `img_select_${userId}`)
    .row()
    .text('Отмена', `img_cancel_${userId}`);

  await ctx.reply(
    `${result.source_type}\n\nНашёл ${result.tasks.length} задач:\n\n${preview}\n\nЧто сделать?`,
    { reply_markup: keyboard }
  );
}

async function analyzeScreenshot(base64: string): Promise<AnalysisResult> {
  const openai = new (await import('openai')).OpenAI({
    apiKey: config.groqApiKey || process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const model = config.openaiModel || 'gpt-4.1';

  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64}` },
          },
          {
            type: 'text',
            text: `Analyze this screenshot and extract ALL tasks, meetings, events, or to-do items visible.

Identify what app this is (Microsoft Teams, Notion, Google Calendar, 
Telegram, handwritten notes, email, etc.)

Return ONLY this JSON:
{
  "source_type": "Microsoft Teams / Notion / Calendar / To-do list / Email / Notes / Other",
  "tasks": [
    {
      "task": "task name in original language",
      "date": "YYYY-MM-DD or null",
      "time": "HH:MM or null", 
      "duration_minutes": 30,
      "priority": "high/medium/low",
      "notes": "any additional context or null"
    }
  ]
}

If no tasks visible: { "source_type": "Unknown", "tasks": [] }`,
          },
        ],
      },
    ],
    max_tokens: 2048,
  });

  const content = response.choices[0].message.content || '{}';
  try {
    return JSON.parse(content) as AnalysisResult;
  } catch {
    return { source_type: 'Unknown', tasks: [] };
  }
}

export async function saveTasksToPlan(
  ctx: Context,
  userId: number,
  tasks: ExtractedTask[]
): Promise<number> {
  let saved = 0;
  for (const task of tasks) {
    addTodoToPlan(
      ctx.chat!.id,
      userId,
      task.task,
      task.time || '',
      task.priority || 'medium',
      task.date || new Date().toISOString().substring(0, 10),
    );
    saved++;
  }
  const timed = tasks.filter(t => t.time);
  if (timed.length > 0 && ctx.chat) {
    scheduleReminders(
      ctx.chat.id,
      userId,
      timed.map(t => ({
        id: '',
        task: t.task,
        time: t.time || undefined,
        date: t.date || undefined,
        priority: (t.priority as 'high' | 'medium' | 'low') || 'medium',
        done: false,
        duration: t.duration_minutes || 30,
      })),
      'ru',
    );
  }
  return saved;
}

export { pendingImageTasks };
