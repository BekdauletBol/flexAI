import dotenv from 'dotenv';
dotenv.config({ override: true });

const openaiApiKey = process.env.OPENAI_API_KEY || '';
const isGitHubModels = openaiApiKey.startsWith('ghp_') || openaiApiKey.startsWith('github_pat_');

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  openaiApiKey,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  openaiBaseUrl: isGitHubModels ? 'https://models.inference.ai.azure.com' : undefined,
  isGitHubModels,
  groqApiKey: process.env.GROQ_API_KEY || '',
  allowedUserId: process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID) : undefined,
  adminTelegramId: process.env.ADMIN_TELEGRAM_ID ? parseInt(process.env.ADMIN_TELEGRAM_ID) : undefined,
  telegramSecretToken: process.env.TELEGRAM_BOT_API_SECRET_TOKEN || '',
  maxUsers: parseInt(process.env.MAX_USERS || '30000'),

  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  weatherApiKey: process.env.WEATHERAPI || process.env.OPENWEATHER_API_KEY || '',
  weatherBaseUrl: process.env.WEATHER_BASE_URL || 'https://api.openweathermap.org/data/2.5/weather',
  webappUrl: process.env.WEBAPP_URL || '',
  port: parseInt(process.env.PORT || '3000'),
  webhookDomain: process.env.WEBHOOK_DOMAIN || '',
};

if (!config.telegramToken) { console.error('TELEGRAM_BOT_TOKEN required'); process.exit(1); }
if (!config.openaiApiKey) { console.error('OPENAI_API_KEY required'); process.exit(1); }
if (!config.groqApiKey) { console.error('GROQ_API_KEY required'); process.exit(1); }

console.log('[Config] Model:', config.openaiModel);
console.log('[Config] BaseURL:', config.openaiBaseUrl);
console.log('[Config] API Key exists:', !!config.openaiApiKey);
