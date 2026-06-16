import fs from 'fs';
import path from 'path';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-telegram-token';
process.env.OPENAI_API_KEY ||= 'test-openai-key';
process.env.GROQ_API_KEY ||= 'test-groq-key';
process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.TELEGRAM_BOT_API_SECRET_TOKEN ||= 'test-secret';
process.env.LOG_LEVEL ||= 'silent';

const testDataDir = path.resolve(process.cwd(), 'data');
fs.mkdirSync(testDataDir, { recursive: true });

const dbPath = path.join(testDataDir, `flexai.test.${process.pid}.db`);
process.env.FLEXAI_DB_PATH = dbPath;
