import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/services/db.js';
import {
  formatReminderConfirmation,
  getActiveReminders,
  reminders,
  scheduleReminders,
} from '../src/services/scheduler.js';
import { setReminderOffset } from '../src/services/userConfig.js';
import type { TodoItem } from '../src/types/analysis.js';

beforeEach(() => {
  reminders.length = 0;
  db.exec(`
    DELETE FROM todos;
    DELETE FROM plan_history;
    DELETE FROM plans;
    DELETE FROM users;
  `);
});

function buildFutureTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  const eventTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const hours = String(eventTime.getHours()).padStart(2, '0');
  const minutes = String(eventTime.getMinutes()).padStart(2, '0');
  const date = eventTime.toISOString().substring(0, 10);

  return {
    id: 'todo-1',
    task: 'Join call',
    priority: 'medium',
    done: false,
    time: `${hours}:${minutes}`,
    datetime: `${date}T${hours}:${minutes}:00`,
    date,
    duration: 30,
    ...overrides,
  };
}

test('formatReminderConfirmation includes only timed todos', () => {
  const message = formatReminderConfirmation(
    [
      buildFutureTodo({ task: 'Join call', location: 'Office' }),
      { id: 'todo-2', task: 'Inbox zero', priority: 'low', done: false },
    ],
    30,
    'en',
  );

  assert.match(message, /Reminder set\./);
  assert.match(message, /Join call · Office/);
  assert.doesNotMatch(message, /Inbox zero/);
});

test('scheduleReminders uses the user reminder offset and deduplicates task ids', () => {
  const chatId = 801;
  const userId = 901;
  const todo = buildFutureTodo();

  setReminderOffset(userId, 15);
  scheduleReminders(chatId, userId, [todo], 'en');
  scheduleReminders(chatId, userId, [todo], 'en');

  const active = getActiveReminders();

  assert.equal(active.length, 1);
  assert.equal(active[0]?.taskId, todo.id);
  assert.equal(active[0]?.offsetMinutes, 15);
});

test('scheduleReminders skips past events', () => {
  const eventTime = new Date(Date.now() - 60 * 60 * 1000);
  const hours = String(eventTime.getHours()).padStart(2, '0');
  const minutes = String(eventTime.getMinutes()).padStart(2, '0');
  const date = eventTime.toISOString().substring(0, 10);

  scheduleReminders(
    802,
    902,
    [{
      id: 'todo-past',
      task: 'Past task',
      priority: 'medium',
      done: false,
      time: `${hours}:${minutes}`,
      datetime: `${date}T${hours}:${minutes}:00`,
      date,
    }],
    'en',
    10,
  );

  assert.equal(getActiveReminders().length, 0);
});
