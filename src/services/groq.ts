import OpenAI from 'openai';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

export const groq = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  timeout: 60000,
  maxRetries: 1,
});

export const GROQ_MODEL = 'llama-3.3-70b-versatile';

export const hasGroq = !!GROQ_API_KEY;
