/**
 * Timezone utilities for Kazakhstan (UTC+5, Asia/Almaty)
 * User inputs are in local Kazakhstan time. We store as UTC for correct scheduling.
 */

export const KAZAKHSTAN_OFFSET_HOURS = 5;
export const KAZAKHSTAN_OFFSET_MS = KAZAKHSTAN_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * Convert a date (YYYY-MM-DD) and time (HH:MM) from Kazakhstan local time (UTC+5) to UTC ISO string (YYYY-MM-DDTHH:MM:00Z)
 */
export function kzLocalToUTC(dateStr: string, timeStr: string): string {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(5, 7)) - 1;
  const day = parseInt(dateStr.substring(8, 10));

  // Create date in UTC by subtracting 5 hours from the local time
  const utcDate = new Date(Date.UTC(year, month, day, hours - KAZAKHSTAN_OFFSET_HOURS, minutes, 0));
  return utcDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Convert a Kazakhstan local datetime string (YYYY-MM-DDTHH:MM:00, no timezone) to UTC ISO string
 */
export function kzLocalDateTimeToUTC(localDateTime: string): string {
  // Parse as local Kazakhstan time, then convert to UTC
  const date = new Date(localDateTime + '+05:00');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Convert UTC ISO string to Kazakhstan local time string (HH:MM) for display
 */
export function utcToKzLocalTime(utcISOString: string): string {
  const date = new Date(utcISOString);
  // Get hours/minutes in UTC+5
  const kzTime = new Date(date.getTime() + KAZAKHSTAN_OFFSET_MS);
  return `${String(kzTime.getUTCHours()).padStart(2, '0')}:${String(kzTime.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Convert UTC ISO string to Kazakhstan local date string (YYYY-MM-DD) for display
 */
export function utcToKzLocalDate(utcISOString: string): string {
  const date = new Date(utcISOString);
  const kzDate = new Date(date.getTime() + KAZAKHSTAN_OFFSET_MS);
  return `${kzDate.getUTCFullYear()}-${String(kzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(kzDate.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Convert UTC ISO string to full Kazakhstan local datetime string (YYYY-MM-DDTHH:MM:00) for display
 */
export function utcToKzLocalDateTime(utcISOString: string): string {
  const date = new Date(utcISOString);
  const kzDate = new Date(date.getTime() + KAZAKHSTAN_OFFSET_MS);
  return `${kzDate.getUTCFullYear()}-${String(kzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(kzDate.getUTCDate()).padStart(2, '0')}T${String(kzDate.getUTCHours()).padStart(2, '0')}:${String(kzDate.getUTCMinutes()).padStart(2, '0')}:00`;
}