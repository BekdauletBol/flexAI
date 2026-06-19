import { logger } from '../logger.js';
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
    logger.info(`[Whisper] Transcribing audio (${(fileSize / 1024).toFixed(1)} KB) via Groq Whisper...`);

    // Guard: file too small (< 1 KB) is likely empty/corrupt
    if (fileSize < 1000) {
      console.error('[Whisper] File too small:', fileSize, 'bytes');
      throw new Error('Audio file too short');
    }

    const response = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3',
      // No language param — auto-detect (supports RU, EN, KK)
    });

    const transcript = response.text.trim();
    console.log('[Whisper] Success:', transcript.length, 'chars');

    if (!transcript) {
      throw new Error('Empty transcription result');
    }

    logger.info(`[Whisper] Done (${transcript.length} chars): "${transcript.substring(0, 80)}..."`);
    return transcript;
  } catch (error: any) {
    console.error('[Whisper] Failed:', error?.status, error?.message);
    try {
      const fileSize = fs.statSync(filePath).size;
      console.error('[Whisper] File size:', fileSize, 'bytes');
    } catch {}
    logger.error(error, '[Whisper Service] Error:');
    throw new Error('Failed to transcribe audio');
  }
}
