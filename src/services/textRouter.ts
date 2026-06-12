import { Context } from 'grammy';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { analyzeTranscript } from './analysis.js';
import { savePlan, detectTimeConflicts, completeTask, rescheduleTask, getPlan } from './planStore.js';
import { findTaskByDescription, getCompletedTasksToday } from './db.js';
import { setPendingReminderConfig, getPendingSession, getTaskKeyboard, getTaskMessage } from './reminderSession.js';
import { setPendingPlan, advanceStep, resolveConflict } from './pendingPlan.js';
import { InlineKeyboard } from 'grammy';

interface ClassifiedIntent {
  intent: 'query' | 'reschedule' | 'new_task' | 'complete' | 'what_done' | 'unknown';
  date?: string;
  taskDescription?: string;
  newTime?: string;
  newDate?: string;
}

async function classifyIntent(text: string): Promise<ClassifiedIntent> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `You are a task management assistant. Classify the user message and extract parameters.

Today is ${dateStr}. Resolve relative dates into YYYY-MM-DD.

Return ONLY valid JSON with fields:
- "intent": "query" | "reschedule" | "new_task" | "complete" | "what_done" | "unknown"
- "date": resolved date YYYY-MM-DD or null
- "taskDescription": task being referenced or null
- "newTime": HH:MM or null (for reschedule)
- "newDate": YYYY-MM-DD or null (for reschedule new date)

Examples:
- "What do I have on June 20th?" → {"intent":"query","date":"2026-06-20","taskDescription":null,"newTime":null,"newDate":null}
- "Move the dentist to June 21st at 2pm" → {"intent":"reschedule","date":null,"taskDescription":"dentist","newTime":"14:00","newDate":"2026-06-21"}
- "Remind me to call mom tonight at 8pm" → {"intent":"new_task"}
- "I just finished the report" → {"intent":"complete","taskDescription":"report"}
- "What did I do today?" → {"intent":"what_done","date":"${now.toISOString().slice(0, 10)}"}
- "Hello" → {"intent":"unknown"}

Message: "${text}"`;

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({
      apiKey: config.openaiApiKey,
      ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
    });
    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: 'You classify user messages for a task bot. Return JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
    });
    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content) as ClassifiedIntent;
    if (!['query', 'reschedule', 'new_task', 'complete', 'what_done', 'unknown'].includes(parsed.intent)) {
      return { intent: 'unknown' };
    }
    return parsed;
  } catch (err) {
    logger.error(err, '[TextRouter] Classification failed');
    return { intent: 'unknown' };
  }
}

function formatTodoList(todos: any[], lang: string): string {
  if (todos.length === 0) {
    return lang === 'ru' ? 'Нет задач на этот день.'
      : lang === 'kk' ? 'Бұл күнге тапсырмалар жоқ.'
      : 'No tasks for this day.';
  }
  const lines = todos.map(t => {
    let suffix = '';
    if (t.time) suffix = ` \u00B7 ${t.time}`;
    const status = t.done ? '[x]' : '[ ]';
    return `${status} \u2014 ${t.task}${suffix}`;
  });
  return lines.join('\n');
}

function getTimeMinutes(todo: any): number | null {
  if (todo.time) {
    const parts = todo.time.split(':');
    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }
  if (todo.datetime) {
    const d = new Date(todo.datetime);
    if (!isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
  }
  return null;
}

function detectSameNoteConflicts(todos: any[]): { existing: any; new: any }[] {
  const conflicts: { existing: any; new: any }[] = [];
  for (let i = 0; i < todos.length; i++) {
    const a = todos[i];
    const aStart = getTimeMinutes(a);
    if (aStart === null) continue;
    const aEnd = aStart + (a.duration || 30);
    for (let j = i + 1; j < todos.length; j++) {
      const b = todos[j];
      const bStart = getTimeMinutes(b);
      if (bStart === null) continue;
      const bEnd = bStart + (b.duration || 30);
      if (aStart < bEnd && aEnd > bStart) {
        conflicts.push({ existing: a, new: b });
      }
    }
  }
  return conflicts;
}

async function handleNewTask(ctx: Context, text: string, chatId: number, userId: number) {
  const statusMsg = await ctx.reply('Analyzing...');
  let analysis;
  try {
    analysis = await analyzeTranscript(text);
  } catch (e) {
    logger.error(e, '[TextRouter] Analysis failed');
    await ctx.api.editMessageText(chatId, statusMsg.message_id, 'Analysis failed.');
    return;
  }

  const conflicts = detectTimeConflicts(userId, analysis.todos);
  const sameNoteConflicts = detectSameNoteConflicts(analysis.todos);
  for (const c of sameNoteConflicts) {
    if (!conflicts.some(ex => ex.new.id === c.new.id)) {
      conflicts.push(c);
    }
  }

  if (conflicts.length > 0) {
    setPendingPlan(chatId, {
      chatId,
      userId,
      analysis,
      statusMsgId: statusMsg.message_id,
      step: 'conflicts',
      totalConflicts: conflicts.length,
      resolvedConflicts: new Set(),
    });

    for (const c of conflicts) {
      const exHour = parseInt(c.existing.time!.split(':')[0]);
      const exMin = parseInt(c.existing.time!.split(':')[1]);
      const exDuration = c.existing.duration || 30;
      const totalMin = exHour * 60 + exMin + exDuration + 15;
      const suggestH = Math.floor(totalMin / 60) % 24;
      const suggestM = totalMin % 60;
      const newTime = `${String(suggestH).padStart(2, '0')}:${String(suggestM).padStart(2, '0')}`;

      const kb = new InlineKeyboard()
        .text('Keep both', `cf_keep_${c.new.id}`)
        .text('Skip new', `cf_skip_${c.new.id}`)
        .text(`+15min`, `cf_move_${c.new.id}_${newTime}`)
        .text('Custom', `cf_custom_${c.new.id}`);

      await ctx.reply(
        `CONFLICT\n\n\u2014 ${c.existing.task} \u00B7 ${c.existing.time}\n\u2014 ${c.new.task} \u00B7 ${c.new.time}`,
        { reply_markup: kb }
      );
    }
    return;
  }

  savePlan(chatId, userId, analysis);

  const timedTasks = analysis.todos.filter((t: any) => t.time || t.datetime);
  const tasksWithTime = timedTasks.filter((t: any) => t.time);

  if (tasksWithTime.length > 0) {
    setPendingPlan(chatId, {
      chatId,
      userId,
      analysis,
      statusMsgId: statusMsg.message_id,
      step: 'reminders',
      totalConflicts: 0,
      resolvedConflicts: new Set(),
    });

    setPendingReminderConfig(chatId, userId, analysis.todos, analysis.language);
    const session = getPendingSession(chatId);
    if (session) {
      const msg = await ctx.reply(getTaskMessage(session), {
        reply_markup: getTaskKeyboard(session.currentTaskIndex, session.tasks.length),
      });
      session.messageId = msg.message_id;
    }
    return;
  }

  // deliver text summary
  const lines = analysis.todos.map((t: any) => `\u2014 ${t.task} \u00B7 ${t.priority}`);
  const txt = `${analysis.title}\n\n${analysis.summary}\n\n${lines.join('\n')}`;
  await ctx.reply(txt);
}

export async function handleTextMessage(ctx: Context, text: string) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  const info = await classifyIntent(text);
  logger.info({ intent: info.intent, text: text.substring(0, 80) }, '[TextRouter]');

  switch (info.intent) {
    case 'query': {
      const date = info.date;
      const plan = getPlan(chatId);
      if (!plan) {
        await ctx.reply('You have no saved plans.');
        return;
      }
      const tasksOnDate = date
        ? plan.todos.filter(t => t.date === date)
        : plan.todos;
      const formatted = formatTodoList(tasksOnDate, plan.language);
      const header = date ? `TASKS FOR ${date}` : 'ALL TASKS';
      await ctx.reply(`${header}\n\n${formatted}`);
      break;
    }

    case 'reschedule': {
      const desc = info.taskDescription;
      if (!desc || !info.newTime) {
        await ctx.reply('Which task and what time?');
        return;
      }
      const task = findTaskByDescription(chatId, desc);
      if (!task) {
        await ctx.reply('Could not find a matching task.');
        return;
      }
      rescheduleTask(chatId, task.id, info.newTime, info.newDate);
      const timeStr = info.newTime + (info.newDate ? ` on ${info.newDate}` : '');
      await ctx.reply(`Rescheduled:\n\u2014 ${task.task} \u00B7 ${timeStr}`);
      break;
    }

    case 'new_task': {
      await handleNewTask(ctx, text, chatId, userId);
      break;
    }

    case 'complete': {
      const desc = info.taskDescription;
      if (!desc) {
        await ctx.reply('What did you finish?');
        return;
      }
      const task = findTaskByDescription(chatId, desc);
      if (!task) {
        await ctx.reply(`Could not find task "${desc}". Use your exact task description.`);
        return;
      }
      completeTask(chatId, task.id, true);
      await ctx.reply(`Completed:\n\u2014 ${task.task}`);
      break;
    }

    case 'what_done': {
      const completed = getCompletedTasksToday(userId);
      const plan = getPlan(chatId);
      const lang = plan?.language || 'en';
      if (completed.length === 0) {
        const msg = lang === 'ru' ? 'Вы сегодня ещё ничего не завершили.'
          : lang === 'kk' ? 'Сіз бүгін әлі ештеңе аяқтаған жоқсыз.'
          : 'You haven\'t completed anything today.';
        await ctx.reply(msg);
        return;
      }
      const lines = completed.map((t: any) => `\u2014 ${t.task}`);
      const header = lang === 'ru' ? 'ЗАВЕРШЕНО СЕГОДНЯ'
        : lang === 'kk' ? 'БҮГІН АЯҚТАЛДЫ'
        : 'COMPLETED TODAY';
      await ctx.reply(`${header}\n\n${lines.join('\n')}`);
      break;
    }

    default: {
      await ctx.reply('Send a voice message.');
      break;
    }
  }
}
