import { logger } from '../logger.js';
import { Bot, InlineKeyboard } from 'grammy';
import { TodoItem } from '../types/analysis.js';
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

  for (const todo of todos) {
    const eventTime = getEventTime(todo);
    if (!eventTime) continue;

    if (eventTime.toMillis() < nowMs) {
      logger.info(`[Scheduler] Skipped "${todo.task}" at ${todo.datetime || todo.time} — already passed`);
      continue;
    }

    // Determine offset: priority 1) explicit override 2) task reminder_minutes
    let offset: number | null = null;

    if (overrideOffset !== undefined) {
      offset = overrideOffset;
    } else if (todo.reminder_minutes && todo.reminder_minutes > 0) {
      offset = todo.reminder_minutes;
    }

    if (offset === null) {
      logger.info(`[Scheduler] No reminder configured for: "${todo.task}" — skipping`);
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
  // Only update reminders that were NOT explicitly set by the user
  // UserConfig offset changes never touch rows where explicitly_set = 1
  const { db } = require('../services/db.js');
  db.prepare(`
    UPDATE todos
    SET datetime = datetime(datetime, '+' || ? || ' minutes')
    WHERE chat_id = ? AND is_reminder = 1 AND notified = 0 AND done = 0 AND explicitly_set = 0
  `).run(offsetMinutes, chatId);
}

export function snoozeReminder(taskId: string, minutes: number) {
  const reminder = reminders.find(r => r.taskId === taskId);
  if (reminder) {
    reminder.triggerAt = DateTime.now().toMillis() + minutes * 60 * 1000;
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
  const nowUtc = DateTime.now().toUTC().toISO()!;
  const { db } = await import('../services/db.js');

  // Query DB for due, un-notified, non-done reminders
  const dueRows = db.prepare(`
    SELECT id, chat_id, user_id, task, datetime, location, source
    FROM todos
    WHERE is_reminder = 1
      AND datetime <= ?
      AND notified = 0
      AND done = 0
    ORDER BY datetime ASC
  `).all(nowUtc) as any[];

  if (dueRows.length === 0) return;

  for (const row of dueRows) {
    // Double-guard: skip if already notified (race condition protection)
    if (row.notified) continue;

    // Display time in KZ local with date context: "сегодня в 11:00", "завтра в 14:00"
    let displayTime = row.time || '';
    if (row.datetime) {
      const localDT = DateTime.fromISO(row.datetime, { zone: 'utc' }).setZone('Asia/Almaty');
      if (localDT.isValid) {
        const kzNow = DateTime.now().setZone('Asia/Almaty');
        const isToday = localDT.hasSame(kzNow, 'day');
        const isTomorrow = localDT.hasSame(kzNow.plus({ days: 1 }), 'day');
        const dateLabel = isToday ? 'сегодня'
          : isTomorrow ? 'завтра'
          : localDT.setLocale('ru').toFormat('d MMMM');
        displayTime = `${dateLabel} в ${localDT.toFormat('HH:mm')}`;
      }
    }

    const msgs: Record<string, string> = {
      en: `REMINDER\n\n— ${row.task}${row.location ? ` · ${row.location}` : ''}\n— ${displayTime}`,
      ru: `НАПОМИНАНИЕ\n\n— ${row.task}${row.location ? ` · ${row.location}` : ''}\n— ${displayTime}`,
      kk: `ЕСКЕ САЛУ\n\n— ${row.task}${row.location ? ` · ${row.location}` : ''}\n— ${displayTime}`,
    };

    const keyboard = new InlineKeyboard()
      .text('+10 мин', `snz_10_${row.id}`)
      .text('+30 мин', `snz_30_${row.id}`)
      .text('+1 час', `snz_60_${row.id}`)
      .row()
      .text('Завтра утром', `snz_tmrw_${row.id}`)
      .text('Готово ✓', `snz_done_${row.id}`);

    try {
      await bot.api.sendMessage(row.chat_id, msgs.en, { reply_markup: keyboard });
      logger.info(`[Scheduler] Sent reminder: "${row.task}" at ${displayTime}`);

      // Mark notified in DB immediately — never re-send
      db.prepare('UPDATE todos SET notified = 1 WHERE id = ?').run(row.id);
      logger.info(`[Scheduler] Sent + marked notified: "${row.task}"`);
    } catch (err) {
      logger.error(err, `[Scheduler] Failed to send reminder: "${row.task}"`);
    }
  }
}

export function cancelReminderByTaskId(taskId: string) {
  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].taskId === taskId) {
      reminders.splice(i, 1);
      logger.debug(`[Scheduler] Cancelled reminder for task ${taskId}`);
    }
  }
}

export function getActiveReminders(): ScheduledReminder[] {
  return reminders.filter(r => !r.notified);
}
