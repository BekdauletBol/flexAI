import fs from 'fs';
import path from 'path';

export interface UserSettings {
  city?: string;
  lat?: number;
  lng?: number;
  reminder_offset_minutes: number;
}

const CONFIG_PATH = path.resolve(process.cwd(), 'user_config.json');
let configs: Record<string, UserSettings> = {};

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      configs = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { configs = {}; }
}

function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2));
}

load();

export function getUserConfig(userId: number): UserSettings {
  return configs[String(userId)] || { reminder_offset_minutes: 30 };
}

export function setUserLocation(userId: number, city: string, lat: number, lng: number) {
  const existing = getUserConfig(userId);
  configs[String(userId)] = { ...existing, city, lat, lng };
  save();
  console.log(`[UserConfig] Location set for ${userId}: ${city} (${lat}, ${lng})`);
}

export function setReminderOffset(userId: number, minutes: number) {
  const existing = getUserConfig(userId);
  configs[String(userId)] = { ...existing, reminder_offset_minutes: minutes };
  save();
  console.log(`[UserConfig] Reminder offset set for ${userId}: ${minutes} min`);
}
