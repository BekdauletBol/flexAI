import { Context, InputFile } from 'grammy';
import { PendingVoiceNote } from './pendingStore.js';
import { buildSummaryMessage, buildSequentialReminderMessage, getSequentialReminderKeyboard, getNavKeyboard } from './messages.js';
import { getUserConfig } from './userConfig.js';
import { getPlanForWebApp } from './planStore.js';
import { config } from '../config.js';
import { InlineKeyboard } from 'grammy';
import { generatePdf } from './pdf.js';
import { DateTime } from 'luxon';
import { logger } from '../logger.js';
import { scheduleReminders } from './scheduler.js';

const KZ_ZONE = 'Asia/Almaty';

function fileName(): string {
  const d = DateTime.now().setZone(KZ_ZONE);
  return `note_${d.toFormat('yyyy-MM-dd_HH-mm')}.pdf`;
}

export async function startDeliveryFlow(ctx: Context, pending: PendingVoiceNote) {
  const analysis = pending.analysis;
  const lang = analysis.language;

  // 1. Main Summary Message (as text, before the reminder loop)
  const summaryText = buildSummaryMessage(
    analysis.title,
    analysis.summary,
    pending.resolvedTodos || analysis.todos,
    analysis.tags,
    lang,
    DateTime.fromMillis(pending.createdAt)
  );

  await ctx.reply(summaryText);

  // Start Sequential Reminder Loop
  pending.reminderIndex = 0;
  await advanceReminderLoop(ctx, pending);
}

export async function advanceReminderLoop(ctx: Context, pending: PendingVoiceNote) {
  const analysis = pending.analysis;
  const lang = analysis.language;
  const userId = pending.userId;

  const todos = pending.resolvedTodos || analysis.todos;

  if (pending.reminderIndex === undefined) pending.reminderIndex = 0;

  // Skip tasks that already have an explicit time — auto-schedule at task time, no buttons
  while (pending.reminderIndex < todos.length) {
    const currentTask = todos[pending.reminderIndex];
    if (currentTask.time && (currentTask.reminder_minutes == null || currentTask.reminder_minutes === undefined)) {
      // Auto-schedule reminder at the exact task time (offset=0)
      if (ctx.chat) {
        scheduleReminders(ctx.chat.id, userId, [currentTask], lang, 0);
      }
      logger.info(`[Delivery] Auto-scheduled reminder at task time for: "${currentTask.task}" at ${currentTask.time}`);
      pending.reminderIndex++;
      continue;
    }
    break;
  }

  if (pending.reminderIndex < todos.length) {
    const currentTask = todos[pending.reminderIndex];
    const userSettings = getUserConfig(userId);
    const offset = userSettings.reminder_offset_minutes !== undefined ? userSettings.reminder_offset_minutes : 30;

    const reminderText = buildSequentialReminderMessage(currentTask.task, lang);
    const reminderKeyboard = getSequentialReminderKeyboard(pending.id, offset, lang);

    await ctx.reply(reminderText, { reply_markup: reminderKeyboard });
  } else {
    // Phase 3: Final Generation (All reminders set)
    const statusMsg = await ctx.reply('Generating final results...');

    // Sync analysis to matched resolvedTodos (incorporates all reschedules/custom times)
    pending.analysis.todos = todos;

    // Only generate PDF for meaningful plans: multiple tasks, or a single task with explicit time
    const hasMeaningfulPlan = todos.length > 1 || (todos.length === 1 && !!todos[0].time);

    // Mini App keyboard logic
    let webAppKeyboard: InlineKeyboard | undefined;
    if (config.webappUrl && ctx.chat) {
      const planData = getPlanForWebApp(ctx.chat.id);
      if (planData) {
        const base64 = Buffer.from(JSON.stringify(planData), 'utf-8').toString('base64');
        const fullUrl = `${config.webappUrl}#${base64}`;
        const btnLabel = lang === 'ru' ? 'Открыть план' : lang === 'kk' ? 'Жоспарды ашу' : 'Open plan';
        webAppKeyboard = new InlineKeyboard().webApp(btnLabel, fullUrl);
      }
    }

    if (hasMeaningfulPlan) {
      let pdfBuf: Buffer | null = null;
      const fn = fileName();
      try { pdfBuf = await generatePdf(pending.analysis); } catch (e) { logger.error('[Delivery] PDF generation failed: %s', String(e)); }

      if (pdfBuf) {
        await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: analysis.title, reply_markup: webAppKeyboard });
      } else if (webAppKeyboard) {
        await ctx.reply(analysis.title, { reply_markup: webAppKeyboard });
      }
    } else if (webAppKeyboard) {
      await ctx.reply(analysis.title, { reply_markup: webAppKeyboard });
    }

    // Delete status msg
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

    // Final completion message with Nav Keyboard
    if (lang === 'ru') {
      await ctx.reply('Все напоминания настроены.', { reply_markup: getNavKeyboard(lang) });
    } else if (lang === 'kk') {
      await ctx.reply('Барлық еске салулар орнатылды.', { reply_markup: getNavKeyboard(lang) });
    } else {
      await ctx.reply('All reminders set.', { reply_markup: getNavKeyboard(lang) });
    }
  }
}
