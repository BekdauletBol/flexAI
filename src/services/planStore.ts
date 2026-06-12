import { logger } from '../logger.js';
import { AnalysisResult, TodoItem } from '../types/analysis.js';
import * as db from './db.js';

export interface DayPlan {
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

export function savePlan(chatId: number, userId: number, analysis: AnalysisResult) {
  const existing = db.getPlan(chatId);

  if (existing) {
    const mergedTodos = [...existing.todos, ...analysis.todos];
    const mergedTags = [...new Set([...existing.tags, ...analysis.tags])];
    const mergedPoints = [...existing.key_points, ...analysis.key_points];

    db.savePlan(chatId, userId, {
      title: analysis.title,
      summary: analysis.summary,
      key_points: mergedPoints,
      todos: mergedTodos,
      tags: mergedTags,
      language: analysis.language,
    });
    logger.info(`[PlanStore] Merged plan for chat ${chatId}: +${analysis.todos.length} todos (total ${mergedTodos.length})`);
    return;
  }

  db.savePlan(chatId, userId, {
    title: analysis.title,
    summary: analysis.summary,
    key_points: analysis.key_points,
    todos: analysis.todos,
    tags: analysis.tags,
    language: analysis.language,
  });
  logger.info(`[PlanStore] Saved plan for chat ${chatId}: "${analysis.title}" (${analysis.todos.length} todos)`);
}

export function getPlan(chatId: number): DayPlan | undefined {
  return db.getPlan(chatId) as DayPlan | undefined;
}

export function completeTask(chatId: number, taskId: string, done: boolean): TodoItem | undefined {
  const plan = db.getPlan(chatId);
  if (!plan) return undefined;
  const todo = plan.todos.find(t => t.id === taskId);
  if (!todo) return undefined;
  db.completeTask(chatId, taskId, done);
  return { ...todo, done };
}

export function rescheduleTask(chatId: number, taskId: string, newTime: string, newDate?: string): TodoItem | undefined {
  const plan = db.getPlan(chatId);
  if (!plan) return undefined;
  const todo = plan.todos.find(t => t.id === taskId);
  if (!todo) return undefined;
  db.rescheduleTask(chatId, taskId, newTime, newDate);
  return { ...todo, time: newTime, date: newDate || todo.date, datetime: newDate ? `${newDate}T${newTime}:00` : todo.datetime };
}

export function getPlanForWebApp(chatId: number) {
  return db.getPlanForWebApp(chatId);
}

export function getUserTasks(userId: number): TodoItem[] {
  return db.getUserTasks(userId) as TodoItem[];
}

export interface TimeConflict {
  existing: TodoItem;
  new: TodoItem;
}

export function detectTimeConflicts(userId: number, newTodos: TodoItem[]): TimeConflict[] {
  return db.detectTimeConflicts(userId, newTodos) as TimeConflict[];
}
