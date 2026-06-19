import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import { logger } from '../logger.js';

export interface UserMemory {
  habits: string[];
  projects: string[];
  preferences: Record<string, string>;
  important_dates: string[];
  patterns: Record<string, string>;
  pattern_occurrences: Record<string, number>;
  places: string[];
  last_updated: string;
}

// Only these pattern keys represent recurring daily habits — one-time events are excluded
const VALID_PATTERN_KEYS = new Set([
  'sleep_time', 'wake_up_time', 'work_time', 'lunch_time',
  'dinner_time', 'breakfast_time', 'gym_time',
]);

// Minimum occurrences before a pattern is promoted to the active patterns list
const PATTERN_THRESHOLD = 3;

const MEMORY_PATH = path.resolve(process.cwd(), 'memory.json');
let memoryData: Record<string, UserMemory> = {};

function defaultMemory(): UserMemory {
  return {
    habits: [],
    projects: [],
    preferences: {},
    important_dates: [],
    patterns: {},
    pattern_occurrences: {},
    places: [],
    last_updated: '',
  };
}

function load() {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      memoryData = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
      logger.debug(`[Memory] Loaded memory for ${Object.keys(memoryData).length} users`);
    }
  } catch (err) {
    logger.error('[Memory] Load error: %s', String(err));
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

  // ── Sanitize patterns: only keep VALID recurring habit keys ──
  const sanitizedPatterns: Record<string, string> = {};
  const updatedOccurrences = { ...(current.pattern_occurrences || {}) };

  if (update.patterns) {
    for (let [k, v] of Object.entries(update.patterns)) {
      if (!v) continue;

      // Merge bed_time → sleep_time
      if (k === 'bed_time') {
        k = 'sleep_time';
      }

      if (!VALID_PATTERN_KEYS.has(k)) {
        logger.debug(`[Memory] Ignored non-recurring pattern key: "${k}" — not a daily habit`);
        continue;
      }

      // Track occurrence count
      updatedOccurrences[k] = (updatedOccurrences[k] || 0) + 1;

      // Only promote to active patterns after threshold is reached
      if (updatedOccurrences[k] >= PATTERN_THRESHOLD) {
        sanitizedPatterns[k] = v;
        logger.debug(`[Memory] Pattern "${k}" reached threshold (${updatedOccurrences[k]}x), promoting to active patterns`);
      } else {
        logger.debug(`[Memory] Pattern "${k}" occurrence ${updatedOccurrences[k]}/${PATTERN_THRESHOLD} — not yet promoted`);
      }
    }
  }

  memoryData[key] = {
    habits: update.habits || current.habits,
    projects: update.projects || current.projects,
    preferences: { ...current.preferences, ...(update.preferences || {}) },
    important_dates: update.important_dates || current.important_dates,
    patterns: { ...current.patterns, ...sanitizedPatterns },
    pattern_occurrences: updatedOccurrences,
    places: update.places || current.places,
    last_updated: DateTime.now().setZone('Asia/Almaty').toUTC().toISO()!,
  };
  save();
  logger.debug(`[Memory] Updated for user ${userId}`);
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
