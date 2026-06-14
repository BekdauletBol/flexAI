import { logger } from '../logger.js';
import { AnalysisResult, TodoItem } from '../types/analysis.js';
import * as db from './db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredPlan {
  chatId: number;
  userId: number;
  title: string;
  summary: string;
  key_points: string[];
  todos: TodoItem[];
  tags: string[];
  language: string;
  createdAt: string;
}

/** Conflict: a new todo overlaps an existing todo */
export interface Conflict {
  newTodo: TodoItem;
  existingTodo: TodoItem;
}

// ─── Plan Operations ──────────────────────────────────────────────────────────

export function savePlan(chatId: number, userId: number, analysis: AnalysisResult) {
  // SQLite implementation in db.ts already handles merging/upserting
  db.savePlan(chatId, userId, {
    title: analysis.title,
    summary: analysis.summary,
    key_points: analysis.key_points,
    todos: analysis.todos,
    tags: analysis.tags,
    language: analysis.language,
  });
  logger.info(`[PlanStore] Saved plan for user ${userId} / chat ${chatId}: "${analysis.title}" (${analysis.todos.length} todos)`);
}

/** Get the latest plan for a chatId (used by Mini App and scheduler). */
export function getPlan(chatId: number): StoredPlan | undefined {
  return db.getPlan(chatId) as StoredPlan | undefined;
}

/** Get ALL todos for a user across all voice notes. */
export function getUserTasks(userId: number): TodoItem[] {
  return db.getUserTasks(userId) as TodoItem[];
}

/** Mark a task done/undone. */
export function completeTask(chatId: number, taskId: string, done: boolean): TodoItem | undefined {
  const plan = db.getPlan(chatId);
  if (!plan) return undefined;
  const todo = plan.todos.find(t => t.id === taskId);
  if (!todo) return undefined;
  db.completeTask(chatId, taskId, done);
  return { ...todo, done };
}

/** Reschedule a task. */
export function rescheduleTask(chatId: number, taskId: string, newTime: string, newDate?: string): TodoItem | undefined {
  const plan = db.getPlan(chatId);
  if (!plan) return undefined;
  const todo = plan.todos.find(t => t.id === taskId);
  if (!todo) return undefined;
  db.rescheduleTask(chatId, taskId, newTime, newDate);
  return { ...todo, time: newTime, date: newDate || todo.date, datetime: newDate ? `${newDate}T${newTime}:00` : todo.datetime };
}

/** Archive (mark done) all completed tasks — used by /clear */
export function archiveCompletedTasks(userId: number): number {
  const tasks = db.getUserTasks(userId);
  const completed = tasks.filter(t => t.done);
  return completed.length;
}

/** Get past 7 days of plans for /weekly */
export function getWeeklyPlans(userId: number): StoredPlan[] {
  const allPlans = db.db.prepare('SELECT chat_id FROM plans WHERE user_id = ?').all(userId) as { chat_id: number }[];
  const plans = allPlans.map(p => db.getPlan(p.chat_id)).filter(Boolean) as StoredPlan[];
  
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  return plans.filter(p => new Date(p.createdAt) >= cutoff);
}

export function getPlanForWebApp(chatId: number) {
  return db.getPlanForWebApp(chatId);
}

export function detectTimeConflicts(userId: number, newTodos: TodoItem[]): Conflict[] {
  const conflicts = db.detectTimeConflicts(userId, newTodos);
  return conflicts.map(c => ({
    newTodo: c.new,
    existingTodo: c.existing
  }));
}
