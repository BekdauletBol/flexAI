import { Bot } from 'grammy';
import { TodoItem } from '../types/analysis.js';
import { getUserConfig } from './userConfig.js';
import { getPlan } from './planStore.js';

interface ScheduledReminder {
  chatId: number;
  taskId?: string;
  task: string;
  timeStr: string;    // "15:00"
  triggerAt: number;   // Unix ms
  notified: boolean;
  language: string;
}

const reminders: ScheduledReminder[] = [];
let bot: Bot | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

/** Initialize the scheduler with the bot instance. */
export function initScheduler(botInstance: Bot) {
  bot = botInstance;
  // Check every 30 seconds
  intervalId = setInterval(checkReminders, 30_000);
  console.log('[Scheduler] Started — checking every 30s');
}

/** Helper to parse "HH:MM" time string into trigger date */
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

/** Schedule reminders for tasks that have a specific time. */
export function scheduleReminders(chatId: number, userId: number, todos: TodoItem[], language: string) {
  const now = new Date();
  const userSettings = getUserConfig(userId);
  const offset = userSettings.reminder_offset_minutes || 30;

  for (const todo of todos) {
    if (!todo.time) continue;

    const eventTime = getEventTimeToday(todo.time);
    if (!eventTime) continue;

    // If the event already passed today, skip
    if (eventTime.getTime() < now.getTime()) {
      console.log(`[Scheduler] Skipped "${todo.task}" at ${todo.time} — already passed`);
      continue;
    }

    // Trigger offset minutes before
    const triggerAt = eventTime.getTime() - offset * 60 * 1000;

    // If trigger time already passed but event hasn't, notify in 5 seconds
    const reminder: ScheduledReminder = {
      chatId,
      taskId: todo.id,
      task: todo.task,
      timeStr: todo.time,
      triggerAt: triggerAt < now.getTime() ? now.getTime() + 5000 : triggerAt,
      notified: false,
      language,
    };

    // Remove any pre-existing reminder for this task ID
    const existingIndex = reminders.findIndex(r => r.taskId === todo.id);
    if (existingIndex !== -1) {
      reminders.splice(existingIndex, 1);
    }

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

  // Let's retrieve user settings to know the offset (we might not have userId, so we default to 30)
  // Or we can find existing reminder to see if there's any details, but let's check config path or just default to 30
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
  };

  const existingIndex = reminders.findIndex(r => r.taskId === taskId);
  if (existingIndex !== -1) {
    reminders.splice(existingIndex, 1);
  }

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
      console.log(`[Scheduler] Adjusted reminder offset for "${r.task}" to ${offsetMinutes}m (trigger in ${Math.round((r.triggerAt - now) / 60000)}m)`);
    }
  }
}

/** Check and fire due reminders. */
async function checkReminders() {
  if (!bot) return;
  const now = Date.now();

  for (const r of reminders) {
    if (r.notified || now < r.triggerAt) continue;

    // Smart check: Skip reminder if the task is already marked done in planStore
    if (r.taskId) {
      const plan = getPlan(r.chatId);
      const todo = plan?.todos.find(t => t.id === r.taskId);
      if (todo?.done) {
        r.notified = true;
        console.log(`[Scheduler] Task "${r.task}" is already completed. Skipping reminder.`);
        continue;
      }
    }

    r.notified = true;
    const emoji = '⏰';
    const msgs: Record<string, string> = {
      en: `${emoji} *Reminder!*\n\nYour task *"${r.task}"* is scheduled at *${r.timeStr}* — don't forget! 🚀`,
      ru: `${emoji} *Напоминание!*\n\nЗадача *"${r.task}"* запланирована на *${r.timeStr}* — не забудь! 🚀`,
      kk: `${emoji} *Еске салу!*\n\nТапсырма *"${r.task}"* сағат *${r.timeStr}* — ұмытпаңыз! 🚀`,
    };
    const text = msgs[r.language] || msgs.en;

    try {
      await bot.api.sendMessage(r.chatId, text, { parse_mode: 'Markdown' });
      console.log(`[Scheduler] ✅ Sent reminder: "${r.task}" at ${r.timeStr}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to send reminder:`, err);
    }
  }

  // Cleanup old reminders
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
