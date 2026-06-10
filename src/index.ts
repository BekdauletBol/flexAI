import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { handleVoice } from './handlers/voice.js';
import { initScheduler } from './services/scheduler.js';
import { createServer } from './server.js';
import { setUserLanguage, getUserConfig, setUserLocation } from './services/userConfig.js';
import { getUserTasks, getPlan } from './services/planStore.js';
import { generateFullReport } from './services/reporter.js';
import { geocodeCity, reverseGeocode } from './services/location.js';

const bot = new Bot(config.telegramToken);

const i18n = {
  ru: {
    start: '👋 Привет! Меня зовут flex, я твой  помощник для голосовых заметок.\n\n🎙 Отправь мне голосовое сообщение, и я:\n1. Транскрибирую его\n2. Извлеку ключевые моменты и задачи\n3. Сгенерирую красивый PDF\n4. Установлю напоминания ⏰\n\n📊 Используй /report для обзора всех задач!\n📍 Используй /setcity <город> для установки локации!\n🌐 Используй /language для смены языка! \n Функция share location пока что не работает',
    setcity_prompt: '🏙 Пожалуйста, укажите название города, например: `/setcity Алматы`',
    searching: (city: string) => `🔍 Ищу город "${city}"...`,
    city_set: (city: string, lat: number, lng: number) => `✅ *Город установлен!*\n\nЛокация: *${city}*\nКоординаты: \`${lat.toFixed(4)}, ${lng.toFixed(4)}\`\n\nПрогноз погоды и маршруты теперь будут использовать этот город!`,
    lang_set: '✅ Язык изменен на Русский!',
    ping: 'понг',
    wait_report: '📊 AI Агент анализирует ваши задачи...',
    no_tasks: '📭 У вас пока нет задач. Отправьте голосовое сообщение!',
  },
  en: {
    start: '👋 Hey! I\'m your voice note assistant.\n\n🎙 Send a voice message and I\'ll:\n1. Transcribe it\n2. Extract key points & tasks\n3. Generate a beautiful PDF\n4. Set reminders ⏰\n\n📊 Use /report to get an AI summary of all your tasks!\n📍 Use /setcity <name> to set your city manually!\n🌐 Use /language to change language!',
    setcity_prompt: '🏙 Please provide a city name, e.g., `/setcity London`',
    searching: (city: string) => `🔍 Searching for "${city}"...`,
    city_set: (city: string, lat: number, lng: number) => `✅ *City Set!*\n\nLocation: *${city}*\nCoordinates: \`${lat.toFixed(4)}, ${lng.toFixed(4)}\`\n\nWeather and directions will now use this location!`,
    lang_set: '✅ Language set to English!',
    ping: 'pong',
    wait_report: '📊 AI Agent is analyzing all your tasks...',
    no_tasks: '📭 You don\'t have any tasks recorded yet. Send me a voice note first!',
  },
  kk: {
    start: '👋 Сәлем! Мен сенің дауыстық жазба көмекшіңмін.\n\n🎙 Дауыстық хабарлама жібер, мен:\n1. Оны мәтінге айналдырамын\n2. Маңызды тұстарын мен тапсырмаларды бөліп аламын\n3. Әдемі PDF жасаймын\n4. Еске салғыштар орнатамын ⏰\n\n📊 Барлық тапсырмаларды көру үшін /report қолдан!\n📍 Қаланы орнату үшін /setcity <қала> қолдан!\n🌐 Тілді өзгерту үшін /language қолдан!',
    setcity_prompt: '🏙 Қала атын жазыңыз, мысалы: `/setcity Алматы`',
    searching: (city: string) => `🔍 "${city}" қаласын іздеудемін...`,
    city_set: (city: string, lat: number, lng: number) => `✅ *Қала орнатылды!*\n\nОрналасқан жері: *${city}*\nКоординаттар: \`${lat.toFixed(4)}, ${lng.toFixed(4)}\`\n\nАуа райы мен бағыттар енді осы қаланы қолданады!`,
    lang_set: '✅ Тіл Қазақшаға өзгертілді!',
    ping: 'понг',
    wait_report: '📊 AI Агент тапсырмаларды талдап жатыр...',
    no_tasks: '📭 Сізде әлі тапсырмалар жоқ. Дауыстық хабарлама жіберіңіз!',
  }
};

bot.use(async (ctx, next) => {
  console.log(`[DEBUG] RAW UPDATE #${ctx.update.update_id}:`, JSON.stringify(ctx.update, null, 2));
  await next();
});

bot.command('ping', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'en';
  await ctx.reply(i18n[lang].ping);
});

bot.command('language', async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text('🇷🇺 Русский', 'lang_ru')
    .text('🇬🇧 English', 'lang_en')
    .text('🇰🇿 Қазақша', 'lang_kk');
  
  await ctx.reply('🌐 Choose your language / Выберите язык / Тілді таңдаңыз:', {
    reply_markup: keyboard
  });
});

bot.callbackQuery(/lang_(ru|en|kk)/, async (ctx) => {
  const lang = ctx.match[1] as 'ru' | 'en' | 'kk';
  setUserLanguage(ctx.from.id, lang);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(i18n[lang].lang_set);
});

bot.command('report', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const tasks = getUserTasks(userId);
  const settings = getUserConfig(userId);
  const lang = settings.language || 'en';

  if (tasks.length === 0) {
    await ctx.reply(i18n[lang].no_tasks);
    return;
  }

  const statusMsg = await ctx.reply(i18n[lang].wait_report);
  
  try {
    const report = await generateFullReport(tasks, lang);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Bot] Report generation failed:', err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ Error.');
  }
});

bot.command('setcity', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const settings = getUserConfig(userId);
  const lang = settings.language || 'en';

  const cityName = ctx.match;
  if (!cityName) {
    await ctx.reply(i18n[lang].setcity_prompt, { parse_mode: 'Markdown' });
    return;
  }

  const statusMsg = await ctx.reply(i18n[lang].searching(cityName));
  
  try {
    const coords = await geocodeCity(cityName);
    if (!coords) {
      const errorMsg = lang === 'ru' ? `❌ Не удалось найти город: ${cityName}` : lang === 'kk' ? `❌ Қала табылмады: ${cityName}` : `❌ Could not find city: ${cityName}`;
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errorMsg);
      return;
    }

    setUserLocation(userId, cityName, coords.lat, coords.lng);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      i18n[lang].city_set(cityName, coords.lat, coords.lng),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[Bot] Failed to set city:', err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ Error.');
  }
});

bot.command('start', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'en';
  await ctx.reply(i18n[lang].start);
});

bot.command('help', async (ctx) => {
  const settings = getUserConfig(ctx.from!.id);
  const lang = settings.language || 'en';
  await ctx.reply(i18n[lang].start);
});

bot.on('message:voice', handleVoice);
bot.on('message:audio', (ctx) => ctx.reply('Please send a *voice message* (hold mic), not an audio file.', { parse_mode: 'Markdown' }));
bot.on('message:text', (ctx) => { if (!ctx.message.text.startsWith('/')) ctx.reply('🎙 Send me a voice message!'); });

bot.catch((err) => {
  console.error(`[${new Date().toISOString()}] Error update ${err.ctx.update.update_id}:`, err.error);
});

initScheduler(bot);

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
