import dotenv from 'dotenv';

export interface Config {
  telegramToken: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl: string | undefined;
  isGitHubModels: boolean;
  groqApiKey: string;
  githubToken: string;
  allowedUserId: number | undefined;
  adminTelegramId: number | undefined;
  telegramSecretToken: string;
  maxUsers: number;
  googleMapsApiKey: string;
  weatherApiKey: string;
  weatherBaseUrl: string;
  webappUrl: string;
  port: number;
  webhookDomain: string;
}

// Singleton guard — config should only be initialized once
let _initialized = false;

export function initConfig(): Config {
  if (_initialized) return config;

  dotenv.config({ override: true });

  const openaiApiKey = process.env.OPENAI_API_KEY || '';
  const isGitHubModels = openaiApiKey.startsWith('ghp_') || openaiApiKey.startsWith('github_pat_');

  const cfg: Config = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    openaiApiKey,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    openaiBaseUrl: isGitHubModels ? 'https://models.inference.ai.azure.com' : undefined,
    isGitHubModels,
    groqApiKey: process.env.GROQ_API_KEY || '',
    githubToken: process.env.OPENAI_API_KEY || '',
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

  if (!cfg.telegramToken) { console.error('TELEGRAM_BOT_TOKEN required'); process.exit(1); }
  if (!cfg.openaiApiKey) { console.error('OPENAI_API_KEY required'); process.exit(1); }
  if (!cfg.groqApiKey) {
    console.error('[FATAL] GROQ_API_KEY not set — transcription will fail');
    process.exit(1);
  }

  console.log('[Config] Model:', cfg.openaiModel);
  console.log('[Config] BaseURL:', cfg.openaiBaseUrl);
  console.log('[Config] API Key exists:', !!cfg.openaiApiKey);
  console.log('[Config] GitHub token exists:', !!cfg.githubToken);
  console.log('[Config] Groq API key exists:', !!cfg.groqApiKey);

  _initialized = true;
  Object.assign(config, cfg);
  return config;
}

export const config: Config = {
  telegramToken: '',
  openaiApiKey: '',
  openaiModel: 'gpt-4o',
  openaiBaseUrl: undefined,
  isGitHubModels: false,
  groqApiKey: '',
  githubToken: '',
  allowedUserId: undefined,
  adminTelegramId: undefined,
  telegramSecretToken: '',
  maxUsers: 30000,
  googleMapsApiKey: '',
  weatherApiKey: '',
  weatherBaseUrl: '',
  webappUrl: '',
  port: 3000,
  webhookDomain: '',
};

initConfig();
