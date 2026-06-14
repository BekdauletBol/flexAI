import express from 'express';
import cors from 'cors';
import path from 'path';
import { getPlan, completeTask, rescheduleTask, getAllPlans, getPlansByTimeframe, deleteTaskById, deletePlansByDate, deletePlanById, addTodoToPlan } from './services/planStore.js';
import { setReminderOffset, getUserConfig } from './services/userConfig.js';
<<<<<<< HEAD
import { rescheduleReminder, updateReminderOffsets } from './services/scheduler.js';
import { logger } from './logger.js';
=======
import { rescheduleReminder, updateReminderOffsets, cancelReminderByTaskId } from './services/scheduler.js';
import { deleteMemoryEntry, clearAllMemory, getUserMemory, formatMemoryForDisplay } from './services/memoryStore.js';
>>>>>>> 65a7f64 (add some features)

export function createServer() {
  const app = express();

<<<<<<< HEAD
  app.use(express.json({ limit: '1mb' }));

  // Simple rate limiter
  const rateLimit = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT = 100;
  const RATE_WINDOW = 60_000;

  app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimit.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_WINDOW };
      rateLimit.set(ip, entry);
    }
    entry.count++;
    if (entry.count > RATE_LIMIT) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  });
=======
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
>>>>>>> 65a7f64 (add some features)

  app.use(express.static(path.resolve('public')));
  app.use('/assets', express.static(path.resolve('assets')));

  app.get('/webapp', (req, res) => {
    res.sendFile(path.resolve('public/webapp.html'));
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.post('/api/todo/complete', (req, res) => {
    const { chatId, taskId, done } = req.body;
    if (!chatId || !taskId) {
      res.status(400).json({ error: 'Missing chatId or taskId' });
      return;
    }

    const todo = completeTask(Number(chatId), taskId, !!done);
    if (!todo) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    logger.info({ chatId, taskId, done }, 'Task completed via API');
    res.json({ success: true, todo });
  });

  app.post('/api/todo/reschedule', (req, res) => {
    const { chatId, taskId, newTime } = req.body;
    if (!chatId || !taskId || !newTime) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const todo = rescheduleTask(Number(chatId), taskId, newTime);
    if (!todo) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const plan = getPlan(Number(chatId));
    const language = plan?.language || 'en';
    const uid = plan?.userId || Number(chatId);
    const userSettings = getUserConfig(uid);
    const offset = userSettings?.reminder_offset_minutes;
    rescheduleReminder(Number(chatId), taskId, todo.task, newTime, language, offset);

    logger.info({ chatId, taskId, newTime }, 'Task rescheduled via API');
    res.json({ success: true, todo });
  });

<<<<<<< HEAD
=======
  // Delete task
  app.post('/api/todo/delete', (req, res) => {
    const { userId, taskId, date } = req.body;
    if (!userId || !taskId) {
      res.status(400).json({ error: 'Missing userId or taskId' });
      return;
    }

    cancelReminderByTaskId(taskId);
    const removed = deleteTaskById(Number(userId), taskId);
    if (!removed) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    console.log(`[API] Task deleted: "${removed.task}"`);
    res.json({ success: true, task: removed });
  });

  // Create task (from Mini App)
  app.post('/api/todo/create', (req, res) => {
    const { chatId, userId, task, time, priority, date } = req.body;
    if (!chatId || !userId || !task) {
      res.status(400).json({ error: 'Missing chatId, userId, or task' });
      return;
    }
    const todo = addTodoToPlan(Number(chatId), Number(userId), task, time || '', priority || 'medium', date || '');
    console.log(`[API] Task created: "${todo.task}"`);
    res.json({ success: true, todo });
  });

  // Delete day plan
  app.post('/api/plans/delete', (req, res) => {
    const { userId, date } = req.body;
    if (!userId || !date) {
      res.status(400).json({ error: 'Missing userId or date' });
      return;
    }

    const count = deletePlansByDate(Number(userId), date);
    console.log(`[API] Deleted ${count} plans for date ${date}`);
    res.json({ success: true, deleted: count });
  });

  // Get all plans
  app.get('/api/plans/all', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId query param' });
      return;
    }

    const plans = getAllPlans(Number(userId));
    res.json({ plans: plans.map(p => ({
      id: p.createdAt,
      date: p.createdAt.substring(0, 10),
      title: p.title,
      taskCount: p.todos.length,
      completedCount: p.todos.filter(t => t.done).length,
      timeframe: p.timeframe || 'day',
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
    }))});
  });

  // Get plans by timeframe
  app.get('/api/plans/timeframe/:timeframe', (req, res) => {
    const userId = req.query.userId;
    const timeframe = req.params.timeframe;
    if (!userId || !['day','week','month','year'].includes(timeframe)) {
      res.status(400).json({ error: 'Missing userId or invalid timeframe' });
      return;
    }

    const plans = getPlansByTimeframe(Number(userId), timeframe as any);
    res.json({ plans: plans.map(p => ({
      id: p.createdAt,
      date: p.createdAt.substring(0, 10),
      title: p.title,
      taskCount: p.todos.length,
      completedCount: p.todos.filter(t => t.done).length,
      timeframe: p.timeframe,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      todos: p.todos,
    }))});
  });

  // Delete plan by id
  app.post('/api/plans/delete/plan', (req, res) => {
    const { userId, planId } = req.body;
    if (!userId || !planId) {
      res.status(400).json({ error: 'Missing userId or planId' });
      return;
    }

    const ok = deletePlanById(Number(userId), planId);
    if (!ok) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    res.json({ success: true });
  });

  // Get plan by date
  app.get('/api/plans/:date', (req, res) => {
    const userId = req.query.userId;
    const date = req.params.date;
    if (!userId || !date) {
      res.status(400).json({ error: 'Missing userId or date' });
      return;
    }

    const allPlans = getAllPlans(Number(userId));
    const plan = allPlans.find(p => p.createdAt.substring(0, 10) === date);
    if (!plan) {
      res.status(404).json({ error: 'No plan for this date' });
      return;
    }
    res.json({ plan });
  });

  // Change reminder offset setting
>>>>>>> 65a7f64 (add some features)
  app.post('/api/todo/reminder', (req, res) => {
    const { chatId, userId, offsetMinutes } = req.body;
    if (!chatId || !userId || typeof offsetMinutes !== 'number') {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    setReminderOffset(Number(userId), offsetMinutes);
    updateReminderOffsets(Number(chatId), offsetMinutes);

    logger.info({ userId, offsetMinutes }, 'Reminder offset updated via API');
    res.json({ success: true, offsetMinutes });
  });

  // Delete memory entry
  app.post('/api/memory/delete', (req, res) => {
    const { userId, key, index } = req.body;
    if (!userId || !key || typeof index !== 'number') {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const ok = deleteMemoryEntry(Number(userId), key, index);
    if (!ok) {
      res.status(404).json({ error: 'Memory entry not found' });
      return;
    }

    res.json({ success: true });
  });

  // Clear all memory
  app.post('/api/memory/clear', (req, res) => {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    clearAllMemory(Number(userId));
    res.json({ success: true });
  });

  // Get memory
  app.get('/api/memory', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    const memory = getUserMemory(Number(userId));
    res.json({ memory });
  });

  return app;
}
