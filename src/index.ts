import { Bot } from 'grammy';
import { config } from './config.js';
import { handleVoice } from './handlers/voice.js';

const bot = new Bot(config.telegramToken);

// ── Middleware: logging ──────────────────────────────────
bot.use(async (ctx, next) => {
  const updateType = Object.keys(ctx.update).filter(k => k !== 'update_id').join(', ');
  console.log(`[Bot] Update #${ctx.update.update_id} (${updateType}) from ${ctx.from?.username || ctx.from?.id || 'unknown'}`);
  await next();
});

// ── /start command ───────────────────────────────────────
bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 Привет! Я бот для обработки голосовых заметок.\n\n' +
    '🎙 Отправь мне голосовое сообщение, и я:\n\n' +
    '1️⃣ Транскрибирую его в текст\n' +
    '2️⃣ Проанализирую содержание\n' +
    '3️⃣ Выделю ключевые моменты и задачи (TODO)\n' +
    '4️⃣ Пришлю структурированный .docx файл\n\n' +
    '💡 Поддерживаются: русский, английский, казахский\n\n' +
    'Используй /help для подробностей.'
  );
});

// ── /help command ────────────────────────────────────────
bot.command('help', async (ctx) => {
  await ctx.reply(
    '📖 *Как пользоваться ботом:*\n\n' +
    '• Отправь голосовое сообщение любой длины\n' +
    '• Бот автоматически распознает язык\n' +
    '• На выходе получишь:\n' +
    '  ─ Word\\-документ \\(\\.docx\\) со структурой\n' +
    '  ─ Текстовую сводку в чат\n' +
    '  ─ Список задач с приоритетами\n\n' +
    '*Структура документа:*\n' +
    '📋 Краткое содержание\n' +
    '🔑 Ключевые моменты\n' +
    '✅ Задачи \\(TODO\\) с приоритетами\n' +
    '🏷 Теги \\(Obsidian\\-стиль\\)\n' +
    '📝 Полная транскрипция',
    { parse_mode: 'MarkdownV2' }
  );
});

// ── Voice message handler ────────────────────────────────
bot.on('message:voice', handleVoice);

// ── Audio message handler (for audio files sent as attachments) ──
bot.on('message:audio', async (ctx) => {
  await ctx.reply('ℹ️ Пожалуйста, отправь именно *голосовое сообщение* (зажми микрофон), а не аудиофайл.', {
    parse_mode: 'Markdown',
  });
});

// ── Text message fallback ────────────────────────────────
bot.on('message:text', async (ctx) => {
  // Ignore commands (already handled above)
  if (ctx.message.text.startsWith('/')) return;

  await ctx.reply('🎙 Отправь мне голосовое сообщение, и я обработаю его для тебя!');
});

// ── Global error handler ─────────────────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  const errorTimestamp = new Date().toISOString();
  console.error(`[${errorTimestamp}] Error while handling update ${ctx.update.update_id}:`);

  const e = err.error;
  if (e instanceof Error) {
    console.error(`  Name: ${e.name}`);
    console.error(`  Message: ${e.message}`);
    console.error(`  Stack: ${e.stack}`);
  } else {
    console.error('  Unknown error:', e);
  }
});

// ── Start the bot ────────────────────────────────────────
console.log('[Bot] Starting...');

bot.start({
  onStart: (botInfo) => {
    console.log(`🚀 Bot is running as @${botInfo.username}`);
    console.log(`   Model: ${config.openaiModel}`);
    console.log(`   GitHub Models: ${config.isGitHubModels}`);
    console.log(`   Allowed User: ${config.allowedUserId || 'any'}`);
  },
});
