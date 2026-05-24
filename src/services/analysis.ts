import OpenAI from 'openai';
import { config } from '../config.js';
import { AnalysisResult } from '../types/analysis.js';
import { v4 as uuid } from 'uuid';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
});

const SYSTEM_PROMPT = `You are an expert assistant for analyzing voice notes.

LANGUAGE RULE (critical):
- Russian transcript → respond in Russian
- English transcript → respond in English
- Kazakh transcript → respond in Kazakh
- Mixed → use the dominant language

Return ONLY a JSON object in this EXACT format:
{
  "title": "Short title (5-7 words)",
  "summary": "2-3 sentence summary",
  "key_points": ["point 1", "point 2"],
  "todos": [
    { "task": "Task description", "priority": "high", "done": false, "time": "15:00", "duration": 30, "location": "Place name or null" }
  ],
  "tags": ["#tag1", "#tag2"],
  "raw_transcript": "original transcript unchanged",
  "language": "ru",
  "location_query": "ЦУМ Астана or null",
  "visit_datetime": "2026-05-29T14:00:00 or null",
  "needs_location_check": false
}

TIME EXTRACTION:
- If the user mentions a specific time (e.g. "at 3pm", "в 15:00", "сағат 10-да"), extract as "time" in "HH:MM" 24h format.
- If no time → set "time" to null.
- Parse smartly: "3pm"="15:00", "half past 2"="14:30", "в 8 утра"="08:00".
- "duration": estimated task duration in minutes (default 30).

LOCATION EXTRACTION:
- If user mentions visiting a specific place + time, set location_query (place name), visit_datetime (ISO), needs_location_check: true.
- If task mentions a place name, set "location" on that todo item.
- If no place → set all location fields to null.

Guidelines:
- Be concise, action-oriented. Extract EVERY actionable item.
- Priority: "high"=urgent, "medium"=standard, "low"=nice-to-have.
- Generate #tags. "language": "ru","en","kk". Keep raw_transcript unchanged.
- Return ONLY JSON.`;

export async function analyzeTranscript(transcript: string): Promise<AnalysisResult> {
  try {
    console.log(`[Analysis] Analyzing (${transcript.length} chars)...`);

    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Analyze this transcript:\n\n"${transcript}"` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response');

    const result = JSON.parse(content) as AnalysisResult;
    result.raw_transcript = transcript;
    result.title = result.title || 'Voice Note';
    result.summary = result.summary || transcript.substring(0, 200);
    result.key_points = result.key_points || [];
    result.todos = result.todos || [];
    result.tags = result.tags || [];

    const lang = result.language?.toLowerCase();
    if (lang === 'kk' || lang === 'kz') result.language = 'kk';
    else if (lang === 'ru') result.language = 'ru';
    else result.language = 'en';

    // Assign UUIDs to todos
    result.todos = result.todos.map(t => ({
      id: uuid(),
      task: t.task || '',
      priority: (['high','medium','low'].includes(t.priority) ? t.priority : 'medium') as any,
      done: t.done || false,
      time: t.time || undefined,
      duration: t.duration || 30,
      location: t.location || undefined,
    }));

    const timed = result.todos.filter(t => t.time).length;
    const hasLoc = !!result.needs_location_check;
    console.log(`[Analysis] "${result.title}" [${result.language}] — ${result.todos.length} todos (${timed} timed) ${hasLoc ? '📍 location check' : ''}`);
    return result;
  } catch (error) {
    console.error('[Analysis] Error:', error);
    throw new Error(`Failed to analyze: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}
