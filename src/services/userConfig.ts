import { logger } from '../logger.js';
import * as db from './db.js';

export interface UserSettings {
  city?: string;
  lat?: number;
  lng?: number;
  language?: 'ru' | 'en' | 'kk';
  reminder_offset_minutes: number;
}

export function getUserConfig(userId: number): UserSettings {
  const row = db.getUser(userId);
  if (!row) return { reminder_offset_minutes: 30 };
  return {
    city: row.city,
    lat: row.lat,
    lng: row.lng,
    language: row.language as 'ru' | 'en' | 'kk',
    reminder_offset_minutes: row.reminder_offset_minutes,
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
