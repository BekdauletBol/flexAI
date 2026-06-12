import { AnalysisResult, TodoItem } from '../types/analysis.js';

export interface TimeConflict {
  existing: TodoItem;
  new: TodoItem;
}

export interface PendingPlan {
  chatId: number;
  userId: number;
  analysis: AnalysisResult;
  statusMsgId: number;
  step: 'conflicts' | 'reminders' | 'done';
  totalConflicts: number;
  resolvedConflicts: Set<string>;
}

const store = new Map<number, PendingPlan>();

export function setPendingPlan(chatId: number, plan: PendingPlan) {
  store.set(chatId, plan);
}

export function getPendingPlan(chatId: number): PendingPlan | undefined {
  return store.get(chatId);
}

export function resolveConflict(chatId: number, taskId: string) {
  const plan = store.get(chatId);
  if (!plan) return false;
  plan.resolvedConflicts.add(taskId);
  return plan.resolvedConflicts.size >= plan.totalConflicts;
}

export function advanceStep(chatId: number): PendingPlan | undefined {
  const plan = store.get(chatId);
  if (!plan) return;
  if (plan.step === 'conflicts') plan.step = 'reminders';
  else if (plan.step === 'reminders') plan.step = 'done';
  return plan;
}

export function clearPendingPlan(chatId: number) {
  store.delete(chatId);
}
