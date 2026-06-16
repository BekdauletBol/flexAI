import { logger } from '../logger.js';
import { Bot, InlineKeyboard } from 'grammy';
import { TodoItem } from '../types/analysis.js';
import { getUserConfig } from './userConfig.js';
import { getPlan } from './planStore.js';

interface ScheduledReminder {
  chatId: number;
  taskId?: string;
  task: string;
  location?: string;
  timeStr: string;    // "15:00" or "2026-07-15 15:00"
  triggerAt: number;   // Unix ms
  notified: boolean;
  language: string;
  offsetMinutes: number;
  snoozedUntil?: number;
}

export const reminders: ScheduledReminder[] = [];
let bot: Bot | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

export function initScheduler(botInstance: Bot) {
  bot = botInstance;
  intervalId = setInterval(checkReminders, 30_000);
  logger.info('[Scheduler] Started — checking every 30s');
}

/** Parse a todo's datetime into a Date object. Returns null on failure. */
function getEventTime(todo: TodoItem): Date | null {
  // Priority: datetime ISO > time HH:MM (today)
  if (todo.datetime) {
    const d = new Date(todo.datetime);
    if (!isNaN(d.getTime())) return d;
  }
  if (todo.time) {
    const match = todo.time.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        const eventTime = new Date();
        eventTime.setHours(hours, minutes, 0, 0);
        return eventTime;
      }
    }
  }
  return null;
}

/**
 * Format the confirmation message sent right after scheduling.
 */
export function formatReminderConfirmation(todos: TodoItem[], offsetMinutes: number, language: string): string {
  const timedTodos = todos.filter(t => t.time);
  if (timedTodos.length === 0) return '';

  const lines: string[] = [];

  if (language === 'ru') lines.push('Напоминание установлено.');
  else if (language === 'kk') lines.push('Еске салу орнатылды.');
  else lines.push('Reminder set.');

  lines.push('');

  for (const t of timedTodos) {
    let taskLine = `— ${t.task}`;
    if (t.location) taskLine += ` · ${t.location}`;
    lines.push(taskLine);

    const eventTime = getEventTime(t);
    if (eventTime) {
      const triggerDate = new Date(eventTime.getTime() - offsetMinutes * 60 * 1000);
      const triggerH = String(triggerDate.getHours()).padStart(2, '0');
      const triggerM = String(triggerDate.getMinutes()).padStart(2, '0');
      lines.push(`— ${triggerH}:${triggerM} (${offsetMinutes} min before)`);
    }
  }

  return lines.join('\n');
}

export function scheduleReminders(chatId: number, userId: number, todos: TodoItem[], language: string, overrideOffset?: number) {
  const now = new Date();
  const userSettings = getUserConfig(userId);
  const offset = overrideOffset !== undefined ? overrideOffset : (userSettings.reminder_offset_minutes || 30);

  for (const todo of todos) {
    const eventTime = getEventTime(todo);
    if (!eventTime) continue;

    if (eventTime.getTime() < now.getTime()) {
      logger.info(`[Scheduler] Skipped "${todo.task}" at ${todo.datetime || todo.time} — already passed`);
      continue;
    }

    const triggerAt = eventTime.getTime() - offset * 60 * 1000;

    const displayTime = todo.datetime
      ? `${todo.date || todo.datetime.split('T')[0]} ${todo.time || ''}`
      : todo.time || '';

    const reminder: ScheduledReminder = {
      chatId,
      taskId: todo.id,
      task: todo.task,
      location: todo.location,
      timeStr: displayTime,
      triggerAt: triggerAt < now.getTime() ? now.getTime() + 5000 : triggerAt,
      notified: false,
      language,
      offsetMinutes: offset,
    };

    const existingIndex = reminders.findIndex(r => r.taskId === todo.id);
    if (existingIndex !== -1) reminders.splice(existingIndex, 1);

    reminders.push(reminder);
    const timeUntil = Math.round((reminder.triggerAt - now.getTime()) / 60000);
    const unit = timeUntil >= 1440 ? `${Math.round(timeUntil / 1440)}d` : `${timeUntil}min`;
    logger.info(`[Scheduler] Reminder set: "${todo.task}" at ${displayTime} (offset ${offset}m) — notify in ${unit}`);
  }
}

function parseTimeString(timeStr: string): Date | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      const d = new Date();
      d.setHours(hours, minutes, 0, 0);
      return d;
    }
  }
  const d = new Date(timeStr);
  return isNaN(d.getTime()) ? null : d;
}

/** Reschedule a single reminder (e.g. from the Mini App). */
export function rescheduleReminder(chatId: number, taskId: string, task: string, newTime: string, language: string, overrideOffset?: number) {
  const now = new Date();
  const eventTime = parseTimeString(newTime);
  if (!eventTime) return;

  const offset = overrideOffset !== undefined ? overrideOffset : 30;
  const triggerAt = eventTime.getTime() - offset * 60 * 1000;

  const reminder: ScheduledReminder = {
    chatId,
    taskId,
    task,
    timeStr: newTime,
    triggerAt: triggerAt < now.getTime() ? now.getTime() + 5000 : triggerAt,
    notified: false,
    language,
    offsetMinutes: offset,
  };

  const existingIndex = reminders.findIndex(r => r.taskId === taskId);
  if (existingIndex !== -1) reminders.splice(existingIndex, 1);

  reminders.push(reminder);
  logger.info(`[Scheduler] Rescheduled reminder for "${task}" to ${newTime}`);
}

export function updateReminderOffsets(chatId: number, offsetMinutes: number) {
  const now = Date.now();
  for (const r of reminders) {
    if (r.chatId === chatId && !r.notified) {
      // If we don't have the original event time easily available here,
      // we just nudge it. But ideally we'd recompute.
      // For now, nudge:
      r.triggerAt = now + 5000;
    }
  }
}

export function snoozeReminder(taskId: string, minutes: number) {
  const reminder = reminders.find(r => r.taskId === taskId);
  if (reminder) {
    reminder.triggerAt = Date.now() + minutes * 60 * 1000;
    reminder.notified = false;
    reminder.snoozedUntil = reminder.triggerAt;
    logger.info(`[Scheduler] Snoozed reminder for "${reminder.task}" by ${minutes} min`);
    return reminder;
  }
  return undefined;
}

export function snoozeReminderUntilMorning(taskId: string, language: string) {
  const reminder = reminders.find(r => r.taskId === taskId);
  if (reminder) {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    reminder.triggerAt = tomorrow.getTime();
    reminder.notified = false;
    reminder.snoozedUntil = reminder.triggerAt;
    logger.info(`[Scheduler] Snoozed reminder for "${reminder.task}" until tomorrow morning`);
    return reminder;
  }
  return undefined;
}

async function checkReminders() {
  if (!bot) return;
  const now = Date.now();

  for (const r of reminders) {
    if (r.notified || now < r.triggerAt) continue;

    if (r.taskId) {
      const plan = getPlan(r.chatId);
      const todo = plan?.todos.find(t => t.id === r.taskId);
      if (todo?.done) {
        r.notified = true;
        logger.info(`[Scheduler] Task "${r.task}" is already completed. Skipping reminder.`);
        continue;
      }
    }

    r.notified = true;

    const msgs: Record<string, string> = {
      en: `REMINDER\n\n— ${r.task}${r.location ? ` · ${r.location}` : ''}\n— ${r.timeStr}`,
      ru: `НАПОМИНАНИЕ\n\n— ${r.task}${r.location ? ` · ${r.location}` : ''}\n— ${r.timeStr}`,
      kk: `ЕСКЕ САЛУ\n\n— ${r.task}${r.location ? ` · ${r.location}` : ''}\n— ${r.timeStr}`,
    };
    const text = msgs[r.language] || msgs.en;

    const snooze10 = r.language === 'ru' ? '+10 мин' : r.language === 'kk' ? '+10 мин' : '+10 min';
    const snooze30 = r.language === 'ru' ? '+30 мин' : r.language === 'kk' ? '+30 мин' : '+30 min';
    const snooze60 = r.language === 'ru' ? '+1 час' : r.language === 'kk' ? '+1 сағ' : '+1 hour';
    const snoozeTmrw = r.language === 'ru' ? 'Завтра утром' : r.language === 'kk' ? 'Ертең таңертең' : 'Tomorrow morning';
    const doneLabel = r.language === 'ru' ? 'Готово ✓' : r.language === 'kk' ? 'Дайын ✓' : 'Done ✓';

    const keyboard = new InlineKeyboard()
      .text(snooze10, `snz_10_${r.taskId || '0'}`)
      .text(snooze30, `snz_30_${r.taskId || '0'}`)
      .text(snooze60, `snz_60_${r.taskId || '0'}`)
      .row()
      .text(snoozeTmrw, `snz_tmrw_${r.taskId || '0'}`)
      .text(doneLabel, `snz_done_${r.taskId || '0'}`);

    try {
      await bot.api.sendMessage(r.chatId, text, { reply_markup: keyboard });
      logger.info(`[Scheduler] Sent reminder: "${r.task}" at ${r.timeStr}`);
    } catch (err) {
      logger.error(err, '[Scheduler] Failed to send reminder');
    }
  }

  // Cleanup notified reminders older than 60s
  const cutoff = now - 60_000;
  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].notified && reminders[i].triggerAt < cutoff) {
      reminders.splice(i, 1);
    }
  }
}

export function cancelReminderByTaskId(taskId: string) {
  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].taskId === taskId) {
      reminders.splice(i, 1);
      console.log(`[Scheduler] Cancelled reminder for task ${taskId}`);
    }
  }
}

export function getActiveReminders(): ScheduledReminder[] {
  return reminders.filter(r => !r.notified);
}
