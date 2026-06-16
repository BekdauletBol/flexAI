import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/services/db.js';
import {
  addTodoToPlan,
  archiveCompletedTasks,
  deletePlansByDate,
  findTaskByName,
  getTasksFiltered,
  getUserTasks,
  markTaskDone,
  updateTaskDateTime,
} from '../src/services/planStore.js';

beforeEach(() => {
  db.exec(`
    DELETE FROM todos;
    DELETE FROM plan_history;
    DELETE FROM plans;
    DELETE FROM users;
    DELETE FROM sqlite_sequence WHERE name = 'plan_history';
  `);
});

test('addTodoToPlan deduplicates the same task on the same date', () => {
  const chatId = 101;
  const userId = 501;
  const date = '2026-06-20';

  const first = addTodoToPlan(chatId, userId, 'Call Alice', '09:00', 'high', date);
  const second = addTodoToPlan(chatId, userId, '  call alice  ', '09:00', 'high', date);

  const tasks = getUserTasks(userId);

  assert.equal(tasks.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(tasks[0]?.task, 'Call Alice');
});

test('updateTaskDateTime rewrites date, time, and datetime together', () => {
  const task = addTodoToPlan(102, 502, 'Dentist appointment', '09:00', 'medium', '2026-06-20');

  const updated = updateTaskDateTime(502, task.id, '2026-06-21', '14:30');

  assert.ok(updated);
  assert.equal(updated?.date, '2026-06-21');
  assert.equal(updated?.time, '14:30');
  assert.equal(updated?.datetime, '2026-06-21T14:30:00');
});

test('getTasksFiltered narrows tasks by date and priority', () => {
  addTodoToPlan(103, 503, 'High priority task', '08:00', 'high', '2026-06-20');
  addTodoToPlan(103, 503, 'Low priority task', '10:00', 'low', '2026-06-20');
  addTodoToPlan(103, 503, 'Tomorrow task', '11:00', 'high', '2026-06-21');

  const filtered = getTasksFiltered(503, {
    date: '2026-06-20',
    priority: 'high',
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.task, 'High priority task');
});

test('findTaskByName supports exact and substring lookups', () => {
  const task = addTodoToPlan(104, 504, 'Prepare investor deck', '16:00', 'high', '2026-06-20');

  const exact = findTaskByName(504, 'prepare investor deck');
  const partial = findTaskByName(504, 'investor');

  assert.ok(exact);
  assert.ok(partial);
  assert.equal(exact?.todo.id, task.id);
  assert.equal(partial?.todo.id, task.id);
});

test('archiveCompletedTasks removes only completed todos', () => {
  const doneTask = addTodoToPlan(105, 505, 'Send contract', '13:00', 'high', '2026-06-20');
  addTodoToPlan(105, 505, 'Review notes', '15:00', 'medium', '2026-06-20');
  markTaskDone(505, doneTask.id);

  const archivedCount = archiveCompletedTasks(505);
  const remaining = getUserTasks(505);

  assert.equal(archivedCount, 1);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.task, 'Review notes');
});

test('deletePlansByDate removes plan history and todos for that created date', () => {
  const today = new Date().toISOString().substring(0, 10);

  addTodoToPlan(106, 506, 'Same day task', '18:00', 'medium', today);

  const deletedCount = deletePlansByDate(506, today);

  assert.equal(deletedCount, 1);
  assert.equal(getUserTasks(506).length, 0);
});
