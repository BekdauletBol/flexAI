import fs from 'fs';
import path from 'path';
import { AnalysisResult, TodoItem } from '../types/analysis.js';

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

const PLAN_PATH = path.resolve(process.cwd(), 'day_plan.json');
const plans: Map<number, DayPlan> = new Map();

function load() {
  try {
    if (fs.existsSync(PLAN_PATH)) {
      const data = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8')) as Record<string, DayPlan>;
      for (const [k, v] of Object.entries(data)) plans.set(Number(k), v);
    }
  } catch {}
}

function persist() {
  const obj: Record<string, DayPlan> = {};
  for (const [k, v] of plans) obj[String(k)] = v;
  fs.writeFileSync(PLAN_PATH, JSON.stringify(obj, null, 2));
}

load();

export function savePlan(chatId: number, userId: number, analysis: AnalysisResult) {
  const plan: DayPlan = {
    chatId, userId,
    title: analysis.title,
    summary: analysis.summary,
    key_points: analysis.key_points,
    todos: analysis.todos,
    tags: analysis.tags,
    language: analysis.language,
    createdAt: new Date().toISOString(),
  };
  plans.set(chatId, plan);
  persist();
  console.log(`[PlanStore] Saved plan for chat ${chatId}: "${analysis.title}" (${analysis.todos.length} todos)`);
}

export function getPlan(chatId: number): DayPlan | undefined {
  return plans.get(chatId);
}

export function completeTask(chatId: number, taskId: string, done: boolean): TodoItem | undefined {
  const plan = plans.get(chatId);
  if (!plan) return undefined;
  const todo = plan.todos.find(t => t.id === taskId);
  if (!todo) return undefined;
  todo.done = done;
  persist();
  return todo;
}

export function rescheduleTask(chatId: number, taskId: string, newTime: string): TodoItem | undefined {
  const plan = plans.get(chatId);
  if (!plan) return undefined;
  const todo = plan.todos.find(t => t.id === taskId);
  if (!todo) return undefined;
  todo.time = newTime;
  persist();
  return todo;
}

export function getPlanForWebApp(chatId: number) {
  const plan = plans.get(chatId);
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

export function getUserTasks(userId: number): TodoItem[] {
  const allTasks: TodoItem[] = [];
  for (const plan of plans.values()) {
    if (plan.userId === userId) {
      allTasks.push(...plan.todos);
    }
  }
  return allTasks;
}
