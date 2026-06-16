import { AnalysisResult, TodoItem, TimeFrame } from '../types/analysis.js';
import { db, detectTimeConflicts } from './db.js';
export { detectTimeConflicts };

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

export interface Conflict {
  newTodo: TodoItem;
  existingTodo: TodoItem;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToStoredPlan(row: any, todos: any[]): StoredPlan {
  return {
    chatId: row.chat_id,
    userId: row.user_id,
    title: row.title || '',
    summary: row.summary || '',
    key_points: JSON.parse(row.key_points || '[]'),
    tags: JSON.parse(row.tags || '[]'),
    language: row.language,
    createdAt: row.created_at,
    timeframe: (row.timeframe || 'day') as TimeFrame,
    periodStart: row.period_start || undefined,
    periodEnd: row.period_end || undefined,
    todos: todos.map((t: any) => ({
      id: t.id,
      task: t.task,
      priority: t.priority,
      done: !!t.done,
      time: t.time || undefined,
      datetime: t.datetime || undefined,
      date: t.date || undefined,
      duration: t.duration,
      location: t.location || undefined,
    })),
  };
}

function todoFromRow(t: any): TodoItem {
  return {
    id: t.id,
    task: t.task,
    priority: t.priority,
    done: !!t.done,
    time: t.time || undefined,
    datetime: t.datetime || undefined,
    date: t.date || undefined,
    duration: t.duration,
    location: t.location || undefined,

  };
}

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmtInsertPlanHistory = db.prepare(`
  INSERT INTO plan_history (chat_id, user_id, title, summary, key_points, tags, language, timeframe, period_start, period_end)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetLatestPlanByChat = db.prepare('SELECT * FROM plan_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1');
const stmtGetTodosByPlanId = db.prepare('SELECT * FROM todos WHERE plan_history_id = ?');
const stmtGetAllPlansByUser = db.prepare('SELECT * FROM plan_history WHERE user_id = ? ORDER BY created_at DESC');
const stmtGetAllTodosByUser = db.prepare('SELECT * FROM todos WHERE user_id = ?');
const stmtGetTodoById = db.prepare('SELECT * FROM todos WHERE id = ?');
const stmtUpdateTodoDoneByChat = db.prepare("UPDATE todos SET done = ?, completed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ? AND chat_id = ?");
const stmtUpdateTodoTimeByChat = db.prepare("UPDATE todos SET time = ?, datetime = ?, date = ? WHERE id = ? AND chat_id = ?");
const stmtUpdateTodoDateTimeByUser = db.prepare("UPDATE todos SET time = ?, date = ?, datetime = ? WHERE id = ? AND user_id = ?");
const stmtDeleteTodosByPlanId = db.prepare('DELETE FROM todos WHERE plan_history_id = ?');
const stmtDeletePlanHistory = db.prepare('DELETE FROM plan_history WHERE id = ?');
const stmtDeleteTodosByUserAndId = db.prepare('DELETE FROM todos WHERE user_id = ? AND id = ?');
const stmtDeleteAllUserPlanHistories = db.prepare('DELETE FROM plan_history WHERE user_id = ?');
const stmtDeleteAllUserTodos = db.prepare('DELETE FROM todos WHERE user_id = ?');
const stmtGetWeeklyPlans = db.prepare("SELECT * FROM plan_history WHERE user_id = ? AND created_at >= datetime('now', '-7 days') ORDER BY created_at DESC");
const stmtDeletePlanHistoriesByDate = db.prepare("SELECT id FROM plan_history WHERE user_id = ? AND substr(created_at, 1, 10) = ?");
const stmtMarkTodoDoneByUser = db.prepare("UPDATE todos SET done = 1, completed_at = datetime('now') WHERE id = ? AND user_id = ?");
const stmtCountDoneByUser = db.prepare('SELECT COUNT(*) as c FROM todos WHERE user_id = ? AND done = 1');
const stmtInsertTodo = db.prepare(`
  INSERT INTO todos (id, chat_id, user_id, task, priority, done, time, datetime, date, duration, location, plan_history_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtFindPlanByDate = db.prepare("SELECT id FROM plan_history WHERE user_id = ? AND substr(created_at, 1, 10) = ? ORDER BY created_at DESC LIMIT 1");
const stmtGetLastPlanIdByChat = db.prepare('SELECT id FROM plan_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1');
const stmtDeletePlanById = db.prepare('DELETE FROM plan_history WHERE id = ? AND user_id = ?');
const stmtDeleteTodosByPlanIdAndUser = db.prepare('DELETE FROM todos WHERE plan_history_id = ? AND user_id = ?');

// ─── Conflict Detection ────────────────────────────────────────────────────────

export function getConflicts(userId: number, newTodos: TodoItem[]): Conflict[] {
  const raw = detectTimeConflicts(userId, newTodos);
  return raw.map(r => ({
    newTodo: r.newTodo as unknown as TodoItem,
    existingTodo: r.existingTodo as unknown as TodoItem,
  }));
}

// ─── Plan Operations ──────────────────────────────────────────────────────────

export function savePlan(chatId: number, userId: number, analysis: AnalysisResult) {
  const defaultDate = new Date().toISOString().substring(0, 10);

  // 1. Insert plan_history row
  const result = stmtInsertPlanHistory.run(
    chatId,
    userId,
    analysis.title,
    analysis.summary,
    JSON.stringify(analysis.key_points || []),
    JSON.stringify(analysis.tags || []),
    analysis.language,
    analysis.timeframe || 'day',
    analysis.periodStart || null,
    analysis.periodEnd || null
  );
  const planHistoryId = result.lastInsertRowid as number;

  // Ensure user and plans rows exist for FK references
  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, language)
    VALUES (?, 'ru')
  `).run(userId);
  db.prepare(`
    INSERT OR IGNORE INTO plans (chat_id, user_id, title, summary, key_points, tags, language, created_at)
    VALUES (?, ?, '', '', '[]', '[]', ?, datetime('now'))
  `).run(chatId, userId, analysis.language);

  // 2. Insert deduplicated todos
  const existingTodos = stmtGetAllTodosByUser.all(userId) as any[];
  let insertedCount = 0;

  for (const todo of analysis.todos) {
    const taskNorm = todo.task.trim().toLowerCase();
    const todoDate = todo.date || defaultDate;

    const isDuplicate = existingTodos.some((t: any) => {
      const tDate = t.date || defaultDate;
      return t.task.trim().toLowerCase() === taskNorm && tDate === todoDate;
    });

    if (!isDuplicate) {
      stmtInsertTodo.run(
        todo.id,
        chatId,
        userId,
        todo.task || '',
        todo.priority || 'medium',
        todo.done ? 1 : 0,
        todo.time || null,
        todo.datetime || null,
        todo.date || null,
        todo.duration ?? 30,
        todo.location || null,
        planHistoryId
      );
      // Also add to existingTodos to prevent intra-batch duplicates
      existingTodos.push({ task: todo.task, date: todoDate });
      insertedCount++;
    } else {
      console.log(`[PlanStore] Silently skipped duplicate task: "${todo.task}" for ${todoDate}`);
    }
  }

  console.log(`[PlanStore] Saved plan for user ${userId} / chat ${chatId}: "${analysis.title}" (${insertedCount} todos, ${analysis.timeframe})`);
}

export function getPlan(chatId: number): StoredPlan | undefined {
  const row = stmtGetLatestPlanByChat.get(chatId) as any;
  if (!row) return undefined;

  const todos = stmtGetTodosByPlanId.all(row.id) as any[];
  return rowToStoredPlan(row, todos);
}

export function getUserTasks(userId: number): TodoItem[] {
  const rows = stmtGetAllTodosByUser.all(userId) as any[];
  return rows.map(todoFromRow);
}

export function getTasksFiltered(userId: number, filters: {
  date?: string | null;
  beforeTime?: string | null;
  afterTime?: string | null;
  priority?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}): TodoItem[] {
  let query = 'SELECT * FROM todos WHERE user_id = ? AND done = 0';
  const params: any[] = [userId];

  if (filters.date) {
    query += ' AND date = ?';
    params.push(filters.date);
  }
  if (filters.dateFrom) {
    query += ' AND date >= ?';
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    query += ' AND date <= ?';
    params.push(filters.dateTo);
  }
  if (filters.beforeTime) {
    query += ' AND time < ?';
    params.push(filters.beforeTime);
  }
  if (filters.afterTime) {
    query += ' AND time > ?';
    params.push(filters.afterTime);
  }
  if (filters.priority) {
    query += ' AND priority = ?';
    params.push(filters.priority);
  }

  query += ' ORDER BY date ASC, time ASC';
  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(todoFromRow);
}

export function completeTask(chatId: number, taskId: string, done: boolean): TodoItem | undefined {
  stmtUpdateTodoDoneByChat.run(done ? 1 : 0, done ? 1 : 0, taskId, chatId);
  const row = stmtGetTodoById.get(taskId) as any;
  return row ? todoFromRow(row) : undefined;
}

export function rescheduleTask(chatId: number, taskId: string, newTime: string, newDate?: string): TodoItem | undefined {
  const newDatetime = newDate && newTime ? `${newDate}T${newTime}:00` : null;
  stmtUpdateTodoTimeByChat.run(newTime, newDatetime || null, newDate || null, taskId, chatId);
  const row = stmtGetTodoById.get(taskId) as any;
  return row ? todoFromRow(row) : undefined;
}

export function updateTaskDateTime(userId: number, taskId: string, newDate: string, newTime: string): TodoItem | undefined {
  const newDatetime = `${newDate}T${newTime}:00`;
  stmtUpdateTodoDateTimeByUser.run(newTime, newDate, newDatetime, taskId, userId);
  const row = stmtGetTodoById.get(taskId) as any;
  return row ? todoFromRow(row) : undefined;
}

export function archiveCompletedTasks(userId: number): number {
  const result = stmtCountDoneByUser.get(userId) as { c: number };
  const count = result.c;
  if (count > 0) {
    db.prepare('DELETE FROM todos WHERE user_id = ? AND done = 1').run(userId);
  }
  return count;
}

export function getAllPlans(userId: number): StoredPlan[] {
  const rows = stmtGetAllPlansByUser.all(userId) as any[];
  return rows.map(row => {
    const todos = stmtGetTodosByPlanId.all(row.id) as any[];
    return rowToStoredPlan(row, todos);
  });
}

export function getPlansByTimeframe(userId: number, timeframe: TimeFrame): StoredPlan[] {
  const rows = db.prepare('SELECT * FROM plan_history WHERE user_id = ? AND timeframe = ? ORDER BY created_at DESC').all(userId, timeframe) as any[];
  return rows.map(row => {
    const todos = stmtGetTodosByPlanId.all(row.id) as any[];
    return rowToStoredPlan(row, todos);
  });
}

export function getWeeklyPlans(userId: number): StoredPlan[] {
  const rows = stmtGetWeeklyPlans.all(userId) as any[];
  return rows.map(row => {
    const todos = stmtGetTodosByPlanId.all(row.id) as any[];
    return rowToStoredPlan(row, todos);
  });
}

export function deleteTaskById(userId: number, taskId: string): TodoItem | null {
  const row = stmtGetTodoById.get(taskId) as any;
  if (!row) return null;
  stmtDeleteTodosByUserAndId.run(userId, taskId);
  return todoFromRow(row);
}

export function findTaskByText(userId: number, text: string, date?: string): { plan: StoredPlan; todo: TodoItem } | null {
  const todos = stmtGetAllTodosByUser.all(userId) as any[];
  const lower = text.toLowerCase();
  for (const t of todos) {
    if (t.task.toLowerCase().includes(lower)) {
      if (date && t.date && t.date !== date) continue;
      const planRow = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(t.plan_history_id) as any;
      if (planRow) {
        const planTodos = stmtGetTodosByPlanId.all(planRow.id) as any[];
        return { plan: rowToStoredPlan(planRow, planTodos), todo: todoFromRow(t) };
      }
      return null;
    }
  }
  return null;
}

export function deletePlansByDate(userId: number, dateStr: string): number {
  const ids = stmtDeletePlanHistoriesByDate.all(userId, dateStr) as any[];
  const count = ids.length;
  if (count > 0) {
    db.transaction(() => {
      for (const row of ids) {
        stmtDeleteTodosByPlanIdAndUser.run(row.id, userId);
        stmtDeletePlanById.run(row.id, userId);
      }
    })();
  }
  return count;
}

export function deleteAllUserPlans(userId: number): void {
  db.transaction(() => {
    stmtDeleteAllUserTodos.run(userId);
    stmtDeleteAllUserPlanHistories.run(userId);
  })();
}

export function deletePlanById(userId: number, planId: string): boolean {
  const id = parseInt(planId, 10);
  if (isNaN(id)) return false;
  const row = db.prepare('SELECT id FROM plan_history WHERE id = ? AND user_id = ?').get(id, userId) as any;
  if (!row) return false;
  db.transaction(() => {
    stmtDeleteTodosByPlanIdAndUser.run(id, userId);
    stmtDeletePlanById.run(id, userId);
  })();
  return true;
}

export function getAllPlansForLLM(userId: number): string {
  const plans = getAllPlans(userId);
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

  const today = date || now.toISOString().substring(0, 10);
  const taskNorm = task.trim().toLowerCase();

  // Ensure parent rows exist for foreign-keyed todo inserts.
  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, language)
    VALUES (?, 'en')
  `).run(userId);
  db.prepare(`
    INSERT OR IGNORE INTO plans (chat_id, user_id, title, summary, key_points, tags, language, created_at)
    VALUES (?, ?, '', '', '[]', '[]', 'en', datetime('now'))
  `).run(chatId, userId);

  // Check for duplicates
  const existingTodos = stmtGetAllTodosByUser.all(userId) as any[];
  const isDuplicate = existingTodos.some((t: any) => {
    const tDate = t.date || today;
    return t.task.trim().toLowerCase() === taskNorm && tDate === today;
  });

  if (isDuplicate) {
    const dup = existingTodos.find((t: any) => {
      const tDate = t.date || today;
      return t.task.trim().toLowerCase() === taskNorm && tDate === today;
    });
    return dup ? todoFromRow(dup) : todo;
  }

  // Find existing plan or create one
  let planId: number | null = null;
  const existingPlan = stmtFindPlanByDate.get(userId, today) as any;
  if (existingPlan) {
    planId = existingPlan.id;
  } else {
    const result = stmtInsertPlanHistory.run(
      chatId, userId,
      `Plan for ${today}`, '', '[]', '[]',
      'en', 'day', today, today
    );
    planId = result.lastInsertRowid as number;
  }

  stmtInsertTodo.run(
    todo.id, chatId, userId, todo.task, todo.priority || 'medium',
    todo.done ? 1 : 0, todo.time || null, null, todo.date || null,
    todo.duration ?? 30, todo.location || null, planId
  );

  console.log(`[PlanStore] Added todo: "${task}" at ${time} for ${today}`);
  return todo;
}

export function findTasksByName(userId: number, text: string): { plan: StoredPlan; todo: TodoItem }[] {
  const todos = stmtGetAllTodosByUser.all(userId) as any[];
  const lower = text.toLowerCase().trim();
  const results: { plan: StoredPlan; todo: TodoItem }[] = [];
  const seenPlanIds = new Map<number, StoredPlan>();

  for (const t of todos) {
    if (t.task.toLowerCase().includes(lower)) {
      let plan = seenPlanIds.get(t.plan_history_id);
      if (!plan && t.plan_history_id) {
        const planRow = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(t.plan_history_id) as any;
        if (planRow) {
          const ptodos = stmtGetTodosByPlanId.all(planRow.id) as any[];
          plan = rowToStoredPlan(planRow, ptodos);
          seenPlanIds.set(t.plan_history_id, plan);
        }
      }
      if (plan) {
        results.push({ plan, todo: todoFromRow(t) });
      }
    }
  }
  return results;
}

export function findTaskByName(userId: number, text: string): { plan: StoredPlan; todo: TodoItem } | null {
  const todos = stmtGetAllTodosByUser.all(userId) as any[];
  const lower = text.toLowerCase().trim();

  // Exact match first
  for (const t of todos) {
    if (t.task.toLowerCase().trim() === lower) {
      if (t.plan_history_id) {
        const planRow = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(t.plan_history_id) as any;
        if (planRow) {
          const ptodos = stmtGetTodosByPlanId.all(planRow.id) as any[];
          return { plan: rowToStoredPlan(planRow, ptodos), todo: todoFromRow(t) };
        }
      }
    }
  }

  // Substring match
  for (const t of todos) {
    if (t.task.toLowerCase().includes(lower)) {
      if (t.plan_history_id) {
        const planRow = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(t.plan_history_id) as any;
        if (planRow) {
          const ptodos = stmtGetTodosByPlanId.all(planRow.id) as any[];
          return { plan: rowToStoredPlan(planRow, ptodos), todo: todoFromRow(t) };
        }
      }
    }
  }
  return null;
}

export function markTaskDone(userId: number, taskId: string): TodoItem | undefined {
  stmtMarkTodoDoneByUser.run(taskId, userId);
  const row = stmtGetTodoById.get(taskId) as any;
  return row ? todoFromRow(row) : undefined;
}

export function getTasksForPeriod(userId: number, period: string): TodoItem[] {
  const todos = stmtGetAllTodosByUser.all(userId) as any[];
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
  for (const t of todos) {
    const todoDate = t.date || today;
    if (period === 'all') {
      results.push(todoFromRow(t));
    } else if (period === 'week') {
      if (t.plan_history_id) {
        const planRow = db.prepare('SELECT created_at FROM plan_history WHERE id = ?').get(t.plan_history_id) as any;
        if (planRow) {
          const planDate = new Date(planRow.created_at);
          const weekAgo = new Date(now);
          weekAgo.setDate(weekAgo.getDate() - 7);
          if (planDate >= weekAgo) results.push(todoFromRow(t));
        }
      }
    } else if (filterDate && todoDate === filterDate) {
      results.push(todoFromRow(t));
    }
  }
  return results;
}

export function getPlanForWebApp(chatId: number) {
  const plan = getPlan(chatId);
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
