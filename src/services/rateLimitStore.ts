import { Bot, InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Tracks users affected by API rate limits and sends recovery notifications.
 * GitHub Models rate limits reset automatically at midnight UTC.
 */

interface RateLimitedUser {
  chatId: number;
  userId: number;
  service: 'whisper' | 'analysis' | 'intent';
  limitedAt: string; // UTC ISO
}

const rateLimitedUsers = new Map<number, RateLimitedUser>();

/**
 * Register a user as rate-limited. Stores their chatId for recovery notification.
 * Returns a user-friendly message with the reset time.
 */
export function handleRateLimit(error: any, chatId: number, userId: number, service: 'whisper' | 'analysis' | 'intent'): string {
  const now = DateTime.now().setZone('Asia/Almaty');

  // GitHub Models rate limits reset at midnight UTC (05:00 Almaty / 06:00 Almaty depending on DST)
  const resetKZ = now.startOf('day').plus({ days: 1 }).set({ hour: 5, minute: 0 });
  const minutesUntilReset = Math.ceil(resetKZ.diff(now).as('minutes'));

  // Store user for recovery notification
  rateLimitedUsers.set(userId, {
    chatId,
    userId,
    service,
    limitedAt: DateTime.now().toUTC().toISO()!,
  });

  logger.warn({ userId, service, minutesUntilReset }, '[RateLimit] User hit rate limit');

  if (minutesUntilReset > 60) {
    return `⚠️ Лимит запросов исчерпан. Сброс через ${Math.ceil(minutesUntilReset / 60)} ч.`;
  }
  return `⚠️ Лимит запросов исчерпан. Сброс через ${minutesUntilReset} мин.`;
}

/**
 * Check if rate limits have recovered and notify affected users.
 * Called periodically by the scheduler.
 */
export async function checkRateLimitRecovery(bot: Bot) {
  if (rateLimitedUsers.size === 0) return;

  // Make a lightweight API call to check availability
  const recovered: number[] = [];

  for (const [userId, data] of rateLimitedUsers) {
    try {
      // Try a simple API call to see if limits have reset
      const response = await fetch('https://api.github.com/rate_limit', {
        headers: {
          'Authorization': `Bearer ${config.openaiApiKey}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      });

      if (response.ok) {
        const body = await response.json() as any;
        const core = body?.resources?.core;
        if (core && core.remaining > 0) {
          recovered.push(userId);
        }
      }
    } catch {
      // API still down — skip
    }
  }

  // Notify recovered users
  for (const userId of recovered) {
    const data = rateLimitedUsers.get(userId);
    if (!data) continue;

    try {
      await bot.api.sendMessage(
        data.chatId,
        '✅ Я снова доступен! Лимиты сброшены.',
      );
      logger.info({ userId: data.userId }, '[RateLimit] Sent recovery notification');
    } catch (err) {
      logger.error(err, '[RateLimit] Failed to send recovery notification');
    }

    rateLimitedUsers.delete(userId);
  }
}
