import dotenv from 'dotenv';
dotenv.config();

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

  // New: Location & Mini App
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  openweatherApiKey: process.env.OPENWEATHER_API_KEY || '',
  webappUrl: process.env.WEBAPP_URL || '',
  port: parseInt(process.env.PORT || '3000'),
};

if (!config.telegramToken) { console.error('❌ TELEGRAM_BOT_TOKEN required'); process.exit(1); }
if (!config.openaiApiKey) { console.error('❌ OPENAI_API_KEY required'); process.exit(1); }
if (!config.groqApiKey) { console.error('❌ GROQ_API_KEY required'); process.exit(1); }

console.log(`[Config] GitHub Models: ${config.isGitHubModels} | Model: ${config.openaiModel}`);
console.log(`[Config] Groq Whisper: enabled`);
if (config.googleMapsApiKey) console.log(`[Config] Google Maps: enabled`);
if (config.openweatherApiKey) console.log(`[Config] Weather: enabled`);
if (config.webappUrl) console.log(`[Config] WebApp: ${config.webappUrl}`);
