import fs from 'fs';
import path from 'path';
import { AnalysisResult, TodoItem, TimeFrame } from '../types/analysis.js';

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
  timeframe: TimeFrame;
  periodStart?: string;
  periodEnd?: string;
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
    const content = fs.readFileSync(PLAN_PATH, 'utf-8').trim();
    if (!content) return;
    const raw = JSON.parse(content);

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
  const existing = userPlans.get(userId) || [];
  const uniqueTodos: TodoItem[] = [];
  const now = new Date();
  const defaultDate = now.toISOString().substring(0, 10);

  for (const todo of analysis.todos) {
    const taskNorm = todo.task.trim().toLowerCase();
    const todoDate = todo.date || defaultDate;

    const isDuplicate = existing.some(p => 
      p.todos.some(t => {
        const tDate = t.date || p.createdAt.substring(0, 10);
        return t.task.trim().toLowerCase() === taskNorm && tDate === todoDate;
      })
    );

    const isBatchDuplicate = uniqueTodos.some(t => {
      const tDate = t.date || defaultDate;
      return t.task.trim().toLowerCase() === taskNorm && tDate === todoDate;
    });

    if (!isDuplicate && !isBatchDuplicate) {
      uniqueTodos.push(todo);
    } else {
      console.log(`[PlanStore] Silently skipped duplicate task: "${todo.task}" for ${todoDate}`);
    }
  }

  analysis.todos = uniqueTodos;

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
    timeframe: analysis.timeframe || 'day',
    periodStart: analysis.periodStart,
    periodEnd: analysis.periodEnd,
  };

  // Accumulate — append to user's plan history
  existing.push(plan);
  userPlans.set(userId, existing);

  // Track latest per chatId for Mini App
  latestPlanByChatId.set(chatId, plan);

  persist();
  console.log(`[PlanStore] Saved plan for user ${userId} / chat ${chatId}: "${analysis.title}" (${analysis.todos.length} todos, ${analysis.timeframe})`);
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

/** Update a task's date AND time by userId + taskId. */
export function updateTaskDateTime(userId: number, taskId: string, newDate: string, newTime: string): TodoItem | undefined {
  const plans = userPlans.get(userId) || [];
  for (const plan of plans) {
    const todo = plan.todos.find(t => t.id === taskId);
    if (todo) {
      todo.date = newDate;
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

/** Get ALL plans for a user (raw objects, for view intent). */
export function getAllPlans(userId: number): StoredPlan[] {
  return userPlans.get(userId) || [];
}

/** Get plans by timeframe. */
export function getPlansByTimeframe(userId: number, timeframe: TimeFrame): StoredPlan[] {
  return (userPlans.get(userId) || []).filter(p => p.timeframe === timeframe);
}

/** Get past 7 days of plans for /weekly */
export function getWeeklyPlans(userId: number): StoredPlan[] {
  const plans = userPlans.get(userId) || [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  return plans.filter(p => new Date(p.createdAt) >= cutoff);
}

/** Delete a specific task by ID across all plans for a user. */
export function deleteTaskById(userId: number, taskId: string): TodoItem | null {
  const plans = userPlans.get(userId) || [];
  for (const plan of plans) {
    const idx = plan.todos.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      const removed = plan.todos.splice(idx, 1)[0];
      persist();
      return removed;
    }
  }
  return null;
}

/** Find a task by matching text across all plans for a user. */
export function findTaskByText(userId: number, text: string, date?: string): { plan: StoredPlan; todo: TodoItem } | null {
  const plans = userPlans.get(userId) || [];
  const lower = text.toLowerCase();
  for (const plan of plans) {
    if (date && !plan.createdAt.startsWith(date)) continue;
    for (const todo of plan.todos) {
      if (todo.task.toLowerCase().includes(lower)) {
        return { plan, todo };
      }
    }
  }
  return null;
}

/** Delete all plans for a given date (YYYY-MM-DD). */
export function deletePlansByDate(userId: number, dateStr: string): number {
  const plans = userPlans.get(userId) || [];
  const before = plans.length;
  userPlans.set(userId, plans.filter(p => {
    const planDate = p.createdAt.substring(0, 10);
    return planDate !== dateStr;
  }));
  const removed = before - (userPlans.get(userId) || []).length;
  if (removed > 0) persist();
  return removed;
}

/** Delete ALL plans for a user — /nuke command. */
export function deleteAllUserPlans(userId: number): void {
  userPlans.delete(userId);
  for (const [k, v] of latestPlanByChatId.entries()) {
    if (v.userId === userId) latestPlanByChatId.delete(k);
  }
  persist();
}

/** Delete a plan by its index within user's plan list. */
export function deletePlanById(userId: number, planId: string): boolean {
  const plans = userPlans.get(userId) || [];
  const idx = plans.findIndex(p => p.createdAt === planId);
  if (idx === -1) return false;
  plans.splice(idx, 1);
  userPlans.set(userId, plans);
  persist();
  return true;
}

/** Get all plans for a user formatted for LLM context. */
export function getAllPlansForLLM(userId: number): string {
  const plans = userPlans.get(userId) || [];
  if (plans.length === 0) return 'No plans recorded.';
  return JSON.stringify(plans.map(p => ({
    date: p.createdAt.substring(0, 10),
    title: p.title,
    timeframe: p.timeframe || 'day',
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    todos: p.todos.map(t => ({ task: t.task, time: t.time, priority: t.priority, done: t.done, location: t.location })),
  })), null, 2);
}

export function addTodoToPlan(chatId: number, userId: number, task: string, time: string, priority: string, date: string): TodoItem {
  const now = new Date();
  const todo: TodoItem = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    task,
    time: time || undefined,
    priority: (priority as 'high' | 'medium' | 'low') || 'medium',
    duration: 30,
    date: date || now.toISOString().substring(0, 10),
    done: false,
  };

  const existing = userPlans.get(userId) || [];
  const today = date || now.toISOString().substring(0, 10);
  const taskNorm = task.trim().toLowerCase();
  
  const isDuplicate = existing.some(p => 
    p.todos.some(t => {
      const tDate = t.date || p.createdAt.substring(0, 10);
      return t.task.trim().toLowerCase() === taskNorm && tDate === today;
    })
  );

  if (isDuplicate) {
    console.log(`[PlanStore] Silently skipped duplicate task: "${task}" for ${today}`);
    // Return existing task if found, otherwise return the unsaved duplicate as a stub
    let dupTodo = todo;
    for (const p of existing) {
      const found = p.todos.find(t => {
        const tDate = t.date || p.createdAt.substring(0, 10);
        return t.task.trim().toLowerCase() === taskNorm && tDate === today;
      });
      if (found) { dupTodo = found; break; }
    }
    return dupTodo;
  }

  let plan = existing.find(p => p.createdAt.startsWith(today) && p.timeframe === 'day');

  if (plan) {
    plan.todos.push(todo);
  } else {
    plan = {
      chatId,
      userId,
      title: `Plan for ${today}`,
      summary: '',
      key_points: [],
      todos: [todo],
      tags: [],
      language: 'en',
      createdAt: now.toISOString(),
      timeframe: 'day',
      periodStart: today,
      periodEnd: today,
    };
    existing.push(plan);
    userPlans.set(userId, existing);
  }

  latestPlanByChatId.set(chatId, plan);
  persist();
  console.log(`[PlanStore] Added todo: "${task}" at ${time} for ${today}`);
  return todo;
}

/** Fuzzy find tasks by name — returns ALL substring matches. */
export function findTasksByName(userId: number, text: string): { plan: StoredPlan; todo: TodoItem }[] {
  const plans = userPlans.get(userId) || [];
  const lower = text.toLowerCase().trim();
  const results: { plan: StoredPlan; todo: TodoItem }[] = [];
  for (const plan of plans) {
    for (const todo of plan.todos) {
      if (todo.task.toLowerCase().includes(lower)) {
        results.push({ plan, todo });
      }
    }
  }
  return results;
}

/** Find a single task by name — exact match first, then substring. */
export function findTaskByName(userId: number, text: string): { plan: StoredPlan; todo: TodoItem } | null {
  const plans = userPlans.get(userId) || [];
  const lower = text.toLowerCase().trim();

  for (const plan of plans) {
    for (const todo of plan.todos) {
      if (todo.task.toLowerCase().trim() === lower) {
        return { plan, todo };
      }
    }
  }

  for (const plan of plans) {
    for (const todo of plan.todos) {
      if (todo.task.toLowerCase().includes(lower)) {
        return { plan, todo };
      }
    }
  }
  return null;
}

/** Mark a task done by userId + taskId. */
export function markTaskDone(userId: number, taskId: string): TodoItem | undefined {
  const plans = userPlans.get(userId) || [];
  for (const plan of plans) {
    const todo = plan.todos.find(t => t.id === taskId);
    if (todo) {
      todo.done = true;
      persist();
      return todo;
    }
  }
  return undefined;
}

/** Get tasks for a period: today, tomorrow, week, all. */
export function getTasksForPeriod(userId: number, period: string): TodoItem[] {
  const plans = userPlans.get(userId) || [];
  const now = new Date();
  const today = now.toISOString().substring(0, 10);

  let filterDate: string | null = null;
  if (period === 'today') {
    filterDate = today;
  } else if (period === 'tomorrow') {
    const tom = new Date(now);
    tom.setDate(tom.getDate() + 1);
    filterDate = tom.toISOString().substring(0, 10);
  }

  const results: TodoItem[] = [];
  for (const plan of plans) {
    for (const todo of plan.todos) {
      const todoDate = todo.date || plan.createdAt.substring(0, 10);
      if (period === 'all') {
        results.push(todo);
      } else if (period === 'week') {
        const planDate = new Date(plan.createdAt);
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        if (planDate >= weekAgo) results.push(todo);
      } else if (filterDate && todoDate === filterDate) {
        results.push(todo);
      }
    }
  }
  return results;
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
    timeframe: plan.timeframe || 'day',
    periodStart: plan.periodStart,
    periodEnd: plan.periodEnd,
  };
}
