import { Context } from 'grammy';
import { logger } from '../logger.js';
import { analyzeTranscript } from './analysis.js';
import { savePlan, detectTimeConflicts, completeTask, rescheduleTask, getPlan } from './planStore.js';
import { findTaskByDescription, getCompletedTasksToday } from './db.js';
import { setPendingReminderConfig, getPendingSession, getTaskKeyboard, getTaskMessage } from './reminderSession.js';
import { setPendingPlan } from './pendingPlan.js';
import { InlineKeyboard } from 'grammy';

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

function classifyIntentFast(text: string): { intent: 'complete' | 'reschedule' | 'what_done' | 'unknown'; taskDescription?: string; newTime?: string; newDate?: string } | null {
  const lower = text.toLowerCase().trim();

  // === COMPLETE ===
  if (/^(?:i (?:just )?(?:finished|completed|done|did)|i['\u2019]?ve (?:just )?(?:finished|completed|done))/.test(lower)) {
    const m = lower.match(/(?:finished|completed|done with|did|сделал|закончил|выполнил)\s+(.+)/);
    return { intent: 'complete', taskDescription: m ? m[1].replace(/^(it|that|the|его|это|вс[её])\s*/i, '').trim() : '' };
  }
  if (/^(?:я |я\s+)?(сделал|закончил|выполнил)/.test(lower)) {
    const m = lower.match(/(?:сделал|закончил|выполнил)\s+(.+)/);
    return { intent: 'complete', taskDescription: m ? m[1].replace(/^(его|это|вс[её])\s*/i, '').trim() : '' };
  }

  // === RESCHEDULE ===
  if (/(?:^|\s)(?:move|reschedule|change|shift)\s/.test(lower)) {
    const m = text.match(/(?:move|reschedule|change|shift)\s+(.+?)\s+(?:to)\s+(.+)/i);
    const taskDesc = m ? m[1].trim() : '';
    const timeStr = m?.[2]?.trim();
    const tm = timeStr ? timeStr.match(/(\d{1,2}):(\d{2})/) : null;
    return { intent: 'reschedule', taskDescription: taskDesc, newTime: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : timeStr };
  }
  if (/(перенес(?:ти|и)|передвинь|измени)\s/.test(lower)) {
    // Try "с X на Y" pattern first (from X to Y)
    let m = text.match(/(?:перенес[ти]?|передвинь|измени)\s+(.+?)\s+с\s+(.+?)\s+на\s+(.+)/i);
    if (m) {
      const taskDesc = m[1].trim();
      const timeStr = m[3]?.trim();
      const tm = timeStr ? timeStr.match(/(\d{1,2}):(\d{2})/) : null;
      return { intent: 'reschedule', taskDescription: taskDesc, newTime: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : timeStr || m[2]?.trim() };
    }
    // Fallback: try "X на Y" pattern
    m = text.match(/(?:перенес[ти]?|передвинь|измени)\s+(.+?)\s+на\s+(.+)/i);
    const taskDesc = m ? m[1].trim() : '';
    const timeStr = m?.[2]?.trim();
    const tm = timeStr ? timeStr.match(/(\d{1,2}):(\d{2})/) : null;
    return { intent: 'reschedule', taskDescription: taskDesc, newTime: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : timeStr };
  }

  // === WHAT_DONE ===
  if (/(?:what did i do|what have i|how was my)/.test(lower)) return { intent: 'what_done' };
  if (/(что (?:я сделал|я сегодня|делал|было|завершил))/.test(lower)) return { intent: 'what_done' };

  // === UNKNOWN (greetings etc) ===
  if (/^(?:hello|hi|hey|good morning|good evening|good afternoon|привет|здравствуй|здравствуйте|салем|salem)\b/.test(lower)) return { intent: 'unknown' };

  return null; // fall through to AI analysis
}

export async function handleTextMessage(ctx: Context, text: string) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  // Fast path: classifyIntentFast only handles deterministic regex commands
  const fast = classifyIntentFast(text);
  if (fast) {
    const lang = getPlan(chatId)?.language || 'ru';

    switch (fast.intent) {
      case 'complete': {
        const desc = fast.taskDescription;
        if (!desc) {
          await ctx.reply(lang === 'ru' ? 'Что ты закончил?' : 'What did you finish?');
          return;
        }
        const task = findTaskByDescription(chatId, desc);
        if (!task) {
          await ctx.reply(
            lang === 'ru'
              ? `Не найден задача "${desc}". Уточните описание.`
              : `Could not find task "${desc}". Use your exact task description.`
          );
          return;
        }
        completeTask(chatId, task.id, true);
        await ctx.reply(
          lang === 'ru' ? `Выполнено:\n\u2014 ${task.task}`
          : `Completed:\n\u2014 ${task.task}`
        );
        return;
      }

      case 'reschedule': {
        const desc = fast.taskDescription;
        if (!desc || !fast.newTime) {
          await ctx.reply(lang === 'ru' ? 'Какую задачу и когда?' : 'Which task and what time?');
          return;
        }
        const task = findTaskByDescription(chatId, desc);
        if (!task) {
          await ctx.reply(lang === 'ru' ? 'Не найдена такая задача.' : 'Could not find a matching task.');
          return;
        }
        rescheduleTask(chatId, task.id, fast.newTime, fast.newDate);
        const timeStr = fast.newTime + (fast.newDate ? ` на ${fast.newDate}` : '');
        await ctx.reply(
          lang === 'ru' ? `Перенесено:\n\u2014 ${task.task} \u00B7 ${timeStr}`
          : `Rescheduled:\n\u2014 ${task.task} \u00B7 ${timeStr}`
        );
        return;
      }

      case 'what_done': {
        const completed = getCompletedTasksToday(userId);
        if (completed.length === 0) {
          await ctx.reply(
            lang === 'ru' ? 'Вы сегодня ещё ничего не завершили.'
            : lang === 'kk' ? 'Сіз бүгін әлі ештеңе аяқтаған жоқсыз.'
            : 'You haven\'t completed anything today.'
          );
          return;
        }
        const lines = completed.map((t: any) => `\u2014 ${t.task}`);
        const header = lang === 'ru' ? 'ЗАВЕРШЕНО СЕГОДНЯ'
          : lang === 'kk' ? 'БҮГІН АЯҚТАЛДЫ'
          : 'COMPLETED TODAY';
        await ctx.reply(`${header}\n\n${lines.join('\n')}`);
        return;
      }

      case 'unknown': {
        await ctx.reply(lang === 'ru' ? 'Отправьте голосовое сообщение.' : 'Send a voice message.');
        return;
      }
    }
  }

  // For everything else (query or new_task), use AI analysis
  const statusMsg = await ctx.reply('Analyzing...');
  let analysis;
  try {
    analysis = await analyzeTranscript(text);
  } catch (e) {
    logger.error(e, '[TextRouter] Analysis failed');
    await ctx.api.editMessageText(chatId, statusMsg.message_id, 'Analysis failed.');
    return;
  }

  // Handle social intent — greet/thanks, no saving
  if (analysis.intent === 'social') {
    const lang = analysis.language || 'ru';
    const msg = lang === 'ru' ? 'Понял.'
      : lang === 'kk' ? 'Түсінікті.'
      : 'Got it.';
    await ctx.api.editMessageText(chatId, statusMsg.message_id, msg);
    return;
  }

  // Handle reschedule intent — don't save, reply with usage hint
  if (analysis.intent === 'reschedule') {
    const lang = analysis.language || 'ru';
    const msg = lang === 'ru' ? 'Чтобы перенести задачу, напишите: "перенеси [задача] на [время]"'
      : lang === 'kk' ? 'Тапсырманы ауыстыру үшін: "перенеси [тапсырма] на [уақыт]" деп жазыңыз'
      : 'To reschedule a task, write: "move [task] to [time]"';
    await ctx.api.editMessageText(chatId, statusMsg.message_id, msg);
    return;
  }

  // Handle query intent — show existing tasks for the requested date
  if (analysis.intent === 'query') {
    const date = analysis.query_date;
    const plan = getPlan(chatId);
    const lang = analysis.language || 'ru';

    if (!plan || !plan.todos || plan.todos.length === 0) {
      const msg = date
        ? (lang === 'ru' ? `На ${date} задач нет.`
          : lang === 'kk' ? `${date} күніне тапсырмалар жоқ.`
          : `Nothing planned for ${date}.`)
        : (lang === 'ru' ? 'Нет активных задач.'
          : lang === 'kk' ? 'Белсенді тапсырмалар жоқ.'
          : 'No active tasks.');
      await ctx.api.editMessageText(chatId, statusMsg.message_id, msg);
      return;
    }

    const tasksOnDate = date
      ? plan.todos.filter((t: any) => t.date === date && !t.done)
      : plan.todos.filter((t: any) => !t.done);

    if (tasksOnDate.length === 0) {
      const msg = date
        ? (lang === 'ru' ? `На ${date} задач нет.`
          : lang === 'kk' ? `${date} күніне тапсырмалар жоқ.`
          : `Nothing planned for ${date}.`)
        : (lang === 'ru' ? 'Нет активных задач.'
          : lang === 'kk' ? 'Белсенді тапсырмалар жоқ.'
          : 'No active tasks.');
      await ctx.api.editMessageText(chatId, statusMsg.message_id, msg);
      return;
    }

    const lines = tasksOnDate.map((t: any) => {
      let suffix = '';
      if (t.time) suffix = ` \u00B7 ${t.time}`;
      const priorityLabel = t.priority === 'high' ? 'High'
        : t.priority === 'low' ? 'Low'
        : 'Medium';
      return `\u2014 ${t.task}${suffix} \u00B7 ${priorityLabel}`;
    });

    const header = date
      ? `${date.toUpperCase()}`
      : (lang === 'ru' ? 'АКТИВНЫЕ ЗАДАЧИ'
        : lang === 'kk' ? 'БЕЛСЕНДІ ТАПСЫРМАЛАР'
        : 'ACTIVE TASKS');

    const footer = lang === 'ru'
      ? `\n\n${tasksOnDate.length} ${tasksOnDate.length === 1 ? 'задача' : 'задач'}`
      : lang === 'kk'
      ? `\n\n${tasksOnDate.length} тапсырма`
      : `\n\n${tasksOnDate.length} task${tasksOnDate.length === 1 ? '' : 's'}`;

    await ctx.api.editMessageText(chatId, statusMsg.message_id, `${header}\n\n${lines.join('\n')}${footer}`);
    return;
  }

  // Handle action (new task) — reuse pre-computed analysis
  await handleNewTaskWithAnalysis(ctx, chatId, userId, statusMsg, analysis);
}

// Reusable new-task handler that accepts pre-computed analysis
async function handleNewTaskWithAnalysis(
  ctx: Context,
  chatId: number,
  userId: number,
  statusMsg: { message_id: number },
  analysis: any,
) {
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
