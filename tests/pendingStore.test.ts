import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearUserFlowState,
  clearUserState,
  deletePending,
  getPending,
  getRescheduleState,
  getUserFlowState,
  getUserPending,
  getUserState,
  savePending,
  setRescheduleState,
  setUserFlowState,
  setUserState,
} from '../src/services/pendingStore.js';
import type { AnalysisResult } from '../src/types/analysis.js';

function buildAnalysisResult(): AnalysisResult {
  return {
    intent: 'action',
    title: 'Test plan',
    summary: 'Summary',
    key_points: [],
    todos: [],
    tags: [],
    raw_transcript: 'test',
    language: 'en',
    timeframe: 'day',
  };
}

test('savePending keeps only the newest pending note per user', () => {
  const userId = 601;
  const firstId = savePending({
    chatId: 701,
    userId,
    analysis: buildAnalysisResult(),
    conflicts: [],
    phase: 'conflict',
    resolvedTodos: [],
    reminderIndex: 0,
  });

  const secondId = savePending({
    chatId: 701,
    userId,
    analysis: buildAnalysisResult(),
    conflicts: [],
    phase: 'reminder',
    resolvedTodos: [],
    reminderIndex: 1,
  });

  assert.equal(getPending(firstId), undefined);
  assert.ok(getPending(secondId));
  assert.equal(getUserPending(userId)?.id, secondId);

  deletePending(secondId);
});

test('user flow state can be stored and cleared', () => {
  const userId = 602;

  setUserFlowState(userId, { type: 'awaiting_custom_reminder', pendingId: 'pending-1', taskIndex: 2 });
  assert.deepEqual(getUserFlowState(userId), {
    type: 'awaiting_custom_reminder',
    pendingId: 'pending-1',
    taskIndex: 2,
  });

  clearUserFlowState(userId);
  assert.equal(getUserFlowState(userId), undefined);
});

test('user state can be stored and cleared', () => {
  const userId = 603;

  setUserState(userId, { flow: 'delete', pendingTaskId: 'task-1', step: 'confirm' });
  assert.deepEqual(getUserState(userId), { flow: 'delete', pendingTaskId: 'task-1', step: 'confirm' });

  clearUserState(userId);
  assert.equal(getUserState(userId), undefined);
});

test('getRescheduleState expires stale state on read', () => {
  const userId = 604;

  setRescheduleState(userId, {
    taskId: 'task-1',
    taskName: 'Call client',
    currentDate: '2026-06-20',
    currentTime: '10:00',
    chatId: 704,
    lang: 'en',
    createdAt: Date.now() - 6 * 60 * 1000,
  });

  assert.equal(getRescheduleState(userId), undefined);
});
