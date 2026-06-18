import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

export interface UserMemory {
  habits: string[];
  projects: string[];
  preferences: Record<string, string>;
  important_dates: string[];
  patterns: Record<string, string>;
  places: string[];
  last_updated: string;
}

const MEMORY_PATH = path.resolve(process.cwd(), 'memory.json');
let memoryData: Record<string, UserMemory> = {};

function defaultMemory(): UserMemory {
  return {
    habits: [],
    projects: [],
    preferences: {},
    important_dates: [],
    patterns: {},
    places: [],
    last_updated: '',
  };
}

function load() {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      memoryData = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
      console.log(`[Memory] Loaded memory for ${Object.keys(memoryData).length} users`);
    }
  } catch (err) {
    console.error('[Memory] Load error:', err);
    memoryData = {};
  }
}

function save() {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memoryData, null, 2));
}

load();

export function getUserMemory(userId: number): UserMemory {
  const key = String(userId);
  return key in memoryData ? memoryData[key] : defaultMemory();
}

export function updateUserMemory(userId: number, update: Partial<UserMemory>) {
  const current = getUserMemory(userId);
  const key = String(userId);
  memoryData[key] = {
    habits: update.habits || current.habits,
    projects: update.projects || current.projects,
    preferences: { ...current.preferences, ...(update.preferences || {}) },
    important_dates: update.important_dates || current.important_dates,
    patterns: { ...current.patterns, ...(update.patterns || {}) },
    places: update.places || current.places,
    last_updated: DateTime.now().setZone('Asia/Almaty').toUTC().toISO()!,
  };
  save();
  console.log(`[Memory] Updated for user ${userId}`);
}

export function formatMemoryForDisplay(userId: number, lang: string): string {
  const mem = getUserMemory(userId);
  const lines: string[] = [];

  const h = (s: string) => {
    if (lang === 'ru') lines.push(s.toUpperCase());
    else if (lang === 'kk') lines.push(s.toUpperCase());
    else lines.push(s.toUpperCase());
  };

  if (mem.habits.length > 0) {
    h('Habits');
    for (const hh of mem.habits) lines.push(`  - ${hh}`);
    lines.push('');
  }

  if (mem.projects.length > 0) {
    h('Projects');
    for (const p of mem.projects) lines.push(`  - ${p}`);
    lines.push('');
  }

  if (mem.important_dates.length > 0) {
    h('Important Dates');
    for (const d of mem.important_dates) lines.push(`  - ${d}`);
    lines.push('');
  }

  if (Object.keys(mem.preferences).length > 0) {
    h('Preferences');
    for (const [k, v] of Object.entries(mem.preferences)) {
      lines.push(`  - ${k}: ${v}`);
    }
    lines.push('');
  }

  if (Object.keys(mem.places).length > 0) {
    h('Places');
    for (const p of mem.places) lines.push(`  - ${p}`);
    lines.push('');
  }

  if (lines.length === 0) {
    if (lang === 'ru') lines.push('Я пока ничего не знаю о вас.');
    else if (lang === 'kk') lines.push('Мен сіз туралы ештеңе білмеймін.');
    else lines.push('I don\'t know anything about you yet.');
  }

  return lines.join('\n');
}

export function getAllProjects(userId: number): string[] {
  return getUserMemory(userId).projects;
}

export function deleteMemoryEntry(userId: number, key: string, index: number): boolean {
  const mem = getUserMemory(userId);
  if (!(key in mem)) return false;
  const arr: unknown = (mem as unknown as Record<string, unknown>)[key];
  if (!Array.isArray(arr) || index < 0 || index >= arr.length) return false;
  arr.splice(index, 1);
  mem.last_updated = DateTime.now().setZone('Asia/Almaty').toUTC().toISO()!;
  memoryData[String(userId)] = mem;
  save();
  return true;
}

export function clearAllMemory(userId: number) {
  const key = String(userId);
  memoryData[key] = defaultMemory();
  save();
}
