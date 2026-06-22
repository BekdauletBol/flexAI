import { Bot } from 'grammy';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Tracks users affected by API rate limits.
 * - Returns user-facing message immediately.
 * - Queues admin notification → sent on next scheduler tick (has bot instance).
 * - Recovery: checks models.inference.ai.azure.com (the actual API we use).
 */

interface RateLimitedUser {
  chatId: number;
  userId: number;
  userName?: string;
  service: 'whisper' | 'analysis' | 'intent';
  limitedAt: string;
}

const rateLimitedUsers = new Map<number, RateLimitedUser>();

/** Pending admin notifications — flushed by checkRateLimitRecovery */
const pendingAdminNotifications: string[] = [];

function queueAdminNotification(message: string) {
  pendingAdminNotifications.push(message);
}

/** Format reset time in KZ */
function formatResetTime(): string {
  const now = DateTime.now().setZone('Asia/Almaty');
  const resetKZ = now.startOf('day').plus({ days: 1 }).set({ hour: 5, minute: 0 });
  const minutesUntilReset = Math.ceil(resetKZ.diff(now).as('minutes'));
  if (minutesUntilReset > 60) {
    return `${Math.ceil(minutesUntilReset / 60)} ч.`;
  }
  return `${minutesUntilReset} мин.`;
}

/**
 * Register a user as rate-limited.
 * Returns user-facing message. Admin notification is queued.
 */
export function handleRateLimit(
  error: any,
  chatId: number,
  userId: number,
  service: 'whisper' | 'analysis' | 'intent',
  userName?: string,
): string {
  const resetTime = formatResetTime();

  rateLimitedUsers.set(userId, {
    chatId,
    userId,
    userName,
    service,
    limitedAt: DateTime.now().toUTC().toISO()!,
  });

  logger.warn({ userId, service, userName }, '[RateLimit] User hit rate limit');

  // Queue admin notification (will be sent on next scheduler tick)
  queueAdminNotification(
    `⚠️ Токены исчерпаны\n\n` +
    `Пользователь: ${userName || userId} (ID: ${userId})\n` +
    `Сервис: ${service}\n` +
    `Время: ${DateTime.now().setZone('Asia/Almaty').toFormat('yyyy-MM-dd HH:mm')}\n` +
    `Сброс через: ${resetTime}`
  );

  return `⚠️ Лимит API-запросов исчерпан. Попробуйте через ${resetTime}.\n\nПока что отправляйте текст — голосовые и анализа скриншотов временно недоступны.\n\nПроверить статус: /tokens`;
}

/**
 * Get remaining wait time for a user (used by /tokens command).
 */
export function getRateLimitStatus(userId: number): { limited: boolean; resetIn: string } | null {
  const data = rateLimitedUsers.get(userId);
  if (!data) return null;
  return { limited: true, resetIn: formatResetTime() };
}

/**
 * Check if rate limits have recovered and notify users + admin.
 * Called periodically by the scheduler (every 30s, has bot instance).
 */
export async function checkRateLimitRecovery(bot: Bot) {
  // Flush pending admin notifications first
  if (config.adminTelegramId && pendingAdminNotifications.length > 0) {
    while (pendingAdminNotifications.length > 0) {
      const msg = pendingAdminNotifications.shift()!;
      try {
        await bot.api.sendMessage(config.adminTelegramId, msg);
        logger.debug('[RateLimit] Sent admin notification');
      } catch (err) {
        logger.error(err, '[RateLimit] Failed to notify admin');
      }
    }
  }

  if (rateLimitedUsers.size === 0) return;

  // Check actual models endpoint (not api.github.com — that's a different service)
  const recovered: number[] = [];

  for (const [userId, data] of rateLimitedUsers) {
    try {
      const response = await fetch('https://models.inference.ai.azure.com/models', {
        headers: {
          'Authorization': `Bearer ${config.openaiApiKey}`,
        },
      });

      // 200 = OK, 401/403 = token expired (not rate limit), 429 = still rate-limited
      if (response.status === 200) {
        recovered.push(userId);
      } else if (response.status === 401 || response.status === 403) {
        // Token invalid — not a rate limit issue, remove from tracking
        recovered.push(userId);
      }
    } catch {
      // Network error — skip
    }
  }

  // Notify recovered users + admin
  for (const userId of recovered) {
    const data = rateLimitedUsers.get(userId);
    if (!data) continue;

    try {
      await bot.api.sendMessage(
        data.chatId,
        '✅ Лимиты сброшены! Бот снова работает в полном объёме.',
      );
      logger.info({ userId: data.userId }, '[RateLimit] Sent recovery notification to user');
    } catch (err) {
      logger.error(err, '[RateLimit] Failed to send recovery notification to user');
    }

    // Notify admin
    if (config.adminTelegramId) {
      try {
        await bot.api.sendMessage(
          config.adminTelegramId,
          `✅ Токены восстановлены\n\n` +
          `Пользователь: ${data.userName || data.userId} (ID: ${data.userId})\n` +
          `Сервис: ${data.service}\n` +
          `Бот снова работает.`,
        );
      } catch (err) {
        logger.error(err, '[RateLimit] Failed to notify admin of recovery');
      }
    }

    rateLimitedUsers.delete(userId);
  }
}
