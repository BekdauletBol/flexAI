import express from 'express';
import path from 'path';
import { getPlan, completeTask, rescheduleTask } from './services/planStore.js';
import { setReminderOffset, getUserConfig } from './services/userConfig.js';
import { rescheduleReminder, updateReminderOffsets } from './services/scheduler.js';

export function createServer() {
  const app = express();

  app.use(express.json());

  // Serve static assets and webapp
  app.use(express.static(path.resolve('public')));
  app.use('/assets', express.static(path.resolve('assets')));

  app.get('/webapp', (req, res) => {
    res.sendFile(path.resolve('public/webapp.html'));
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Complete task
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

    console.log(`[API] Task "${todo.task}" completed: ${todo.done}`);
    res.json({ success: true, todo });
  });

  // Reschedule task
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

    // Update scheduler
    const plan = getPlan(Number(chatId));
    const language = plan?.language || 'en';
    rescheduleReminder(Number(chatId), taskId, todo.task, newTime, language);

    console.log(`[API] Task "${todo.task}" rescheduled to ${newTime}`);
    res.json({ success: true, todo });
  });

  // Change reminder offset setting
  app.post('/api/todo/reminder', (req, res) => {
    const { chatId, userId, offsetMinutes } = req.body;
    if (!chatId || !userId || typeof offsetMinutes !== 'number') {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    setReminderOffset(Number(userId), offsetMinutes);
    updateReminderOffsets(Number(chatId), offsetMinutes);

    console.log(`[API] Reminder offset for user ${userId} set to ${offsetMinutes} min`);
    res.json({ success: true, offsetMinutes });
  });

  return app;
}
