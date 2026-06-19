import { Context } from 'grammy';
import { InputFile } from 'grammy';
import { logger } from '../logger.js';
import { analyzeTranscript } from './analysis.js';
import { savePlan, detectTimeConflicts, completeTask, rescheduleTask, getPlan, getKzToday, getTasksFiltered, prepareReportTasks } from './planStore.js';
import { findTaskByDescription, getCompletedTasksToday } from './db.js';
import { getUserConfig } from './userConfig.js';
import { savePending } from './pendingStore.js';
import { startDeliveryFlow } from './delivery.js';
import { buildConflictMessage, getConflictKeyboard, getNavKeyboard } from './messages.js';
import { DateTime } from 'luxon';
import { scheduleReminders } from './scheduler.js';
import { AnalysisResult } from '../types/analysis.js';
import { generateDailyReportPdf } from './report.js';

function classifyIntentFast(text: string): { intent: 'complete' | 'reschedule' | 'what_done' | 'report' | 'unknown'; taskDescription?: string; newTime?: string; newDate?: string } | null {
  const lower = text.toLowerCase().trim();

  // === REPORT (fast path — no LLM needed) ===
  const reportPatterns = [
    /(?:отчёт|отчет|репорт|скинь\s+(?:задачи|план|отчёт|отчет|пдф|pdf)|покажи\s+(?:задачи|план|отчёт|отчет)|в\s+формате\s+(?:pdf|пдф)|send\s+(?:report|pdf)|show\s+(?:report|tasks|plan)|what'?s?\s+(?:on|planned))/i,
    /(?:есеп|есеп\s+бер|тапсырмаларды\s+көрсет|pdf\s+жібер|құжатты\s+жібер)/i,
  ];
  if (reportPatterns.some(p => p.test(lower))) {
    return { intent: 'report' };
  }

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
          lang === 'ru' ? `Выполнено:\n— ${task.task}`
          : `Completed:\n— ${task.task}`
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
          lang === 'ru' ? `Перенесено:\n— ${task.task} · ${timeStr}`
          : `Rescheduled:\n— ${task.task} · ${timeStr}`
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
        const lines = completed.map((t: any) => `— ${t.task}`);
        const header = lang === 'ru' ? 'ЗАВЕРШЕНО СЕГОДНЯ'
          : lang === 'kk' ? 'БҮГІН АЯҚТАЛДЫ'
          : 'COMPLETED TODAY';
        await ctx.reply(`${header}\n\n${lines.join('\n')}`);
        return;
      }

      case 'report': {
        // Direct PDF generation from SQLite — no LLM needed
        const userLang = getUserConfig(userId).language || 'ru';
        const today = getKzToday();
        const waitMsg = await ctx.reply(
          userLang === 'ru' ? 'Генерирую отчёт...'
          : userLang === 'kk' ? 'Есеп жасалуда...'
          : 'Generating report...',
        );
        try {
          const pdfBuf = await generateDailyReportPdf(userId, today, userLang);
          try { await ctx.api.deleteMessage(chatId, waitMsg.message_id); } catch {}
          await ctx.replyWithDocument(
            new InputFile(pdfBuf, `report_${today}_${DateTime.now().toMillis()}.pdf`),
            { caption: 'Report', reply_markup: getNavKeyboard(userLang) },
          );
        } catch (err: any) {
          logger.error('[PDF] Generation failed:', err.message, err.stack);
          try {
            await ctx.api.editMessageText(chatId, waitMsg.message_id,
              `[PDF] ${err.message}`,
            );
          } catch {}
        }
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
  let analysis: AnalysisResult;
  try {
    analysis = await analyzeTranscript(text, ctx.from?.id);
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
      if (t.time) suffix = ` · ${t.time}`;
      const priorityLabel = t.priority.toUpperCase();
      return `— ${t.task}${suffix} · ${priorityLabel}`;
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

  // Handle action (new task)
  const conflicts = detectTimeConflicts(userId, analysis.todos);
  
  const pendingData = {
    userId,
    chatId,
    analysis,
    conflicts,
    phase: conflicts.length > 0 ? 'conflict' as const : 'reminder' as const,
    resolvedTodos: analysis.todos,
    reminderIndex: 0,
    source: 'telegram' as const,
  };
  
  const pendingId = savePending(pendingData);

  if (conflicts.length > 0) {
    const conflictMsg = buildConflictMessage(conflicts, analysis.language);
    const keyboard = getConflictKeyboard(pendingId, analysis.language);
    await ctx.api.editMessageText(chatId, statusMsg.message_id, conflictMsg, { reply_markup: keyboard });
    return; 
  }

  try { await ctx.api.deleteMessage(chatId, statusMsg.message_id); } catch {}

  savePlan(chatId, userId, analysis, 'telegram');
  const timedTasks = analysis.todos.filter(t => t.time);
  if (timedTasks.length > 0) {
    scheduleReminders(chatId, userId, analysis.todos, analysis.language);
  }

  await startDeliveryFlow(ctx, { ...pendingData, id: pendingId, createdAt: DateTime.now().toMillis() });
}
