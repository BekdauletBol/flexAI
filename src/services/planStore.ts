import { AnalysisResult, TodoItem, TimeFrame, TaskSource } from '../types/analysis.js';
import { db, DB_PATH, detectTimeConflicts, getTasksForDate, getTaskTimeRange, insertReminder } from './db.js';
import { kzLocalToUTC, utcToKzLocalDate, getKzToday, getKzTomorrow, normalizeTime } from '../utils/timezone.js';
import { DateTime } from 'luxon';
import { v4 as uuid } from 'uuid';
import { logger } from '../logger.js';
export { detectTimeConflicts, getKzToday, getKzTomorrow };

// ─── Name similarity ──────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/** Check if two task names are similar enough to be considered duplicates */
function namesAreSimilar(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return true;
  const distance = levenshtein(na, nb);
  const similarity = 1 - distance / maxLen;
  return similarity > 0.8;
}

// ─── KZ date helpers ───────────────────────────────────────────────────────────
// getKzToday() and getKzTomorrow() are now in timezone.ts (luxon-based)

export function buildScheduledTimeKz(date: string | null | undefined, time: string | null | undefined): string | null {
  if (!date) return null;
  return `${date}T${time || '00:00'}`;
}

// ─── Report task preparation ───────────────────────────────────────────────────

export function dedupeReportTasks(tasks: TodoItem[]): TodoItem[] {
  // Dedup by task name: keep the entry WITH time if both exist, prefer first occurrence
  const seen = new Map<string, number>();
  const result: TodoItem[] = [];
  for (const t of tasks) {
    const key = t.task.trim().toLowerCase();
    const existingIdx = seen.get(key);
    if (existingIdx !== undefined) {
      // Prefer entry with time — replace if current has time and existing doesn't
      if (t.time && !result[existingIdx].time) {
        result[existingIdx] = t;
      }
      continue;
    }
    seen.set(key, result.length);
    result.push(t);
  }
  return result;
}

export function prepareReportTasks(
  tasks: TodoItem[],
  targetDate: string | null,
): { tasks: TodoItem[]; overdue: TodoItem[]; summaryOverdue?: string } {
  const kzToday = getKzToday();
  const deduped = dedupeReportTasks(tasks);

  if (targetDate && targetDate !== kzToday) {
    return { tasks: deduped, overdue: [] };
  }

  const dayTasks = deduped.filter((t) => {
    const d = t.date || kzToday;
    return d === kzToday || d >= kzToday;
  });
  const overdue = deduped.filter((t) => {
    const d = t.date;
    return d && d < kzToday && !t.done;
  });

  return { tasks: dayTasks, overdue };
}

// ─── Free time gaps ────────────────────────────────────────────────────────────

const WORKDAY_START = 8 * 60;   // 08:00
const WORKDAY_END = 22 * 60;    // 22:00
const MIN_GAP_MINUTES = 20;

function timeToMinutes(time: string): number {
  const [h, m] = normalizeTime(time).split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function findFreeTimeGaps(userId: number, targetDate: string): { start: string; end: string }[] {
  const tasks = getTasksFiltered(userId, { date: targetDate }).filter((t) => t.time && !t.done);
  if (tasks.length === 0) {
    return [{ start: minutesToTime(WORKDAY_START), end: minutesToTime(WORKDAY_END) }];
  }

  const slots = tasks
    .map((t) => ({
      start: timeToMinutes(t.time!),
      end: timeToMinutes(t.time!) + (t.duration || 30),
    }))
    .sort((a, b) => a.start - b.start);

  const gaps: { start: string; end: string }[] = [];
  let cursor = WORKDAY_START;

  for (const slot of slots) {
    if (slot.start - cursor >= MIN_GAP_MINUTES) {
      gaps.push({ start: minutesToTime(cursor), end: minutesToTime(slot.start) });
    }
    cursor = Math.max(cursor, slot.end);
  }

  if (WORKDAY_END - cursor >= MIN_GAP_MINUTES) {
    gaps.push({ start: minutesToTime(cursor), end: minutesToTime(WORKDAY_END) });
  }

  return gaps;
}

export interface FreeTimeResult {
  gaps: { start: string; end: string; durationMin: number }[];
  breaks: { afterTask: string; afterTime: string; durationMin: number; beforeNextTask: string }[];
}

const MIN_BREAK_MINUTES = 15;

/** Compute free time gaps AND inter-task breaks for a given day */
export function getFreeTimeAndBreaks(userId: number, targetDate: string): FreeTimeResult {
  const tasks = getTasksFiltered(userId, { date: targetDate, includeDone: true }).filter(
    (t) => t.time && !t.done
  );

  if (tasks.length === 0) {
    return {
      gaps: [{ start: minutesToTime(WORKDAY_START), end: minutesToTime(WORKDAY_END), durationMin: WORKDAY_END - WORKDAY_START }],
      breaks: [],
    };
  }

  const slots = tasks
    .map((t) => ({
      start: timeToMinutes(t.time!),
      end: timeToMinutes(t.time!) + (t.duration || 30),
      task: t.task,
      time: t.time!,
    }))
    .sort((a, b) => a.start - b.start);

  const gaps: { start: string; end: string; durationMin: number }[] = [];
  const breaks: { afterTask: string; afterTime: string; durationMin: number; beforeNextTask: string }[] = [];
  let cursor = WORKDAY_START;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];

    // Gap before this task
    if (slot.start - cursor >= MIN_GAP_MINUTES) {
      gaps.push({
        start: minutesToTime(cursor),
        end: minutesToTime(slot.start),
        durationMin: slot.start - cursor,
      });
    }

    // Break between this task and the next
    if (i < slots.length - 1) {
      const nextSlot = slots[i + 1];
      const breakDuration = nextSlot.start - slot.end;
      if (breakDuration >= MIN_BREAK_MINUTES) {
        breaks.push({
          afterTask: slot.task,
          afterTime: minutesToTime(slot.end),
          durationMin: breakDuration,
          beforeNextTask: nextSlot.task,
        });
      }
    }

    cursor = Math.max(cursor, slot.end);
  }

  // Gap after last task
  if (WORKDAY_END - cursor >= MIN_GAP_MINUTES) {
    gaps.push({
      start: minutesToTime(cursor),
      end: minutesToTime(WORKDAY_END),
      durationMin: WORKDAY_END - cursor,
    });
  }

  return { gaps, breaks };
}

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
      source: t.source || undefined,
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
    source: t.source || undefined,
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
  INSERT INTO todos (id, chat_id, user_id, task, priority, done, time, datetime, date, duration, location, source, plan_history_id, scheduled_time_kz, is_reminder)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtFindPlanByDate = db.prepare("SELECT id FROM plan_history WHERE user_id = ? AND substr(created_at, 1, 10) = ? ORDER BY created_at DESC LIMIT 1");
const stmtGetLastPlanIdByChat = db.prepare('SELECT id FROM plan_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1');
const stmtDeletePlanById = db.prepare('DELETE FROM plan_history WHERE id = ? AND user_id = ?');
const stmtDeleteTodosByPlanIdAndUser = db.prepare('DELETE FROM todos WHERE plan_history_id = ? AND user_id = ?');

// ─── Conflict Detection ────────────────────────────────────────────────────────

export function getConflicts(userId: number, newTodos: TodoItem[], targetDate?: string): Conflict[] {
  const raw = detectTimeConflicts(userId, newTodos, targetDate);
  return raw.map(r => ({
    newTodo: r.newTodo as unknown as TodoItem,
    existingTodo: r.existingTodo as unknown as TodoItem,
  }));
}

// ─── Plan Operations ──────────────────────────────────────────────────────────

export function savePlan(chatId: number, userId: number, analysis: AnalysisResult, source: TaskSource = 'manual') {
  logger.debug({ dbPath: DB_PATH, user: userId, chat: chatId, todos: analysis.todos.length }, '[DB] savePlan called');
  const defaultDate = getKzToday();

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
  const insertedTodoIds = new Set<string>();
  const insertedThisBatch: TodoItem[] = []; // track for same-batch conflict detection

  for (const todo of analysis.todos) {
    const taskNorm = todo.task.trim().toLowerCase();
    const todoDate = todo.date || defaultDate;

    // Build a proper ISO datetime for scheduling from date + time (convert KZ UTC+5 to UTC)
    let todoDatetime = todo.datetime || null;
    if (!todoDatetime && todo.time && todoDate) {
      todoDatetime = kzLocalToUTC(todoDate, todo.time);
    }

    const isDuplicate = existingTodos.some((t: any) => {
      const tDate = t.date || defaultDate;
      return (
        t.task.trim().toLowerCase() === taskNorm &&
        tDate === todoDate &&
        (t.time || '') === (todo.time || '')
      );
    });

    // Same-batch conflict: check if this task's time overlaps with already-inserted tasks in this batch
    const batchConflict = todo.time && insertedThisBatch.some(inserted => {
      if (!inserted.time || (inserted.date || defaultDate) !== (todo.date || defaultDate)) return false;
      const aStart = timeToMinutes(todo.time!);
      const aEnd = aStart + (todo.duration || 30);
      const bStart = timeToMinutes(inserted.time!);
      const bEnd = bStart + (inserted.duration || 30);
      return aStart < bEnd && bStart < aEnd;
    });

    if (batchConflict) {
      logger.debug(`[PlanStore] Same-batch time conflict for "${todo.task}" at ${todo.time} — skipping insert`);
    }

    if (!isDuplicate && !batchConflict) {
      // FIX: Detect reminder-like tasks ("Напомнить о X", "Remind me of X")
      // and mark them as is_reminder so they don't appear in PDF task reports
      const isReminderTask = /^(напомн|remind)/i.test(todo.task);
      const isReminder = isReminderTask ? 1 : 0;
      if (isReminderTask) {
        logger.debug(`[PlanStore] Marked as reminder (hidden from reports): "${todo.task}"`);
      }

      const scheduledTimeKz = buildScheduledTimeKz(todoDate, todo.time || null);
      stmtInsertTodo.run(
        todo.id,
        chatId,
        userId,
        todo.task || '',
        todo.priority || 'medium',
        todo.done ? 1 : 0,
        todo.time || null,
        todoDatetime,
        todo.date || null,
        todo.duration ?? 30,
        todo.location || null,
        todo.source || source,
        planHistoryId,
        scheduledTimeKz,
        isReminder
      );
      logger.debug(`[DB] INSERTED todo: "${todo.task}" | date=${todoDate} time=${todo.time || '—'} | planHistoryId=${planHistoryId}`);
      // Also add to existingTodos to prevent intra-batch duplicates
      existingTodos.push({ task: todo.task, date: todoDate });
      insertedTodoIds.add(todo.id);
      insertedThisBatch.push(todo);
      insertedCount++;
    } else {
      logger.debug(`[PlanStore] Silently skipped duplicate task: "${todo.task}" for ${todoDate}`);
    }
  }

  logger.debug(`[PlanStore] Saved plan for user ${userId} / chat ${chatId}: "${analysis.title}" (${insertedCount} todos, ${analysis.timeframe})`);

  // Compound reminder: for any todo with reminder_minutes, create a DB reminder row
  // scheduled at task.scheduled_at - reminder_minutes (using Luxon for correct timezone math)
  // Only create reminders for tasks that were actually inserted (not duplicates)
  for (const todo of analysis.todos) {
    // STRICT: ONLY create reminder if user explicitly requested it
    const hasExplicitReminder =
      (todo.reminder_minutes != null && todo.reminder_minutes > 0) ||
      ((todo as any).reminder_at != null && (todo as any).reminder_at !== '');

    if (!hasExplicitReminder) {
      console.log('[PlanStore] Skipping reminder for:', todo.task, '— not explicitly requested by user');
      continue;
    }

    if (todo.reminder_minutes && todo.reminder_minutes > 0 && todo.id && insertedTodoIds.has(todo.id)) {
      const todoDate = todo.date || getKzToday();
      const taskDatetime = todo.datetime || (todo.time ? kzLocalToUTC(todoDate, todo.time) : null);
      if (!taskDatetime) continue;

      console.log('[PlanStore] Creating reminder for:', todo.task, '| minutes:', todo.reminder_minutes, '| at:', (todo as any).reminder_at);

      // Calculate reminder fire time in local timezone, then convert to UTC
      // Never mix UTC and local DateTime objects in the same calculation
      const taskLocalTime = DateTime.fromISO(taskDatetime, { zone: 'utc' }).setZone('Asia/Almaty');
      if (!taskLocalTime.isValid) continue;

      const reminderFireLocal = taskLocalTime.minus({ minutes: todo.reminder_minutes });
      if (reminderFireLocal.toMillis() <= DateTime.now().toMillis()) continue;

      const reminderFireUTC = reminderFireLocal.toUTC().toISO()!;

      // Ensure FK row exists
      db.prepare(`
        INSERT OR IGNORE INTO plans (chat_id, user_id, title, summary, key_points, tags, language, created_at)
        VALUES (?, ?, '', '', '[]', '[]', ?, datetime('now'))
      `).run(chatId, userId, analysis.language);

      const reminderId = insertReminder(userId, chatId, todo.task, reminderFireUTC, todo.id, todo.reminder_minutes);

      logger.debug({ taskId: todo.id, reminderId, reminderMinutes: todo.reminder_minutes, reminderAt: reminderFireUTC }, '[PlanStore] Created compound reminder');
    }
  }
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
  source?: TaskSource | null;
  includeDone?: boolean;
}): TodoItem[] {
  let query = 'SELECT DISTINCT * FROM todos WHERE user_id = ?';
  const params: any[] = [userId];

  // Exclude reminder-type entries — only real tasks
  query += ' AND (is_reminder IS NULL OR is_reminder = 0)';

  if (!filters.includeDone) {
    query += ' AND done = 0';
  }

  if (filters.date) {
    query += " AND substr(COALESCE(scheduled_time_kz, date || 'T' || COALESCE(time, '00:00')), 1, 10) = ?";
    params.push(filters.date);
  }
  if (filters.dateFrom) {
    query += " AND substr(COALESCE(scheduled_time_kz, date || 'T' || COALESCE(time, '00:00')), 1, 10) >= ?";
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    query += " AND substr(COALESCE(scheduled_time_kz, date || 'T' || COALESCE(time, '00:00')), 1, 10) <= ?";
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
  if (filters.source) {
    query += ' AND source = ?';
    params.push(filters.source);
  }

  query += ' ORDER BY date ASC, time ASC';
  const rows = db.prepare(query).all(...params) as any[];

  // Log row count for debugging duplicate issues
  console.log('[getTasksFiltered] Rows from DB:', rows.length, '| date:', filters.date, '| dateFrom:', filters.dateFrom, '| dateTo:', filters.dateTo);

  return rows.map(todoFromRow);
}

export function completeTask(chatId: number, taskId: string, done: boolean): TodoItem | undefined {
  stmtUpdateTodoDoneByChat.run(done ? 1 : 0, done ? 1 : 0, taskId, chatId);
  const row = stmtGetTodoById.get(taskId) as any;
  return row ? todoFromRow(row) : undefined;
}

export function rescheduleTask(chatId: number, taskId: string, newTime: string, newDate?: string): TodoItem | undefined {
  const oldRow = stmtGetTodoById.get(taskId) as any;
  const newDatetime = newDate && newTime ? kzLocalToUTC(newDate, newTime) : null;
  const scheduledTimeKz = buildScheduledTimeKz(newDate || null, newTime);
  db.prepare("UPDATE todos SET time = ?, datetime = ?, date = ?, scheduled_time_kz = ? WHERE id = ? AND chat_id = ?")
    .run(newTime, newDatetime || null, newDate || null, scheduledTimeKz, taskId, chatId);
  const row = stmtGetTodoById.get(taskId) as any;
  console.log('[Reschedule] Task updated:', oldRow?.task, 'old time:', oldRow?.time, '→ new time:', newTime, 'triggered by: rescheduleTask');
  return row ? todoFromRow(row) : undefined;
}

export function updateTaskDateTime(userId: number, taskId: string, newDate: string, newTime: string): TodoItem | undefined {
  const oldRow = stmtGetTodoById.get(taskId) as any;
  const newDatetime = kzLocalToUTC(newDate, newTime);
  const scheduledTimeKz = buildScheduledTimeKz(newDate, newTime);
  db.prepare("UPDATE todos SET time = ?, date = ?, datetime = ?, scheduled_time_kz = ? WHERE id = ? AND user_id = ?")
    .run(newTime, newDate, newDatetime, scheduledTimeKz, taskId, userId);
  const row = stmtGetTodoById.get(taskId) as any;
  console.log('[Reschedule] Task updated:', oldRow?.task, 'old time:', oldRow?.time, '→ new time:', newTime, 'triggered by: updateTaskDateTime');
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

export function addTodoToPlan(
  chatId: number, userId: number, task: string, time: string,
  priority: string, date: string, source: TaskSource = 'manual',
  skipConflictCheck: boolean = false,
): TodoItem | { conflict: Conflict; pendingTodo: TodoItem } {
  const todoDate = date || getKzToday();
  const todo: TodoItem = {
    id: DateTime.now().toMillis().toString(36) + Math.random().toString(36).slice(2, 6),
    task,
    time: time || undefined,
    priority: (priority as 'high' | 'medium' | 'low') || 'medium',
    duration: 30,
    date: todoDate,
    datetime: time ? kzLocalToUTC(todoDate, time) : undefined,
    done: false,
    source,
  };

  const today = todoDate;
  const taskNorm = task.trim().toLowerCase();

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

  // Conflict detection (unless skipped — e.g. user already chose to keep/replace)
  if (!skipConflictCheck && todo.time) {
    const conflicts = detectTimeConflicts(userId, [todo], today);
    if (conflicts.length > 0) {
      return { conflict: { newTodo: todo, existingTodo: conflicts[0].existingTodo }, pendingTodo: todo };
    }
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
    todo.done ? 1 : 0, todo.time || null, todo.datetime || null, todo.date || null,
    todo.duration ?? 30, todo.location || null, todo.source || 'manual', planId,
    buildScheduledTimeKz(todoDate, todo.time || null)
  );

  // Verify persistence
  const verify = db.prepare('SELECT id, task FROM todos WHERE id = ?').get(todo.id) as any;
  logger.debug(`[DB] addTodoToPlan — "${task}" at ${time} for ${today} | planId=${planId} | verified=${!!verify}`);
  return todo;
}

/** Insert a todo directly, bypassing all checks (for conflict resolution: keep both / replace) */
export function forceInsertTodo(
  chatId: number, userId: number, todo: TodoItem, planId?: number,
) {
  const todoDate = todo.date || getKzToday();
  if (!planId) {
    const existingPlan = stmtFindPlanByDate.get(userId, todoDate) as any;
    if (existingPlan) {
      planId = existingPlan.id;
    } else {
      const result = stmtInsertPlanHistory.run(
        chatId, userId,
        `Plan for ${todoDate}`, '', '[]', '[]',
        'en', 'day', todoDate, todoDate
      );
      planId = result.lastInsertRowid as number;
    }
  }

  stmtInsertTodo.run(
    todo.id, chatId, userId, todo.task, todo.priority || 'medium',
    todo.done ? 1 : 0, todo.time || null, todo.datetime || null, todo.date || null,
    todo.duration ?? 30, todo.location || null, todo.source || 'manual', planId,
    buildScheduledTimeKz(todoDate, todo.time || null)
  );
  logger.debug(`[DB] forceInsertTodo — "${todo.task}" at ${todo.time} for ${todoDate}`);
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
  const kzToday = getKzToday();
  const kzTomorrow = getKzTomorrow();

  if (period === 'today') {
    return getTasksFiltered(userId, { date: kzToday, includeDone: true });
  }
  if (period === 'tomorrow') {
    return getTasksFiltered(userId, { date: kzTomorrow, includeDone: true });
  }
  if (period === 'week') {
    const kzNow = DateTime.now().setZone('Asia/Almaty');
    const weekStart = kzNow.startOf('week'); // Monday
    const weekEnd = weekStart.plus({ days: 6 });
    const from = weekStart.toFormat('yyyy-MM-dd');
    const to = weekEnd.toFormat('yyyy-MM-dd');
    return getTasksFiltered(userId, { dateFrom: from, dateTo: to, includeDone: true });
  }

  const todos = stmtGetAllTodosByUser.all(userId) as any[];
  return todos.map(todoFromRow);
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

interface ConflictPair {
  newTask: TodoItem;
  existingTask: TodoItem;
}

/**
 * Compare incoming image tasks against existing tasks for a date.
 * Inserts non-conflicting tasks immediately, returns conflicts for UI resolution.
 */
export function compareAndSaveImageTasks(
  chatId: number,
  userId: number,
  newTasks: TodoItem[],
  date: string,
): ConflictPair[] {
  // Load existing tasks for this date (exclude reminders — already filtered by getTasksFiltered)
  const existingTasks = getTasksFiltered(userId, { date, includeDone: true })
    .filter(t => !t.done);

  const conflicts: ConflictPair[] = [];
  const cleanTasks: TodoItem[] = [];

  for (const todo of newTasks) {
    // Assign UUID if not set
    if (!todo.id) todo.id = uuid();

    if (!todo.time) {
      cleanTasks.push(todo);
      continue;
    }

    const newStart = timeToMinutes(todo.time);
    const newEnd = newStart + (todo.duration || 30);

    // Check against existing DB tasks
    let hasConflict = false;
    for (const existing of existingTasks) {
      if (!existing.time) continue;
      const exStart = timeToMinutes(existing.time);
      const exEnd = exStart + (existing.duration || 30);

      if (newStart < exEnd && newEnd > exStart) {
        // Time overlaps — check name similarity before flagging as conflict
        if (namesAreSimilar(todo.task, existing.task)) {
          // Duplicate: same time + similar name → silently skip
          logger.debug('[Image] Duplicate detected (similar name + same time): "%s" ≈ "%s"', todo.task, existing.task);
          hasConflict = true;
          break;
        }
        conflicts.push({ newTask: todo, existingTask: existing });
        hasConflict = true;
        break;
      }
    }

    // Also check against already-accepted clean tasks in this batch
    if (!hasConflict) {
      for (const accepted of cleanTasks) {
        if (!accepted.time) continue;
        const acStart = timeToMinutes(accepted.time);
        const acEnd = acStart + (accepted.duration || 30);
        if (newStart < acEnd && newEnd > acStart) {
          // Same-batch conflict — skip this one, already-inserted wins
          hasConflict = true;
          break;
        }
      }
    }

    if (!hasConflict) {
      cleanTasks.push(todo);
    }
  }

  // Insert non-conflicting tasks
  if (cleanTasks.length > 0) {
    const analysis: AnalysisResult = {
      intent: 'action',
      title: `From screenshot — ${date}`,
      summary: `Added ${cleanTasks.length} tasks from screenshot.`,
      key_points: [],
      todos: cleanTasks,
      tags: ['#screenshot'],
      raw_transcript: '',
      language: 'ru',
      timeframe: 'day',
    };
    savePlan(chatId, userId, analysis, 'teams');
  }

  return conflicts;
}
