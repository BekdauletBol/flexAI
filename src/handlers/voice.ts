import { Context, InputFile } from 'grammy';
import { config } from '../config.js';
import { transcribeAudio } from '../services/whisper.js';
import { analyzeTranscript } from '../services/analysis.js';
import { generateDocx } from '../services/docx.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

/**
 * Download a file from URL to a local path.
 * Uses native Node.js http/https — no need for axios.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    client.get(url, (response) => {
      // Handle redirects
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`HTTP ${response.statusCode} when downloading file`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format the file name for the docx: note_YYYY-MM-DD_HH-mm.docx
 */
function generateFileName(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `note_${datePart}_${timePart}.docx`;
}

/**
 * Main voice message handler.
 * Pipeline: Download → Transcribe → Analyze → Generate DOCX → Send
 */
export async function handleVoice(ctx: Context) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || 'unknown';
  console.log(`[Voice] Received voice message from ${username} (${userId})`);

  if (!ctx.message?.voice) return;

  // Optional: Check if user is allowed
  if (config.allowedUserId && userId !== config.allowedUserId) {
    await ctx.reply('❌ У вас нет доступа к этому боту.');
    return;
  }

  const statusMsg = await ctx.reply('🎙 Транскрибирую голосовое сообщение...');
  let tempFilePath = '';
  let transcript = '';

  try {
    // ── Step 1: Download the voice file ──────────────────
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;

    // Ensure temp directory exists
    const tempDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    tempFilePath = path.join(tempDir, `voice_${Date.now()}.ogg`);
    await downloadFile(fileUrl, tempFilePath);
    const fileSize = fs.statSync(tempFilePath).size;
    console.log(`[Voice] Downloaded: ${tempFilePath} (${(fileSize / 1024).toFixed(1)} KB)`);

    // ── Step 2: Transcribe ───────────────────────────────
    transcript = await transcribeAudio(tempFilePath);

    if (!transcript || transcript.trim().length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        '❌ Не удалось распознать голосовое. Попробуй ещё раз.'
      );
      return;
    }

    // ── Step 3: Analyze ──────────────────────────────────
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '🧠 Анализирую содержание...');

    let analysis;
    try {
      analysis = await analyzeTranscript(transcript);
    } catch (analysisError) {
      console.error('[Voice] Analysis failed, sending transcript only:', analysisError);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Ошибка анализа. Вот транскрипция:\n\n${transcript}`
      );
      return;
    }

    // ── Step 4: Generate DOCX ────────────────────────────
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '📄 Создаю документ...');

    let docxBuffer: Buffer;
    const fileName = generateFileName();

    try {
      docxBuffer = await generateDocx(analysis);
    } catch (docxError) {
      console.error('[Voice] DOCX generation failed, sending .txt fallback:', docxError);

      // Fallback: send as plain text file
      const txtContent = [
        `# ${analysis.title}`,
        '',
        `## Краткое содержание`,
        analysis.summary,
        '',
        `## Ключевые моменты`,
        ...analysis.key_points.map(p => `- ${p}`),
        '',
        `## Задачи`,
        ...analysis.todos.map(t => `- [${t.done ? 'x' : ' '}] ${t.task} (${t.priority})`),
        '',
        `## Теги`,
        analysis.tags.join(', '),
        '',
        `## Транскрипция`,
        analysis.raw_transcript,
      ].join('\n');

      const txtBuffer = Buffer.from(txtContent, 'utf-8');
      const txtFileName = fileName.replace('.docx', '.txt');
      await ctx.replyWithDocument(new InputFile(txtBuffer, txtFileName));
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      return;
    }

    // ── Step 5: Send results ─────────────────────────────
    // Send the DOCX file
    await ctx.replyWithDocument(new InputFile(docxBuffer, fileName), {
      caption: `📎 ${analysis.title}`,
    });

    // Build Telegram text summary
    const todoLines = analysis.todos.length > 0
      ? analysis.todos
          .map(t => {
            const icon = t.done ? '☑' : '☐';
            const priorityEmoji = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '⚪';
            return `${icon} ${priorityEmoji} ${t.task}`;
          })
          .join('\n')
      : 'Задач не обнаружено';

    const summaryText =
      `📌 *${analysis.title}*\n\n` +
      `📝 *Суть:*\n${analysis.summary}\n\n` +
      `✅ *Задачи:*\n${todoLines}\n\n` +
      `🏷 *Теги:* ${analysis.tags.join(', ') || 'нет'}`;

    await ctx.reply(summaryText, { parse_mode: 'Markdown' });

    // Cleanup the status message
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {
      // Status message might already be deleted
    }

    console.log(`[Voice] ✅ Pipeline complete for ${username}: "${analysis.title}"`);

  } catch (error) {
    console.error('[Voice Handler] Pipeline error:', error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('Failed to transcribe')) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        '❌ Не удалось распознать голосовое сообщение. Попробуй ещё раз.'
      );
    } else if (transcript) {
      // We have a transcript but something else failed — send it
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Ошибка обработки. Вот транскрипция:\n\n${transcript.substring(0, 4000)}`
      );
    } else {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        '❌ Произошла ошибка при обработке голосового сообщения. Попробуйте позже.'
      );
    }
  } finally {
    // Cleanup temp files
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
