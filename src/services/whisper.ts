import OpenAI from 'openai';
import { config } from '../config.js';
import fs from 'fs';

/**
 * Groq client for Whisper transcription.
 * Groq provides a free tier with whisper-large-v3 (2,000 req/day).
 * It's OpenAI SDK-compatible, just point baseURL to Groq.
 * Groq supports OGG/Opus natively — no ffmpeg conversion needed!
 */
const groq = new OpenAI({
  apiKey: config.groqApiKey,
  baseURL: 'https://api.groq.com/openai/v1',
});

/**
 * Transcribe audio using Groq's free Whisper API.
 * Supports: ogg, mp3, wav, flac, m4a, webm, mp4, mpeg.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  try {
    const fileSize = fs.statSync(filePath).size;
    console.log(`[Whisper] Transcribing audio (${(fileSize / 1024).toFixed(1)} KB) via Groq Whisper...`);

    const response = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3',
      // No language param — auto-detect (supports RU, EN, KK)
    });

    const transcript = response.text.trim();

    if (!transcript) {
      throw new Error('Empty transcription result');
    }

    console.log(`[Whisper] Done (${transcript.length} chars): "${transcript.substring(0, 80)}..."`);
    return transcript;
  } catch (error) {
    console.error('[Whisper Service] Error:', error);
    throw new Error('Failed to transcribe audio');
  }
}
