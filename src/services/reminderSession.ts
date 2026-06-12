import { logger } from '../logger.js';
import { InlineKeyboard } from 'grammy';
import { TodoItem } from '../types/analysis.js';
import { scheduleReminders } from './scheduler.js';
import { setReminderOffset } from './userConfig.js';
import { getPlan } from './planStore.js';

export interface PendingTask {
  id: string;
  task: string;
  time: string;
}

interface PendingSession {
  chatId: number;
  userId: number;
  tasks: PendingTask[];
  language: string;
  currentTaskIndex: number;
  offsets: (number | null)[];
  messageId?: number;
  waitingCustomIndex?: number;
}

const sessions = new Map<number, PendingSession>();

export function setPendingReminderConfig(
  chatId: number,
  userId: number,
  todos: TodoItem[],
  language: string
) {
  const timed = todos.filter(t => t.time);
  if (timed.length === 0) return;

  sessions.set(chatId, {
    chatId,
    userId,
    tasks: timed.map(t => ({ id: t.id!, task: t.task, time: t.time! })),
    language,
    currentTaskIndex: 0,
    offsets: timed.map(() => null),
  });
}

export function getPendingSession(chatId: number): PendingSession | undefined {
  return sessions.get(chatId);
}

export function setWaitingCustom(chatId: number, taskIndex: number) {
  const session = sessions.get(chatId);
  if (session) session.waitingCustomIndex = taskIndex;
}

export function getWaitingCustom(chatId: number): number | undefined {
  return sessions.get(chatId)?.waitingCustomIndex;
}

export function clearWaitingCustom(chatId: number) {
  const session = sessions.get(chatId);
  if (session) session.waitingCustomIndex = undefined;
}

export function clearPendingSession(chatId: number) {
  sessions.delete(chatId);
}

const REMINDER_OPTIONS = [
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '15', value: 15 },
  { label: '30', value: 30 },
  { label: '60', value: 60 },
  { label: 'Custom', value: -1 },
];

export function getTaskKeyboard(
  taskIndex: number,
  total: number
): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Row 1: 5, 10, 15
  kb.text(`${REMINDER_OPTIONS[0].label} min`, `remind_${taskIndex}_${REMINDER_OPTIONS[0].value}`);
  kb.text(`${REMINDER_OPTIONS[1].label} min`, `remind_${taskIndex}_${REMINDER_OPTIONS[1].value}`);
  kb.text(`${REMINDER_OPTIONS[2].label} min`, `remind_${taskIndex}_${REMINDER_OPTIONS[2].value}`);
  kb.row();

  // Row 2: 30, 60, Custom
  kb.text(`${REMINDER_OPTIONS[3].label} min`, `remind_${taskIndex}_${REMINDER_OPTIONS[3].value}`);
  kb.text(`1 hour`, `remind_${taskIndex}_${REMINDER_OPTIONS[4].value}`);
  kb.text(`${REMINDER_OPTIONS[5].label}`, `remind_${taskIndex}_${REMINDER_OPTIONS[5].value}`);

  return kb;
}

export function getTaskMessage(session: PendingSession): string {
  const task = session.tasks[session.currentTaskIndex];
  return `${session.currentTaskIndex + 1}/${session.tasks.length}\n\n${task.task} \u00B7 ${task.time}\n\nRemind me:`;
}

export function applyReminderOffset(
  chatId: number,
  taskIndex: number,
  offsetMinutes: number
): { done: boolean; msg: string } {
  const session = sessions.get(chatId);
  if (!session) return { done: true, msg: '' };
  if (taskIndex >= session.tasks.length) return { done: true, msg: '' };

  session.offsets[taskIndex] = offsetMinutes;

  // Apply to scheduler
  const plan = getPlan(chatId);
  if (plan) {
    const todo = plan.todos.find(t => t.id === session.tasks[taskIndex].id);
    if (todo) {
      setReminderOffset(session.userId, offsetMinutes);
      scheduleReminders(chatId, session.userId, [todo], session.language);
    }
  }

  // Move to next task
  session.currentTaskIndex++;
  if (session.currentTaskIndex >= session.tasks.length) {
    // All done
    const lines = session.tasks.map((t, i) =>
      `\u2014 ${t.task} \u00B7 ${t.time} (${session.offsets[i]} min before)`
    ).join('\n');
    clearPendingSession(chatId);
    return { done: true, msg: `REMINDERS SET\n\n${lines}` };
  } else {
    // Show next task
    return {
      done: false,
      msg: getTaskMessage(session),
    };
  }
}


