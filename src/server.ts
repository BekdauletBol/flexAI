import express from 'express';
import path from 'path';
import { getPlan, completeTask, rescheduleTask } from './services/planStore.js';
import { setReminderOffset, getUserConfig } from './services/userConfig.js';
import { rescheduleReminder, updateReminderOffsets } from './services/scheduler.js';
import { logger } from './logger.js';

export function createServer() {
  const app = express();

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
    rescheduleReminder(Number(chatId), taskId, todo.task, newTime, language);

    logger.info({ chatId, taskId, newTime }, 'Task rescheduled via API');
    res.json({ success: true, todo });
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

  return app;
}
