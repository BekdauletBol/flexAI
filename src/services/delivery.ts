import { Context, InputFile } from 'grammy';
import { PendingVoiceNote } from './pendingStore.js';
import { buildSummaryMessage, buildSequentialReminderMessage, getSequentialReminderKeyboard, getNavKeyboard } from './messages.js';
import { getUserConfig } from './userConfig.js';
import { getPlanForWebApp } from './planStore.js';
import { config } from '../config.js';
import { InlineKeyboard } from 'grammy';

import { generateChart } from './chart.js';
import { generatePdf } from './pdf.js';

function fileName(): string {
  const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
  return `note_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
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
    new Date(pending.createdAt)
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
    
    let chartBuf: Buffer | null = null;
    try { chartBuf = await generateChart(pending.analysis); } catch {}
    
    let pdfBuf: Buffer | null = null;
    const fn = fileName();
    try { pdfBuf = await generatePdf(pending.analysis); } catch {}
    
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
    
    // Send Chart
    if (chartBuf) {
      const chartCaption = lang === 'ru' ? 'График и приоритеты' : lang === 'kk' ? 'Уақыт кестесі мен басымдықтар' : 'Timeline and priorities';
      await ctx.replyWithPhoto(new InputFile(chartBuf, 'chart.png'), { caption: chartCaption });
    }
    
    // Send PDF
    if (pdfBuf) {
      await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: analysis.title, reply_markup: webAppKeyboard });
    } else {
      // Fallback text if PDF fails
      const txt = `# ${analysis.title}\n\n${analysis.summary}\n\n${analysis.key_points.map((p: string) => `- ${p}`).join('\n')}`;
      await ctx.replyWithDocument(new InputFile(Buffer.from(txt, 'utf-8'), fn.replace('.pdf', '.txt')), { caption: analysis.title, reply_markup: webAppKeyboard });
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
