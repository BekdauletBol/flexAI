import { logger } from '../logger.js';
import * as db from './db.js';
import { DateTime } from 'luxon';

const DEFAULT_TIMEZONE = 'Asia/Almaty';

export interface UserSettings {
  city?: string;
  lat?: number;
  lng?: number;
  language?: 'ru' | 'en' | 'kk';
  reminder_offset_minutes: number;
  timezone: string;
}

/**
 * Get the user's timezone from DB, falling back to 'Asia/Almaty'.
 */
export function getUserTimezone(userId: number): string {
  const row = db.getUser(userId);
  return (row as any)?.timezone || DEFAULT_TIMEZONE;
}

/**
 * Format the current time in the user's local timezone.
 * Returns { utcISO, localISO, localDate, localTime, timezone }
 */
export function getTemporalContext(userId: number): {
  utcISO: string;
  localISO: string;
  localDate: string;
  localTime: string;
  timezone: string;
} {
  const tz = getUserTimezone(userId);
  const now = DateTime.now().setZone(tz);

  const utcISO = now.toUTC().toISO()!;
  const localDate = now.toFormat('yyyy-MM-dd');
  const localTime = now.toFormat('HH:mm');
  const localISO = `${localDate}T${localTime}:00`;

  return { utcISO, localISO, localDate, localTime, timezone: tz };
}

export function getUserConfig(userId: number): UserSettings {
  const row = db.getUser(userId);
  if (!row) return { reminder_offset_minutes: 30, timezone: DEFAULT_TIMEZONE };
  return {
    city: row.city,
    lat: row.lat,
    lng: row.lng,
    language: row.language as 'ru' | 'en' | 'kk',
    reminder_offset_minutes: row.reminder_offset_minutes,
    timezone: (row as any)?.timezone || DEFAULT_TIMEZONE,
  };
}

export function setUserLanguage(userId: number, lang: 'ru' | 'en' | 'kk') {
  db.upsertUser(userId, { language: lang });
  logger.info(`[UserConfig] Language set for ${userId}: ${lang}`);
}

export function setUserLocation(userId: number, city: string, lat: number, lng: number) {
  db.upsertUser(userId, { city, lat, lng });
  logger.info(`[UserConfig] Location set for ${userId}: ${city} (${lat}, ${lng})`);
}

export function setReminderOffset(userId: number, minutes: number) {
  db.upsertUser(userId, { reminder_offset_minutes: minutes });
  logger.info(`[UserConfig] Reminder offset set for ${userId}: ${minutes} min`);
}

/**
 * Returns a luxon DateTime in the user's local timezone from temporal context.
 * Use this instead of `new Date(temporal.localISO)`.
 */
export function getLocalDateTime(userId: number): DateTime {
  const tz = getUserTimezone(userId);
  return DateTime.now().setZone(tz);
}

/**
 * Returns formatted date parts for LLM prompts (weekday, monthDay, year).
 * Replaces the pattern: `new Date(temporal.localISO).toLocaleDateString(...)`.
 */
export function getTemporalPromptParts(userId: number): {
  dayOfWeek: string;
  monthDay: string;
  year: number;
  localTime: string;
  localDate: string;
  timezone: string;
} {
  const temporal = getTemporalContext(userId);
  const dt = DateTime.fromISO(temporal.localISO, { zone: temporal.timezone });
  return {
    dayOfWeek: dt.toFormat('cccc'),         // "Monday"
    monthDay: dt.toFormat('MMMM d'),         // "January 15"
    year: dt.year,
    localTime: temporal.localTime,
    localDate: temporal.localDate,
    timezone: temporal.timezone,
  };
}
