import { logger } from '../logger.js';
import * as db from './db.js';

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
  const now = new Date();

  const utcISO = now.toISOString();

  // Format local time using Intl
  const localStr = now.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Parse back: "MM/DD/YYYY, HH:MM:SS" → components
  const [datePart, timePart] = localStr.split(', ');
  const [month, day, year] = datePart.split('/');
  const localDate = `${year}-${month}-${day}`;
  const localTime = timePart.substring(0, 5); // "HH:MM"

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
