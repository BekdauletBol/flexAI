import { logger } from '../logger.js';
import { Bot, InlineKeyboard } from 'grammy';
import { TodoItem } from '../types/analysis.js';
import { getUserConfig } from './userConfig.js';
import { getPlan } from './planStore.js';
import { DateTime } from 'luxon';
import {
  kzLocalToUTC,
  utcToKzLocalTime,
  utcToKzLocalDate,
  parseEventTimeAsKZ,
  nowKZ,
  KZ_ZONE,
} from '../utils/timezone.js';

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

/** Parse a todo's datetime into a DateTime in KZ zone. Returns null on failure. */
function getEventTime(todo: TodoItem): DateTime | null {
  // Priority: datetime ISO (stored as UTC) > time HH:MM (interpreted as KZ local today)
  if (todo.datetime) {
    return parseEventTimeAsKZ(todo.datetime);
  }
  if (todo.time) {
    const match = todo.time.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        const kzNow = nowKZ();
        return kzNow.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
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
      const triggerTime = eventTime.minus({ minutes: offsetMinutes });
      const triggerTimeKZ = triggerTime.toFormat('HH:mm');
      lines.push(`— ${triggerTimeKZ} (${offsetMinutes} min before)`);
    }
  }

  return lines.join('\n');
}

export function scheduleReminders(chatId: number, userId: number, todos: TodoItem[], language: string, overrideOffset?: number) {
  const kzNow = nowKZ();
  const nowMs = kzNow.toMillis();
  const userSettings = getUserConfig(userId);
  const offset = overrideOffset !== undefined ? overrideOffset : (userSettings.reminder_offset_minutes || 30);

  for (const todo of todos) {
    const eventTime = getEventTime(todo);
    if (!eventTime) continue;

    if (eventTime.toMillis() < nowMs) {
      logger.info(`[Scheduler] Skipped "${todo.task}" at ${todo.datetime || todo.time} — already passed`);
      continue;
    }

    const triggerAt = eventTime.minus({ minutes: offset }).toMillis();

    // Display time in Kazakhstan local time
    let displayTime = todo.time || '';
    if (todo.datetime) {
      displayTime = eventTime.toFormat('yyyy-MM-dd HH:mm');
    }

    const reminder: ScheduledReminder = {
      chatId,
      taskId: todo.id,
      task: todo.task,
      location: todo.location,
      timeStr: displayTime,
      triggerAt: triggerAt < nowMs ? nowMs + 5000 : triggerAt,
      notified: false,
      language,
      offsetMinutes: offset,
    };

    const existingIndex = reminders.findIndex(r => r.taskId === todo.id);
    if (existingIndex !== -1) reminders.splice(existingIndex, 1);

    reminders.push(reminder);
    const timeUntil = Math.round((reminder.triggerAt - nowMs) / 60000);
    const unit = timeUntil >= 1440 ? `${Math.round(timeUntil / 1440)}d` : `${timeUntil}min`;
    logger.info(`[Scheduler] Reminder set: "${todo.task}" at ${displayTime} (offset ${offset}m) — notify in ${unit}`);
  }
}

function parseTimeString(timeStr: string): DateTime | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return nowKZ().set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
    }
  }
  const dt = DateTime.fromISO(timeStr, { zone: KZ_ZONE });
  return dt.isValid ? dt : null;
}

/** Reschedule a single reminder (e.g. from the Mini App). */
export function rescheduleReminder(chatId: number, taskId: string, task: string, newTime: string, language: string, overrideOffset?: number, newDate?: string) {
  const kzNow = nowKZ();
  const nowMs = kzNow.toMillis();
  const dateToUse = newDate || kzNow.toFormat('yyyy-MM-dd');
  const utcDateTime = kzLocalToUTC(dateToUse, newTime);
  const eventTime = parseEventTimeAsKZ(utcDateTime);
  if (!eventTime) return;

  const offset = overrideOffset !== undefined ? overrideOffset : 30;
  const triggerAt = eventTime.minus({ minutes: offset }).toMillis();

  const reminder: ScheduledReminder = {
    chatId,
    taskId,
    task,
    timeStr: newTime,
    triggerAt: triggerAt < nowMs ? nowMs + 5000 : triggerAt,
    notified: false,
    language,
    offsetMinutes: offset,
  };

  const existingIndex = reminders.findIndex(r => r.taskId === taskId);
  if (existingIndex !== -1) reminders.splice(existingIndex, 1);

  reminders.push(reminder);
  logger.info(`[Scheduler] Rescheduled reminder for "${task}" to ${newTime} on ${dateToUse}`);
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
    const tomorrowMorning = nowKZ().plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    reminder.triggerAt = tomorrowMorning.toMillis();
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
