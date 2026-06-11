import { Bot } from 'grammy';
import { TodoItem } from '../types/analysis.js';
import { getUserConfig } from './userConfig.js';
import { getPlan } from './planStore.js';

interface ScheduledReminder {
  chatId: number;
  taskId?: string;
  task: string;
  location?: string;
  timeStr: string;    // "15:00"
  triggerAt: number;  // Unix ms
  notified: boolean;
  language: string;
  offsetMinutes: number;
}

const reminders: ScheduledReminder[] = [];
let bot: Bot | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

/** Initialize the scheduler with the bot instance. */
export function initScheduler(botInstance: Bot) {
  bot = botInstance;
  intervalId = setInterval(checkReminders, 30_000);
  console.log('[Scheduler] Started — checking every 30s');
}

/** Helper to parse "HH:MM" time string into a Date for today. */
function getEventTimeToday(timeStr: string): Date | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  const eventTime = new Date();
  eventTime.setHours(hours, minutes, 0, 0);
  return eventTime;
}

/**
 * Format the confirmation message sent right after scheduling.
 * Spec format:
 *   Reminder set.
 *   — Visit Starbucks · Mega Silkway
 *   — 14:45 (15 min before)
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

    const [h, m] = t.time!.split(':').map(Number);
    const triggerDate = new Date();
    triggerDate.setHours(h, m - offsetMinutes, 0, 0);
    const triggerH = String(triggerDate.getHours()).padStart(2, '0');
    const triggerM = String(triggerDate.getMinutes()).padStart(2, '0');
    lines.push(`— ${triggerH}:${triggerM} (${offsetMinutes} min before)`);
  }

  return lines.join('\n');
}

/** Schedule reminders for tasks that have a specific time. */
export function scheduleReminders(chatId: number, userId: number, todos: TodoItem[], language: string, overrideOffset?: number) {
  const now = new Date();
  const userSettings = getUserConfig(userId);
  const offset = overrideOffset !== undefined ? overrideOffset : (userSettings.reminder_offset_minutes || 30);

  for (const todo of todos) {
    if (!todo.time) continue;

    const eventTime = getEventTimeToday(todo.time);
    if (!eventTime) continue;

    if (eventTime.getTime() < now.getTime()) {
      console.log(`[Scheduler] Skipped "${todo.task}" at ${todo.time} — already passed`);
      continue;
    }

    const triggerAt = eventTime.getTime() - offset * 60 * 1000;

    const reminder: ScheduledReminder = {
      chatId,
      taskId: todo.id,
      task: todo.task,
      location: todo.location,
      timeStr: todo.time,
      triggerAt: triggerAt < now.getTime() ? now.getTime() + 5000 : triggerAt,
      notified: false,
      language,
      offsetMinutes: offset,
    };

    const existingIndex = reminders.findIndex(r => r.taskId === todo.id);
    if (existingIndex !== -1) reminders.splice(existingIndex, 1);

    reminders.push(reminder);
    const minsUntil = Math.round((reminder.triggerAt - now.getTime()) / 60000);
    console.log(`[Scheduler] Reminder set: "${todo.task}" at ${todo.time} (offset ${offset}m) — notify in ${minsUntil} min`);
  }
}

/** Reschedule a single reminder (e.g. from the Mini App). */
export function rescheduleReminder(chatId: number, taskId: string, task: string, newTime: string, language: string) {
  const now = new Date();
  const eventTime = getEventTimeToday(newTime);
  if (!eventTime) return;

  const offset = 30;
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
  console.log(`[Scheduler] Rescheduled reminder for "${task}" to ${newTime}`);
}

/** Update offsets of all pending reminders for a chat. */
export function updateReminderOffsets(chatId: number, offsetMinutes: number) {
  const now = Date.now();
  for (const r of reminders) {
    if (r.chatId === chatId && !r.notified) {
      const eventTime = getEventTimeToday(r.timeStr);
      if (!eventTime) continue;
      const triggerAt = eventTime.getTime() - offsetMinutes * 60 * 1000;
      r.triggerAt = triggerAt < now ? now + 5000 : triggerAt;
      r.offsetMinutes = offsetMinutes;
    }
  }
}

/** Check and fire due reminders. */
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
        console.log(`[Scheduler] Task "${r.task}" already completed. Skipping reminder.`);
        continue;
      }
    }

    r.notified = true;

    // Plain-text reminder format — no emoji, no bold markdown
    const msgs: Record<string, string> = {
      en: `Reminder\n\n— ${r.task}${r.location ? ` · ${r.location}` : ''}\n— ${r.timeStr}`,
      ru: `Напоминание\n\n— ${r.task}${r.location ? ` · ${r.location}` : ''}\n— ${r.timeStr}`,
      kk: `Еске салу\n\n— ${r.task}${r.location ? ` · ${r.location}` : ''}\n— ${r.timeStr}`,
    };
    const text = msgs[r.language] || msgs.en;

    try {
      await bot.api.sendMessage(r.chatId, text);
      console.log(`[Scheduler] Sent reminder: "${r.task}" at ${r.timeStr}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to send reminder:`, err);
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

export function getActiveReminders(): ScheduledReminder[] {
  return reminders.filter(r => !r.notified);
}
