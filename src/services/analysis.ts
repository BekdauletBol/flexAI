import OpenAI from 'openai';
import { config } from '../config.js';
import { AnalysisResult } from '../types/analysis.js';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
});

const SYSTEM_PROMPT = `You are an expert assistant for analyzing voice notes.
Your task is to analyze the provided transcription and return a structured JSON object.

The voice notes can be in Russian, English, Kazakh, or a mix of languages.
Always respond with a JSON object in the EXACT following format — nothing else:

{
  "title": "Short title for the note (5-7 words, in the same language as the transcript)",
  "summary": "2-3 sentence summary of the key content",
  "key_points": ["point 1", "point 2", "..."],
  "todos": [
    { "task": "Task description", "priority": "high", "done": false }
  ],
  "tags": ["#tag1", "#tag2"],
  "raw_transcript": "the full original transcript provided by user",
  "language": "ru"
}

Guidelines:
- Be concise and action-oriented.
- Extract EVERY actionable item as a TODO (things to do, check, buy, call, etc.).
- If there are no actionable items, return an empty todos array.
- Set priority: "high" for urgent/important, "medium" for standard, "low" for nice-to-have.
- Generate Obsidian-style tags (with #) based on the topic and context.
- Use the same language as the transcript for title, summary, key_points, and todo tasks.
- The "language" field should be "ru", "en", or "mixed" depending on the transcript.
- Return ONLY the JSON object — no markdown fences, no extra text, no explanation.`;

export async function analyzeTranscript(transcript: string): Promise<AnalysisResult> {
  try {
    console.log(`[Analysis] Analyzing transcript (${transcript.length} chars)...`);

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
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    console.log(`[Analysis] Raw response: ${content.substring(0, 200)}...`);

    const result = JSON.parse(content) as AnalysisResult;

    // Always override raw_transcript with the actual transcript
    result.raw_transcript = transcript;

    // Validate and provide defaults for missing fields
    result.title = result.title || 'Голосовая заметка';
    result.summary = result.summary || transcript.substring(0, 200);
    result.key_points = result.key_points || [];
    result.todos = result.todos || [];
    result.tags = result.tags || [];
    result.language = result.language || 'ru';

    // Normalize todos
    result.todos = result.todos.map(todo => ({
      task: todo.task || '',
      priority: (['high', 'medium', 'low'].includes(todo.priority) ? todo.priority : 'medium') as 'high' | 'medium' | 'low',
      done: todo.done || false,
    }));

    console.log(`[Analysis] Done: "${result.title}" — ${result.key_points.length} points, ${result.todos.length} todos`);

    return result;
  } catch (error) {
    console.error('[Analysis Service] Error:', error);
    throw new Error(`Failed to analyze transcript: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
