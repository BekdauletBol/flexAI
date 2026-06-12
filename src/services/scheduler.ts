import { logger } from '../logger.js';
import { Bot } from 'grammy';
import { TodoItem } from '../types/analysis.js';
import { getUserConfig } from './userConfig.js';
import { getPlan } from './planStore.js';

interface ScheduledReminder {
  chatId: number;
  taskId?: string;
  task: string;
  timeStr: string;    // "15:00" or "2026-07-15 15:00"
  triggerAt: number;   // Unix ms
  notified: boolean;
  language: string;
}

const reminders: ScheduledReminder[] = [];
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

export function scheduleReminders(chatId: number, userId: number, todos: TodoItem[], language: string) {
  const now = new Date();
  const userSettings = getUserConfig(userId);
  const offset = userSettings.reminder_offset_minutes || 30;

  for (const todo of todos) {
    const eventTime = getEventTime(todo);
    if (!eventTime) continue;

    // If event already passed, skip
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
      timeStr: displayTime,
      triggerAt: triggerAt < now.getTime() ? now.getTime() + 5000 : triggerAt,
      notified: false,
      language,
    };

    const existingIndex = reminders.findIndex(r => r.taskId === todo.id);
    if (existingIndex !== -1) {
      reminders.splice(existingIndex, 1);
    }

    reminders.push(reminder);
    const timeUntil = Math.round((reminder.triggerAt - now.getTime()) / 60000);
    const unit = timeUntil >= 1440 ? `${Math.round(timeUntil / 1440)}d` : `${timeUntil}min`;
    logger.info(`[Scheduler] Reminder set: "${todo.task}" at ${displayTime} (offset ${offset}m) — notify in ${unit}`);
  }
}

export function rescheduleReminder(chatId: number, taskId: string, task: string, newTime: string, language: string) {
  const now = new Date();
  const offset = 30;
  const eventTime = new Date(newTime);
  if (isNaN(eventTime.getTime())) return;

  const triggerAt = eventTime.getTime() - offset * 60 * 1000;

  const reminder: ScheduledReminder = {
    chatId,
    taskId,
    task,
    timeStr: newTime,
    triggerAt: triggerAt < now.getTime() ? now.getTime() + 5000 : triggerAt,
    notified: false,
    language,
  };

  const existingIndex = reminders.findIndex(r => r.taskId === taskId);
  if (existingIndex !== -1) {
    reminders.splice(existingIndex, 1);
  }

  reminders.push(reminder);
  logger.info(`[Scheduler] Rescheduled reminder for "${task}" to ${newTime}`);
}

export function updateReminderOffsets(chatId: number, offsetMinutes: number) {
  const now = Date.now();
  for (const r of reminders) {
    if (r.chatId === chatId && !r.notified) {
      // Can't recompute without original event time
      r.triggerAt = now + 5000;
    }
  }
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
      en: `Reminder\n\nYour task "${r.task}" is scheduled at ${r.timeStr}.`,
      ru: `Напоминание\n\nЗадача "${r.task}" запланирована на ${r.timeStr}.`,
      kk: `Еске салу\n\nТапсырма "${r.task}" сағат ${r.timeStr}.`,
    };
    const text = msgs[r.language] || msgs.en;

    try {
      await bot.api.sendMessage(r.chatId, text, { parse_mode: 'Markdown' });
      logger.info(`[Scheduler] Sent reminder: "${r.task}" at ${r.timeStr}`);
    } catch (err) {
      logger.error(err, '[Scheduler] Failed to send reminder');
    }
  }

  // Cleanup old notifications (older than 1 min)
  const cutoff = now - 60_000;
  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].notified && reminders[i].triggerAt < cutoff) {
      reminders.splice(i, 1);
    }
  }
}

export function getActiveReminders(): ScheduledReminder[] {
  return reminders.filter(r => !r.notified);
}
