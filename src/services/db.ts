import { logger } from '../logger.js';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DateTime } from 'luxon';
import { kzLocalToUTC } from '../utils/timezone.js';

const DB_PATH = process.env.FLEXAI_DB_PATH
  ? path.resolve(process.env.FLEXAI_DB_PATH)
  : path.resolve(process.cwd(), 'data', 'flexai.db');

// Ensure directory exists to prevent better-sqlite3 from crashing
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Clean up stale WAL/SHM files from previous crashes to prevent SQLITE_IOERR_SHMSIZE
for (const suffix of ['-wal', '-shm']) {
  const f = DB_PATH + suffix;
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (err) {
    logger.warn(`[DB] Could not remove stale ${suffix} file: ${err}`);
  }
}

const db = new Database(DB_PATH);
logger.debug('[DB] Instance path: %s', db.name || process.env.FLEXAI_DB_PATH);

// Enable WAL for better concurrent performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    language TEXT NOT NULL DEFAULT 'en',
    city TEXT,
    lat REAL,
    lng REAL,
    reminder_offset_minutes INTEGER NOT NULL DEFAULT 30
  );

  CREATE TABLE IF NOT EXISTS plans (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT,
    summary TEXT,
    key_points TEXT,
    tags TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS todos (
    id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    task TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    done INTEGER NOT NULL DEFAULT 0,
    time TEXT,
    datetime TEXT,
    date TEXT,
    duration INTEGER NOT NULL DEFAULT 30,
    location TEXT,
    source TEXT CHECK(source IN ('teams','telegram','voice','manual')),
    completed_at TEXT,
    snoozed_until TEXT,
    PRIMARY KEY (id),
    FOREIGN KEY (chat_id, user_id) REFERENCES plans(chat_id, user_id)
  );
`);

// Add columns if tables already exist (safe migration)
try { db.exec('ALTER TABLE todos ADD COLUMN completed_at TEXT'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN snoozed_until TEXT'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN plan_history_id INTEGER REFERENCES plan_history(id)'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN source TEXT'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN scheduled_time_kz TEXT'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN is_reminder INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN scheduled_at TEXT'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN duration_minutes INTEGER'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN parent_task_id TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN reminder_minutes INTEGER DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN notified INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN explicitly_set INTEGER DEFAULT 0'); } catch {}

// Backfill scheduled_time_kz from date + time for existing rows
try {
  db.exec(`
    UPDATE todos
    SET scheduled_time_kz = date || 'T' || COALESCE(time, '00:00')
    WHERE scheduled_time_kz IS NULL AND date IS NOT NULL
  `);
} catch {}

// Backfill scheduled_at from datetime for existing rows
try {
  db.exec(`
    UPDATE todos
    SET scheduled_at = datetime
    WHERE scheduled_at IS NULL AND datetime IS NOT NULL
  `);
} catch {}

// Backfill duration_minutes from duration for existing rows
try {
  db.exec(`
    UPDATE todos
    SET duration_minutes = duration
    WHERE duration_minutes IS NULL AND duration IS NOT NULL
  `);
} catch {}

// Plan history table for accumulated plans (multiple per user)
db.exec(`
  CREATE TABLE IF NOT EXISTS plan_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    key_points TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    language TEXT NOT NULL DEFAULT 'en',
    timeframe TEXT DEFAULT 'day',
    period_start TEXT,
    period_end TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Add timeframe columns to plans if missing
try { db.exec('ALTER TABLE plans ADD COLUMN timeframe TEXT DEFAULT \'day\''); } catch {}
try { db.exec('ALTER TABLE plans ADD COLUMN period_start TEXT'); } catch {}
try { db.exec('ALTER TABLE plans ADD COLUMN period_end TEXT'); } catch {}

// Prepared statements — users
const stmtGetUser = db.prepare('SELECT * FROM users WHERE user_id = ?');
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (user_id, language, city, lat, lng, reminder_offset_minutes)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    language = COALESCE(excluded.language, users.language),
    city = COALESCE(excluded.city, users.city),
    lat = COALESCE(excluded.lat, users.lat),
    lng = COALESCE(excluded.lng, users.lng),
    reminder_offset_minutes = COALESCE(excluded.reminder_offset_minutes, users.reminder_offset_minutes)
`);

// Prepared statements — plans
const stmtGetPlan = db.prepare('SELECT * FROM plans WHERE chat_id = ?');
const stmtUpsertPlan = db.prepare(`
  INSERT INTO plans (chat_id, user_id, title, summary, key_points, tags, language, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(chat_id, user_id) DO UPDATE SET
    title = excluded.title,
    summary = excluded.summary,
    key_points = excluded.key_points,
    tags = excluded.tags,
    language = excluded.language,
    created_at = datetime('now')
`);

// Prepared statements — todos
const stmtInsertTodo = db.prepare(`
  INSERT INTO todos (id, chat_id, user_id, task, priority, done, time, datetime, date, duration, location, source, plan_history_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtInsertReminder = db.prepare(`
  INSERT INTO todos (id, chat_id, user_id, task, priority, done, time, datetime, date, duration, location, source, is_reminder, explicitly_set)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetTodosByChat = db.prepare('SELECT * FROM todos WHERE chat_id = ?');
const stmtGetTodosByUser = db.prepare('SELECT * FROM todos WHERE user_id = ?');
const stmtGetTodosByPlanId = db.prepare('SELECT * FROM todos WHERE plan_history_id = ?');
const stmtUpdateTodoDone = db.prepare("UPDATE todos SET done = ?, completed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ? AND chat_id = ?");
const stmtUpdateTodoTime = db.prepare("UPDATE todos SET time = ?, datetime = ?, date = ? WHERE id = ? AND chat_id = ?");
const stmtDeletePlanTodos = db.prepare('DELETE FROM todos WHERE chat_id = ?');
const stmtDeleteTodosByPlanId = db.prepare('DELETE FROM todos WHERE plan_history_id = ?');

// Plan history prepared statements
const stmtInsertPlanHistory = db.prepare(`
  INSERT INTO plan_history (chat_id, user_id, title, summary, key_points, tags, language, timeframe, period_start, period_end)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetPlanHistoryById = db.prepare('SELECT * FROM plan_history WHERE id = ?');
const stmtGetPlanHistoriesByUser = db.prepare('SELECT * FROM plan_history WHERE user_id = ? ORDER BY created_at DESC');
const stmtGetWeeklyPlanHistories = db.prepare("SELECT * FROM plan_history WHERE user_id = ? AND created_at >= datetime('now', '-7 days') ORDER BY created_at DESC");
const stmtDeletePlanHistory = db.prepare('DELETE FROM plan_history WHERE id = ?');
const stmtDeletePlanHistoriesByUser = db.prepare('DELETE FROM plan_history WHERE user_id = ?');
const stmtDeletePlanHistoriesByDate = db.prepare("DELETE FROM plan_history WHERE user_id = ? AND substr(created_at, 1, 10) = ?");

export { db, DB_PATH };

export function migrateFromJson() {
  const count = db.prepare('SELECT COUNT(*) as c FROM plans').get() as { c: number };
  if (count.c > 0) return;

  logger.info('[DB] Attempting migration from JSON files...');
  try {
    const planPath = path.resolve(process.cwd(), 'day_plan.json');
    const userPath = path.resolve(process.cwd(), 'user_config.json');

    // Migrate users
    if (fs.existsSync(userPath)) {
      const users = JSON.parse(fs.readFileSync(userPath, 'utf-8'));
      for (const [uid, cfg] of Object.entries(users)) {
        const u = cfg as any;
        stmtUpsertUser.run(
          Number(uid),
          u.language || 'en',
          u.city || null,
          u.lat ?? null,
          u.lng ?? null,
          u.reminder_offset_minutes ?? 30
        );
      }
      logger.info(`[DB] Migrated ${Object.keys(users).length} users`);
    }

    // Migrate plans
    if (fs.existsSync(planPath)) {
      const plans = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
      for (const [chatId, plan] of Object.entries(plans)) {
        const p = plan as any;
        stmtUpsertPlan.run(
          Number(chatId),
          p.userId,
          p.title || '',
          p.summary || '',
          JSON.stringify(p.key_points || []),
          JSON.stringify(p.tags || []),
          p.language || 'en'
        );
        for (const todo of (p.todos || [])) {
          stmtInsertTodo.run(
            todo.id,
            Number(chatId),
            p.userId,
            todo.task || '',
            todo.priority || 'medium',
            todo.done ? 1 : 0,
            todo.time || null,
            todo.datetime || null,
            todo.date || null,
            todo.duration ?? 30,
            todo.location || null,
            todo.source || 'manual',  // legacy migration
            null  // plan_history_id — legacy migration
          );
        }
      }
      logger.info(`[DB] Migrated ${Object.keys(plans).length} plans`);
    }
  } catch (err) {
    logger.error(err, '[DB] Migration error (non-fatal):');
  }
}

// User operations
export function getUser(userId: number) {
  const row = stmtGetUser.get(userId) as any;
  if (!row) return null;
  return {
    language: row.language,
    city: row.city || undefined,
    lat: row.lat ?? undefined,
    lng: row.lng ?? undefined,
    reminder_offset_minutes: row.reminder_offset_minutes,
  };
}

export function upsertUser(userId: number, data: {
  language?: string;
  city?: string;
  lat?: number;
  lng?: number;
  reminder_offset_minutes?: number;
}) {
  const existing = getUser(userId);
  stmtUpsertUser.run(
    userId,
    data.language ?? existing?.language ?? 'en',
    data.city ?? existing?.city ?? null,
    data.lat ?? existing?.lat ?? null,
    data.lng ?? existing?.lng ?? null,
    data.reminder_offset_minutes ?? existing?.reminder_offset_minutes ?? 30
  );
}

// Plan operations
export function savePlan(chatId: number, userId: number, data: {
  title: string;
  summary: string;
  key_points: string[];
  todos: any[];
  tags: string[];
  language: string;
}) {
  const txn = db.transaction(() => {
    stmtUpsertPlan.run(
      chatId,
      userId,
      data.title,
      data.summary,
      JSON.stringify(data.key_points),
      JSON.stringify(data.tags),
      data.language
    );

    // Replace all todos for this chat
    stmtDeletePlanTodos.run(chatId);
    for (const todo of data.todos) {
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
        todo.source || null,
        null  // plan_history_id — legacy plan has none
      );
    }
  });
  txn();
}

export function getPlan(chatId: number) {
  const plan = db.transaction(() => {
    const pRow = stmtGetPlan.get(chatId) as any;
    if (!pRow) return null;

    const tRows = stmtGetTodosByChat.all(chatId) as any[];

    return {
      chatId: pRow.chat_id,
      userId: pRow.user_id,
      title: pRow.title || '',
      summary: pRow.summary || '',
      key_points: JSON.parse(pRow.key_points || '[]'),
      tags: JSON.parse(pRow.tags || '[]'),
      language: pRow.language,
      createdAt: pRow.created_at,
      todos: tRows.map((t: any) => ({
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
  })();
  return plan;
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
  };
}

export function completeTask(chatId: number, taskId: string, done: boolean) {
  stmtUpdateTodoDone.run(done ? 1 : 0, done ? 1 : 0, taskId, chatId);
}

export function rescheduleTask(chatId: number, taskId: string, newTime: string, newDate?: string) {
  const newDatetime = newDate && newTime ? kzLocalToUTC(newDate, newTime) : null;
  stmtUpdateTodoTime.run(newTime, newDatetime || null, newDate || null, taskId, chatId);
}

export function insertReminder(
  userId: number,
  chatId: number,
  task: string,
  scheduledAtUtc: string,
  parentTaskId?: string,
  reminderMinutes?: number,
): string {
  const id = DateTime.now().toMillis().toString(36) + Math.random().toString(36).slice(2, 6);

  // Ensure a plan exists for FK constraint
  db.prepare(`
    INSERT OR IGNORE INTO plans (chat_id, user_id, title, summary, key_points, tags, language, created_at)
    VALUES (?, ?, '', '', '[]', '[]', 'ru', datetime('now'))
  `).run(chatId, userId);

  stmtInsertReminder.run(
    id, chatId, userId, task, 'medium', 0,
    null, // time (not used for free reminders)
    scheduledAtUtc, // datetime (UTC ISO)
    scheduledAtUtc.substring(0, 10), // date
    0, // duration
    null, // location
    'voice', // source
    1, // is_reminder
    parentTaskId ? 1 : 0, // explicitly_set = 1 when created via voice command
  );

  // Link to parent task and store reminder offset
  if (parentTaskId) {
    db.prepare(`
      UPDATE todos SET parent_task_id = ?, reminder_minutes = ?, explicitly_set = 1 WHERE id = ?
    `).run(parentTaskId, reminderMinutes ?? null, id);
  }

  return id;
}

export function checkReminderConflicts(
  userId: number,
  reminderTimeUtc: string,
  windowMinutes: number = 15,
): any[] {
  // Query for non-reminder tasks within ±windowMinutes of the reminder time
  const rows = db.prepare(`
    SELECT id, task, datetime, time, date, scheduled_time_kz
    FROM todos
    WHERE user_id = ?
      AND is_reminder = 0
      AND done = 0
      AND datetime IS NOT NULL
      AND datetime BETWEEN datetime(?, '-' || ? || ' minutes') AND datetime(?, '+' || ? || ' minutes')
  `).all(userId, reminderTimeUtc, windowMinutes, reminderTimeUtc, windowMinutes) as any[];
  return rows;
}

export function getActiveReminders(userId: number): any[] {
  return db.prepare(`
    SELECT id, task, datetime, scheduled_time_kz
    FROM todos
    WHERE user_id = ? AND is_reminder = 1 AND done = 0
    AND datetime > datetime('now')
    ORDER BY datetime ASC
  `).all(userId) as any[];
}

export function deleteReminderById(userId: number, taskId: string): boolean {
  const result = db.prepare(
    'DELETE FROM todos WHERE id = ? AND user_id = ? AND is_reminder = 1'
  ).run(taskId, userId);
  return result.changes > 0;
}

export function getTodayReminderCount(userId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM todos
    WHERE user_id = ? AND is_reminder = 1
    AND DATE(datetime) = DATE('now')
  `).get(userId) as { c: number };
  return row.c;
}

export function findReminderByTask(userId: number, taskQuery: string): any | null {
  const rows = db.prepare(`
    SELECT id, task, datetime, scheduled_time_kz
    FROM todos
    WHERE user_id = ? AND is_reminder = 1 AND done = 0
    AND task LIKE '%' || ? || '%'
    ORDER BY datetime ASC
  `).all(userId, taskQuery) as any[];
  return rows.length > 0 ? rows[0] : null;
}

export function getUserTasks(userId: number) {
  const rows = stmtGetTodosByUser.all(userId) as any[];
  return rows.map((t: any) => ({
    id: t.id,
    task: t.task,
    priority: t.priority,
    done: !!t.done,
    time: t.time || undefined,
    datetime: t.datetime || undefined,
    date: t.date || undefined,
    duration: t.duration,
    location: t.location || undefined,
  }));
}

function getTimeMinutes(todo: any): number | null {
  if (todo.time) {
    const parts = todo.time.split(':');
    if (parts.length === 2) {
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }
  }
  // Prefer scheduled_at (UTC ISO), then datetime
  const isoField = todo.scheduled_at || todo.datetime;
  if (isoField) {
    const dt = DateTime.fromISO(isoField, { zone: 'utc' }).setZone('Asia/Almaty');
    if (dt.isValid) {
      return dt.hour * 60 + dt.minute;
    }
  }
  return null;
}

/** Get time range in minutes for a task (start, end) */
export function getTaskTimeRange(todo: any): { start: number; end: number } | null {
  const start = getTimeMinutes(todo);
  if (start === null) return null;
  const duration = todo.duration || todo.duration_minutes || 30;
  return { start, end: start + duration };
}

/** Fetch all non-reminder tasks for a specific date (YYYY-MM-DD) */
export function getTasksForDate(userId: number, dateStr: string): any[] {
  return db.prepare(`
    SELECT * FROM todos
    WHERE user_id = ? AND done = 0 AND is_reminder = 0
      AND (
        DATE(scheduled_at) = ?
        OR DATE(datetime) = ?
        OR date = ?
      )
    ORDER BY
      COALESCE(scheduled_at, datetime, date || 'T' || COALESCE(time, '00:00')) ASC
  `).all(userId, dateStr, dateStr, dateStr) as any[];
}

export function findTaskByDescription(chatId: number, description: string): any | null {
  const todos = stmtGetTodosByChat.all(chatId) as any[];
  const desc = description.toLowerCase().trim();
  // exact match first
  let best = todos.find(t => t.task.toLowerCase() === desc);
  if (best) return best;
  // substring match
  best = todos.find(t => t.task.toLowerCase().includes(desc) || desc.includes(t.task.toLowerCase()));
  if (best) return best;
  // word match
  const descWords = desc.split(/\s+/);
  for (const t of todos) {
    const taskWords = t.task.toLowerCase().split(/\s+/);
    const common = descWords.filter(w => taskWords.includes(w));
    if (common.length >= Math.min(descWords.length, taskWords.length) * 0.5) return t;
  }
  return null;
}

export function getCompletedTasksToday(userId: number): any[] {
  const rows = stmtGetTodosByUser.all(userId) as any[];
  const today = DateTime.now().setZone('Asia/Almaty').toFormat('yyyy-MM-dd');
  return rows.filter(t => t.done && t.completed_at && t.completed_at.startsWith(today));
}

export function detectTimeConflicts(userId: number, newTodos: any[], targetDate?: string): { existingTodo: any; newTodo: any }[] {
  const conflicts: { existingTodo: any; newTodo: any }[] = [];

  // If targetDate provided, only fetch tasks for that date; otherwise fetch all
  let existingTodos: any[];
  if (targetDate) {
    existingTodos = db.prepare(`
      SELECT * FROM todos
      WHERE user_id = ? AND done = 0
        AND (is_reminder IS NULL OR is_reminder = 0)
        AND (
          DATE(scheduled_at) = ?
          OR DATE(datetime) = ?
          OR date = ?
        )
    `).all(userId, targetDate, targetDate, targetDate) as any[];
  } else {
    existingTodos = (db.prepare('SELECT * FROM todos WHERE user_id = ? AND done = 0 AND (is_reminder IS NULL OR is_reminder = 0)').all(userId) as any[]);
  }

  for (const newTodo of newTodos) {
    const newStart = getTimeMinutes(newTodo);
    if (newStart === null) continue;

    const newDuration = newTodo.duration || newTodo.duration_minutes || 30;
    const newEnd = newStart + newDuration;

    for (const existing of existingTodos) {
      if (existing.done || existing.id === newTodo.id) continue;

      const exStart = getTimeMinutes(existing);
      if (exStart === null) continue;

      const exDuration = existing.duration || existing.duration_minutes || 30;
      const exEnd = exStart + exDuration;

      if (newStart < exEnd && newEnd > exStart) {
        conflicts.push({ existingTodo: existing, newTodo });
      }
    }
  }

  return conflicts;
}

// ─── Plan History Operations ──────────────────────────────────────────────────

export function insertPlanHistory(chatId: number, userId: number, data: {
  title: string;
  summary: string;
  key_points: string[];
  tags: string[];
  language: string;
  timeframe: string;
  periodStart?: string;
  periodEnd?: string;
}): number {
  const result = stmtInsertPlanHistory.run(
    chatId,
    userId,
    data.title,
    data.summary,
    JSON.stringify(data.key_points),
    JSON.stringify(data.tags),
    data.language,
    data.timeframe,
    data.periodStart || null,
    data.periodEnd || null
  );
  return result.lastInsertRowid as number;
}

export function insertTodoWithPlanId(todo: any, planHistoryId: number) {
  stmtInsertTodo.run(
    todo.id,
    todo.chat_id || 0,
    todo.user_id || 0,
    todo.task || '',
    todo.priority || 'medium',
    todo.done ? 1 : 0,
    todo.time || null,
    todo.datetime || null,
    todo.date || null,
    todo.duration ?? 30,
    todo.location || null,
    todo.source || null,
    planHistoryId
  );
}

export function getPlanHistoryById(id: number): any {
  return stmtGetPlanHistoryById.get(id);
}

export function getPlanHistoriesByUser(userId: number): any[] {
  return stmtGetPlanHistoriesByUser.all(userId);
}

export function getWeeklyPlanHistories(userId: number): any[] {
  return stmtGetWeeklyPlanHistories.all(userId);
}

export function getTodosByPlanId(planHistoryId: number): any[] {
  return stmtGetTodosByPlanId.all(planHistoryId);
}

export function deletePlanHistory(id: number) {
  const txn = db.transaction(() => {
    stmtDeleteTodosByPlanId.run(id);
    stmtDeletePlanHistory.run(id);
  });
  txn();
}

export function deletePlanHistoriesByUser(userId: number) {
  db.transaction(() => {
    const plans = stmtGetPlanHistoriesByUser.all(userId) as any[];
    for (const p of plans) {
      stmtDeleteTodosByPlanId.run(p.id);
    }
    stmtDeletePlanHistoriesByUser.run(userId);
  })();
}

export function deletePlanHistoriesByDate(userId: number, dateStr: string) {
  const plans = stmtDeletePlanHistoriesByDate.all(userId, dateStr) as any[];
  db.transaction(() => {
    const rows = stmtGetPlanHistoriesByUser.all(userId) as any[];
    for (const p of rows) {
      if (p.created_at && (p.created_at as string).substring(0, 10) === dateStr) {
        stmtDeleteTodosByPlanId.run(p.id);
        stmtDeletePlanHistory.run(p.id);
      }
    }
  })();
}

export function getUserCount(): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  return row.c;
}

export function registerUser(userId: number, language: string = 'en') {
  db.prepare('INSERT INTO users (user_id, language) VALUES (?, ?)').run(userId, language);
}

export function updateSnooze(taskId: string, snoozedUntil: string | null) {
  db.prepare('UPDATE todos SET snoozed_until = ? WHERE id = ?').run(snoozedUntil, taskId);
}

export function deleteTodosByUserAndId(userId: number, taskId: string) {
  db.prepare('DELETE FROM todos WHERE user_id = ? AND id = ?').run(userId, taskId);
}

/** Update all DB reminder rows linked to a parent task when the parent is rescheduled */
export function updateLinkedReminders(parentTaskId: string, newScheduledAtUtc: string) {
  db.prepare(`
    UPDATE todos
    SET datetime = ?,
        date = ?,
        notified = 0,
        snoozed_until = NULL
    WHERE parent_task_id = ?
      AND is_reminder = 1
      AND done = 0
      AND notified = 0
  `).run(newScheduledAtUtc, newScheduledAtUtc.substring(0, 10), parentTaskId);
  logger.debug(`[DB] Updated linked reminders for parent task ${parentTaskId} → ${newScheduledAtUtc}`);
}
