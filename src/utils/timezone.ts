/**
 * Timezone utilities for Kazakhstan (Asia/Almaty, UTC+5)
 * All task datetimes are stored in SQLite as UTC ISO strings.
 * On SAVE: user-local time → UTC via luxon.
 * On READ: UTC → user-local via luxon.
 */
import { DateTime } from 'luxon';

export const KZ_ZONE = 'Asia/Almaty';

// ─── SAVE: local → UTC ──────────────────────────────────────────────────────

/** Convert KZ local date + time to UTC ISO string for DB storage. */
export function kzLocalToUTC(dateStr: string, timeStr: string): string {
  return DateTime.fromObject(
    { year: parseInt(dateStr.slice(0, 4)), month: parseInt(dateStr.slice(5, 7)), day: parseInt(dateStr.slice(8, 10)),
      hour: parseInt(timeStr.slice(0, 2)), minute: parseInt(timeStr.slice(3, 5)) },
    { zone: KZ_ZONE },
  ).toUTC().toISO()!;
}

/** Convert a KZ local datetime string (YYYY-MM-DDTHH:MM) to UTC ISO string. */
export function kzLocalDateTimeToUTC(localDateTime: string): string {
  return DateTime.fromISO(localDateTime, { zone: KZ_ZONE }).toUTC().toISO()!;
}

// ─── READ: UTC → local for display ──────────────────────────────────────────

/** UTC ISO → KZ time string "HH:MM". */
export function utcToKzLocalTime(utcISOString: string): string {
  return DateTime.fromISO(utcISOString, { zone: 'utc' }).setZone(KZ_ZONE).toFormat('HH:mm');
}

/** UTC ISO → KZ date string "YYYY-MM-DD". */
export function utcToKzLocalDate(utcISOString: string): string {
  return DateTime.fromISO(utcISOString, { zone: 'utc' }).setZone(KZ_ZONE).toFormat('yyyy-MM-dd');
}

/** UTC ISO → KZ datetime string "YYYY-MM-DDTHH:MM:00". */
export function utcToKzLocalDateTime(utcISOString: string): string {
  return DateTime.fromISO(utcISOString, { zone: 'utc' }).setZone(KZ_ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

// ─── READ: UTC → local for scheduler ────────────────────────────────────────

/** Parse a todo's datetime (UTC ISO) into a luxon DateTime in KZ zone. Returns null on failure. */
export function parseEventTimeAsKZ(utcIsoString: string): DateTime | null {
  const dt = DateTime.fromISO(utcIsoString, { zone: 'utc' }).setZone(KZ_ZONE);
  return dt.isValid ? dt : null;
}

/** Get "now" in KZ timezone. */
export function nowKZ(): DateTime {
  return DateTime.now().setZone(KZ_ZONE);
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/** Today's date in KZ as "YYYY-MM-DD". */
export function getKzToday(): string {
  return nowKZ().toFormat('yyyy-MM-dd');
}

/** Tomorrow's date in KZ as "YYYY-MM-DD". */
export function getKzTomorrow(): string {
  return nowKZ().plus({ days: 1 }).toFormat('yyyy-MM-dd');
}

// ─── Legacy exports for backward compat ──────────────────────────────────────

export const KAZAKHSTAN_OFFSET_HOURS = 5;
export const KAZAKHSTAN_OFFSET_MS = KAZAKHSTAN_OFFSET_HOURS * 60 * 60 * 1000;
