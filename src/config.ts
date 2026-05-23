import dotenv from 'dotenv';

dotenv.config();

const openaiApiKey = process.env.OPENAI_API_KEY || '';

// Detect GitHub Models PAT (starts with ghp_ or github_pat_)
const isGitHubModels = openaiApiKey.startsWith('ghp_') || openaiApiKey.startsWith('github_pat_');

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // OpenAI / GitHub Models — for analysis
  openaiApiKey,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  openaiBaseUrl: isGitHubModels ? 'https://models.inference.ai.azure.com' : undefined,
  isGitHubModels,

  // Groq — free Whisper API for transcription
  groqApiKey: process.env.GROQ_API_KEY || '',

  // Optional: restrict to a single user
  allowedUserId: process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID) : undefined,
};

if (!config.telegramToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

if (!config.openaiApiKey) {
  console.error('❌ OPENAI_API_KEY is required');
  process.exit(1);
}

if (!config.groqApiKey) {
  console.error('❌ GROQ_API_KEY is required — get a free key at https://console.groq.com');
  process.exit(1);
}

console.log(`[Config] GitHub Models mode: ${config.isGitHubModels}`);
console.log(`[Config] OpenAI Model: ${config.openaiModel}`);
console.log(`[Config] Groq Whisper: enabled`);
