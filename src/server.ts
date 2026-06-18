import express from 'express';
import cors from 'cors';
import path from 'path';
import { Bot } from 'grammy';
import { config } from './config.js';
import { getPlan, completeTask, rescheduleTask, getAllPlans, getPlansByTimeframe, deleteTaskById, deletePlansByDate, deletePlanById, addTodoToPlan } from './services/planStore.js';
import { setReminderOffset, getUserConfig } from './services/userConfig.js';
import { rescheduleReminder, updateReminderOffsets, cancelReminderByTaskId } from './services/scheduler.js';
import { logger } from './logger.js';
import { deleteMemoryEntry, clearAllMemory, getUserMemory } from './services/memoryStore.js';
import { db } from './services/db.js';
import { DateTime } from 'luxon';

const KZ_ZONE = 'Asia/Almaty';

let startTime = DateTime.now().toMillis();

export function createServer(bot?: Bot) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Request logging
  app.use((req, res, next) => {
    const start = DateTime.now().toMillis();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: DateTime.now().toMillis() - start,
        ip: req.ip,
      }, 'HTTP request');
    });
    next();
  });

  // Webhook secret token validation
  app.use((req, res, next) => {
    if (req.path === '/webhook' && req.method === 'POST') {
      const token = req.headers['x-telegram-bot-api-secret-token'];
      if (config.telegramSecretToken && token !== config.telegramSecretToken) {
        logger.warn({ ip: req.ip }, 'Webhook request with invalid secret token');
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }
    next();
  });

  app.use(express.static(path.resolve('public')));
  app.use('/assets', express.static(path.resolve('assets')));

  app.get('/webapp', (req, res) => {
    res.sendFile(path.resolve('public/webapp.html'));
  });

  app.get('/health', (req, res) => {
    const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    res.json({
      status: 'ok',
      userCount,
      uptime: Math.floor((DateTime.now().toMillis() - startTime) / 1000),
      timestamp: DateTime.now().setZone(KZ_ZONE).toUTC().toISO(),
    });
  });

  // Webhook endpoint for Telegram updates
  if (bot) {
    app.post('/webhook', (req, res) => {
      bot.handleUpdate(req.body);
      res.sendStatus(200);
    });
  }

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
    rescheduleReminder(Number(chatId), taskId, todo.task, newTime, language, offset, todo.date);

    logger.info({ chatId, taskId, newTime }, 'Task rescheduled via API');
    res.json({ success: true, todo });
  });

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

    logger.info({ userId, task: removed.task }, 'Task deleted via API');
    res.json({ success: true, task: removed });
  });

  app.post('/api/todo/create', (req, res) => {
    const { chatId, userId, task, time, priority, date } = req.body;
    if (!chatId || !userId || !task) {
      res.status(400).json({ error: 'Missing chatId, userId, or task' });
      return;
    }
    const todo = addTodoToPlan(Number(chatId), Number(userId), task, time || '', priority || 'medium', date || '', 'manual');
    logger.info({ userId, task: todo.task }, 'Task created via API');
    res.json({ success: true, todo });
  });

  app.post('/api/plans/delete', (req, res) => {
    const { userId, date } = req.body;
    if (!userId || !date) {
      res.status(400).json({ error: 'Missing userId or date' });
      return;
    }

    const count = deletePlansByDate(Number(userId), date);
    logger.info({ userId, date, count }, 'Plans deleted via API');
    res.json({ success: true, deleted: count });
  });

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

  app.get('/api/plans/timeframe/:timeframe', (req, res) => {
    const userId = req.query.userId;
    const timeframe = req.params.timeframe;
    if (!userId || !['day','week','month','year'].includes(timeframe)) {
      res.status(400).json({ error: 'Missing userId or timeframe' });
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

  app.post('/api/memory/clear', (req, res) => {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    clearAllMemory(Number(userId));
    res.json({ success: true });
  });

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

export function resetStartTime() {
  startTime = DateTime.now().toMillis();
}
