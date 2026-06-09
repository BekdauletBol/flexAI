import { Bot } from 'grammy';
import { config } from './config.js';
import { handleVoice } from './handlers/voice.js';
import { initScheduler } from './services/scheduler.js';
import { createServer } from './server.js';
import { setUserLocation } from './services/userConfig.js';
import { reverseGeocode } from './services/location.js';

const bot = new Bot(config.telegramToken);

bot.use(async (ctx, next) => {
  console.log(`[Bot] #${ctx.update.update_id} from ${ctx.from?.username || ctx.from?.id || '?'}`);
  await next();
});

bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 Hey! I\'m your voice note assistant.\n\n' +
    '🎙 Send a voice message and I\'ll:\n' +
    '1. Transcribe it\n' +
    '2. Extract key points & tasks\n' +
    '3. Generate a beautiful PDF\n' +
    '4. Set reminders for timed tasks ⏰\n\n' +
    '📍 Use /setlocation to enable weather & route directions!\n\n' +
    '💡 Supports: 🇬🇧 English · 🇷🇺 Russian · 🇰🇿 Kazakh\n\n' +
    'Try: "At 3pm I need to call Nazarbayev"'
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    '📖 *How to use:*\n\n' +
    '• Send a voice message\n' +
    '• Language is auto-detected\n' +
    '• Mention times to get reminders!\n\n' +
    '*Features:*\n' +
    '📄 PDF with task timeline graph\n' +
    '⏰ Auto-reminders 30 min before events\n' +
    '✅ TODO extraction with priorities\n' +
    '🏷 Obsidian-style tags',
    { parse_mode: 'Markdown' }
  );
});

bot.command('setlocation', async (ctx) => {
  await ctx.reply(
    '📍 *Set Your Location*\n\n' +
    'Please send your current location using the Telegram "Send Location" feature (tap the paperclip attachment icon → Location).\n\n' +
    'This allows me to:\n' +
    '1. Get precise weather forecast for your event times 🌤\n' +
    '2. Estimate travel distance and driving times to your destination 🚗',
    { parse_mode: 'Markdown' }
  );
});

// Handle location message
bot.on('message:location', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const { latitude, longitude } = ctx.message.location;
  const statusMsg = await ctx.reply('🔍 Resolving location name...');

  try {
    const cityName = await reverseGeocode(latitude, longitude);
    setUserLocation(userId, cityName, latitude, longitude);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ *Location Set!*\n\nCity: *${cityName}*\nCoordinates: \`${latitude.toFixed(4)}, ${longitude.toFixed(4)}\`\n\nYour location has been saved. Weather forecasts and directions will now be enabled in your analysis!`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Failed to set location:', err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ Failed to resolve location name.');
  }
});

bot.on('message:voice', handleVoice);
bot.on('message:audio', (ctx) => ctx.reply('Please send a *voice message* (hold mic), not an audio file.', { parse_mode: 'Markdown' }));
bot.on('message:text', (ctx) => { if (!ctx.message.text.startsWith('/')) ctx.reply('🎙 Send me a voice message!'); });

bot.catch((err) => {
  console.error(`[${new Date().toISOString()}] Error update ${err.ctx.update.update_id}:`, err.error);
});

// Initialize scheduler
initScheduler(bot);

// Create and start Express server
const app = createServer();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`[Server] Express server running on port ${config.port}`);
});

console.log('[Bot] Starting...');
bot.start({
  onStart: (info) => {
    console.log(`🚀 @${info.username} running`);
    console.log(`   Model: ${config.openaiModel} | GitHub: ${config.isGitHubModels} | User: ${config.allowedUserId || 'any'}`);
  },
});
