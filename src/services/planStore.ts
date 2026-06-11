import fs from 'fs';
import path from 'path';
import { AnalysisResult, TodoItem } from '../types/analysis.js';

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

// ─── Persistence ──────────────────────────────────────────────────────────────

const PLAN_PATH = path.resolve(process.cwd(), 'day_plan.json');

/**
 * In-memory store:
 *   userId → array of all plans (accumulative across all voice notes)
 */
const userPlans: Map<number, StoredPlan[]> = new Map();

/** Latest plan per chatId — for Mini App and /report compatibility */
const latestPlanByChatId: Map<number, StoredPlan> = new Map();

function load() {
  try {
    if (!fs.existsSync(PLAN_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8'));

    // Support both old format (Record<chatId, plan>) and new format
    if (raw.__version === 2 && raw.userPlans) {
      // New format
      for (const [k, plans] of Object.entries(raw.userPlans as Record<string, StoredPlan[]>)) {
        userPlans.set(Number(k), plans as StoredPlan[]);
      }
      for (const [k, plan] of Object.entries(raw.latestByChatId as Record<string, StoredPlan>)) {
        latestPlanByChatId.set(Number(k), plan as StoredPlan);
      }
    } else {
      // Migrate old format: each entry is a single plan keyed by chatId
      for (const [, plan] of Object.entries(raw as Record<string, StoredPlan>)) {
        const p = plan as StoredPlan;
        const existing = userPlans.get(p.userId) || [];
        existing.push(p);
        userPlans.set(p.userId, existing);
        latestPlanByChatId.set(p.chatId, p);
      }
    }
    console.log(`[PlanStore] Loaded plans for ${userPlans.size} users`);
  } catch (err) {
    console.error('[PlanStore] Load error:', err);
  }
}

function persist() {
  const obj: Record<string, StoredPlan[]> = {};
  for (const [k, v] of userPlans) obj[String(k)] = v;

  const latestObj: Record<string, StoredPlan> = {};
  for (const [k, v] of latestPlanByChatId) latestObj[String(k)] = v;

  fs.writeFileSync(PLAN_PATH, JSON.stringify({ __version: 2, userPlans: obj, latestByChatId: latestObj }, null, 2));
}

load();

// ─── Conflict Detection ────────────────────────────────────────────────────────

/**
 * Returns true if two todos overlap in time on the same date.
 * Uses "date" if present, otherwise treats both as same-day (today).
 */
function todosConflict(a: TodoItem, b: TodoItem): boolean {
  if (!a.time || !b.time) return false;

  // If dates are set and different, no conflict
  const aDate = a.date || null;
  const bDate = b.date || null;
  if (aDate && bDate && aDate !== bDate) return false;

  const toMinutes = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const aStart = toMinutes(a.time);
  const aDuration = a.duration || 30;
  const aEnd = aStart + aDuration;

  const bStart = toMinutes(b.time);
  const bDuration = b.duration || 30;
  const bEnd = bStart + bDuration;

  return aStart < bEnd && bStart < aEnd;
}

/**
 * Check incoming todos against all stored todos for this user.
 * Returns list of conflicts.
 */
export function getConflicts(userId: number, newTodos: TodoItem[]): Conflict[] {
  const existingTasks = getUserTasks(userId).filter(t => !t.done && t.time);
  const conflicts: Conflict[] = [];

  for (const newTodo of newTodos) {
    if (!newTodo.time) continue;
    for (const existing of existingTasks) {
      if (todosConflict(newTodo, existing)) {
        conflicts.push({ newTodo, existingTodo: existing });
      }
    }
  }

  return conflicts;
}

// ─── Plan Operations ──────────────────────────────────────────────────────────

export function savePlan(chatId: number, userId: number, analysis: AnalysisResult) {
  const plan: StoredPlan = {
    chatId,
    userId,
    title: analysis.title,
    summary: analysis.summary,
    key_points: analysis.key_points,
    todos: analysis.todos,
    tags: analysis.tags,
    language: analysis.language,
    createdAt: new Date().toISOString(),
  };

  // Accumulate — append to user's plan history
  const existing = userPlans.get(userId) || [];
  existing.push(plan);
  userPlans.set(userId, existing);

  // Track latest per chatId for Mini App
  latestPlanByChatId.set(chatId, plan);

  persist();
  console.log(`[PlanStore] Saved plan for user ${userId} / chat ${chatId}: "${analysis.title}" (${analysis.todos.length} todos)`);
}

/** Get the latest plan for a chatId (used by Mini App and scheduler). */
export function getPlan(chatId: number): StoredPlan | undefined {
  return latestPlanByChatId.get(chatId);
}

/** Get ALL todos for a user across all voice notes. */
export function getUserTasks(userId: number): TodoItem[] {
  const plans = userPlans.get(userId) || [];
  const all: TodoItem[] = [];
  for (const plan of plans) all.push(...plan.todos);
  return all;
}

/** Mark a task done/undone. */
export function completeTask(chatId: number, taskId: string, done: boolean): TodoItem | undefined {
  // Search across all plans for this chatId's user
  const plan = latestPlanByChatId.get(chatId);
  if (!plan) return undefined;
  const userId = plan.userId;

  const plans = userPlans.get(userId) || [];
  for (const p of plans) {
    const todo = p.todos.find(t => t.id === taskId);
    if (todo) {
      todo.done = done;
      persist();
      return todo;
    }
  }
  return undefined;
}

/** Reschedule a task. */
export function rescheduleTask(chatId: number, taskId: string, newTime: string): TodoItem | undefined {
  const plan = latestPlanByChatId.get(chatId);
  if (!plan) return undefined;
  const userId = plan.userId;

  const plans = userPlans.get(userId) || [];
  for (const p of plans) {
    const todo = p.todos.find(t => t.id === taskId);
    if (todo) {
      todo.time = newTime;
      persist();
      return todo;
    }
  }
  return undefined;
}

/** Archive (mark done) all completed tasks — used by /clear */
export function archiveCompletedTasks(userId: number): number {
  const plans = userPlans.get(userId) || [];
  let count = 0;
  for (const plan of plans) {
    for (const todo of plan.todos) {
      if (todo.done) count++;
    }
    // Remove completed todos from plan
    plan.todos = plan.todos.filter(t => !t.done);
  }
  persist();
  return count;
}

/** Get past 7 days of plans for /weekly */
export function getWeeklyPlans(userId: number): StoredPlan[] {
  const plans = userPlans.get(userId) || [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  return plans.filter(p => new Date(p.createdAt) >= cutoff);
}

export function getPlanForWebApp(chatId: number) {
  const plan = latestPlanByChatId.get(chatId);
  if (!plan) return null;
  return {
    chatId: plan.chatId,
    userId: plan.userId,
    title: plan.title,
    summary: plan.summary,
    key_points: plan.key_points,
    todos: plan.todos,
    tags: plan.tags,
    language: plan.language,
  };
}
