import { Context, InputFile, InlineKeyboard } from 'grammy';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { transcribeAudio } from '../services/whisper.js';
import { analyzeTranscript } from '../services/analysis.js';
import { generatePdf } from '../services/pdf.js';
import { scheduleReminders } from '../services/scheduler.js';
import { savePlan, detectTimeConflicts } from '../services/planStore.js';
import { setUserLocation, getUserConfig } from '../services/userConfig.js';
import { geocodeCity, searchPlace, getWeatherForecast } from '../services/location.js';
import { setPendingReminderConfig, getPendingSession, getTaskKeyboard, getTaskMessage, clearPendingSession } from '../services/reminderSession.js';
import { setPendingPlan, getPendingPlan, advanceStep, clearPendingPlan } from '../services/pendingPlan.js';
import { TodoItem, AnalysisResult } from '../types/analysis.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject); return;
      }
      if (res.statusCode !== 200) { file.close(); fs.unlinkSync(dest); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
    }).on('error', (e) => { fs.unlinkSync(dest); reject(e); });
  });
}

function fileName(): string {
  const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
  return `note_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
}

function fmtShortDate(d: string): string {
  const months: Record<string, string> = {
    '1':'Jan','2':'Feb','3':'Mar','4':'Apr','5':'May','6':'Jun',
    '7':'Jul','8':'Aug','9':'Sep','10':'Oct','11':'Nov','12':'Dec',
  };
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  const m = parts[1].replace(/^0+/, '');
  return `${parts[2]} ${months[m] || parts[1]}`;
}

// Called when step transitions to 'done' — generates PDF, sends result, cleans up
export async function deliverPlan(ctx: Context, chatId: number, userId: number, analysis: AnalysisResult, statusMsgId: number) {
  await ctx.api.editMessageText(chatId, statusMsgId, 'Generating PDF...');
  const fn = fileName();
  let pdfBuf: Buffer;
  try {
    pdfBuf = await generatePdf(analysis);
  } catch (e) {
    logger.error(e, '[Voice] PDF generation failed, falling back to text:');
    const txt = `${analysis.title}\n\n${analysis.summary}\n\n${analysis.key_points.map(p => `- ${p}`).join('\n')}`;
    await ctx.replyWithDocument(new InputFile(Buffer.from(txt, 'utf-8'), fn.replace('.pdf', '.txt')));
    await ctx.api.deleteMessage(chatId, statusMsgId);
    return;
  }

  await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: analysis.title });

  const todoLines = analysis.todos.length > 0
    ? analysis.todos.map((t: any) => {
        let suffix = '';
        if (t.date && t.time) suffix = ` \u00B7 ${fmtShortDate(t.date)} ${t.time}`;
        else if (t.date) suffix = ` \u00B7 ${fmtShortDate(t.date)}`;
        else if (t.time) suffix = ` \u00B7 ${t.time}`;
        return `\u2014 ${t.task} \u00B7 ${t.priority}${suffix}`;
      }).join('\n')
    : '\u2014';

  await ctx.reply(
    `${analysis.title}\n\n${analysis.summary}\n\nTASKS\n${todoLines}\n\nTAGS\n${analysis.tags.join(', ') || '\u2014'}`
  );

  try { await ctx.api.deleteMessage(chatId, statusMsgId); } catch {}
  clearPendingPlan(chatId);
}

function getTimeMinutes(todo: { time?: string; datetime?: string; duration?: number }): number | null {
  if (todo.time) {
    const parts = todo.time.split(':');
    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }
  if (todo.datetime) {
    const d = new Date(todo.datetime);
    if (!isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
  }
  return null;
}

function detectSameNoteConflicts(todos: { id: string; time?: string; datetime?: string; duration?: number; done?: boolean }[]): { existing: any; new: any }[] {
  const conflicts: { existing: any; new: any }[] = [];
  for (let i = 0; i < todos.length; i++) {
    const a = todos[i];
    const aStart = getTimeMinutes(a);
    if (aStart === null) continue;
    const aEnd = aStart + (a.duration || 30);
    for (let j = i + 1; j < todos.length; j++) {
      const b = todos[j];
      const bStart = getTimeMinutes(b);
      if (bStart === null) continue;
      const bEnd = bStart + (b.duration || 30);
      if (aStart < bEnd && aEnd > bStart) {
        conflicts.push({ existing: a, new: b });
      }
    }
  }
  return conflicts;
}

export async function handleVoice(ctx: Context) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || '?';
  if (!ctx.message?.voice) return;
  if (!userId) return;
  if (config.allowedUserId && userId !== config.allowedUserId) { await ctx.reply('Access denied.'); return; }

  const statusMsg = await ctx.reply('Transcribing...');
  let tempFile = '', transcript = '';

  try {
    const f = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`;
    const tmpDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFile = path.join(tmpDir, `v_${Date.now()}.ogg`);
    await downloadFile(url, tempFile);

    transcript = await transcribeAudio(tempFile);
    if (!transcript?.trim()) { await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Could not recognize speech.'); return; }

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Analyzing...');
    let analysis;
    try { analysis = await analyzeTranscript(transcript); }
    catch (e) {
      logger.error(e, '[Voice] Analysis failed:');
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `Analysis failed.\n\n${transcript}`);
      return;
    }

    // Save user city if detected in analysis
    if (analysis.user_city) {
      try {
        const coords = await geocodeCity(analysis.user_city);
        if (coords) {
          setUserLocation(userId, analysis.user_city, coords.lat, coords.lng);
        }
      } catch {}
    }

    // Weather check — fetch and send as separate clear message
    if (analysis.needs_location_check) {
      let weatherLat = 0, weatherLng = 0;
      const userCfg = getUserConfig(userId);

      if (userCfg.lat && userCfg.lng) {
        weatherLat = userCfg.lat;
        weatherLng = userCfg.lng;
      } else if (analysis.user_city) {
        const coords = await geocodeCity(analysis.user_city).catch(() => null);
        if (coords) { weatherLat = coords.lat; weatherLng = coords.lng; }
      } else if (analysis.location_query) {
        const place = await searchPlace(analysis.location_query).catch(() => null);
        // can't extract coords from PlaceResult, no lat/lng there
      }

      if (weatherLat && weatherLng) {
        const weather = await getWeatherForecast(weatherLat, weatherLng, analysis.visit_datetime || new Date().toISOString(), analysis.language).catch(() => null);
        if (weather) {
          const lang = analysis.language || 'en';
          let dateLine = '';
          if (analysis.visit_datetime) {
            const d = new Date(analysis.visit_datetime);
            dateLine = d.toLocaleDateString(lang === 'ru' ? 'ru-RU' : lang === 'kk' ? 'kk-KZ' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
          }
          const emoji = weather.icon.includes('d') ? '\u2600\uFE0F' : '\uD83C\uDF19';
          const weatherMsg = lang === 'ru'
            ? `ПОГОДА\n\n${dateLine ? dateLine + '\n' : ''}${emoji} ${weather.description}, ${weather.temp}\u00B0C, ощущается ${weather.feels_like}\u00B0C\n\u2014 Ветер: ${weather.wind_speed} м/с\n\u2014 Влажность: ${weather.humidity}%`
            : lang === 'kk'
            ? `АУА РАЙЫ\n\n${dateLine ? dateLine + '\n' : ''}${emoji} ${weather.description}, ${weather.temp}\u00B0C, ${weather.feels_like}\u00B0C сезiледi\n\u2014 Жел: ${weather.wind_speed} м/с\n\u2014 Ылғалдылық: ${weather.humidity}%`
            : `WEATHER\n\n${dateLine ? dateLine + '\n' : ''}${emoji} ${weather.description}, ${weather.temp}\u00B0C, feels like ${weather.feels_like}\u00B0C\n\u2014 Wind: ${weather.wind_speed} m/s\n\u2014 Humidity: ${weather.humidity}%`;
          await ctx.reply(weatherMsg);
        }
      } else if (analysis.location_query) {
        const place = await searchPlace(analysis.location_query).catch(() => null);
        if (place) {
          await ctx.reply(`LOCATION INFO\n\n\u2014 ${place.name}\n\u2014 ${place.address}${place.phone ? `\n\u2014 ${place.phone}` : ''}${place.hours?.length ? `\n\u2014 Hours: ${place.hours.join(', ')}` : ''}`);
        }
      }
    }

    const conflicts = ctx.chat ? detectTimeConflicts(userId, analysis.todos) : [];
    // Also detect conflicts among new todos themselves (same voice note)
    const sameNoteConflicts = detectSameNoteConflicts(analysis.todos);
    for (const c of sameNoteConflicts) {
      // Only add if not already in conflicts
      if (!conflicts.some(ex => ex.new.id === c.new.id)) {
        conflicts.push(c);
      }
    }
    const timedTasks = analysis.todos.filter(t => t.time || t.datetime);

    if (conflicts.length > 0 && ctx.chat) {
      // Step 1: show conflicts, save plan later
      setPendingPlan(ctx.chat.id, {
        chatId: ctx.chat.id,
        userId,
        analysis,
        statusMsgId: statusMsg.message_id,
        step: 'conflicts',
        totalConflicts: conflicts.length,
        resolvedConflicts: new Set(),
      });

      for (const c of conflicts) {
        const exHour = parseInt(c.existing.time!.split(':')[0]);
        const exMin = parseInt(c.existing.time!.split(':')[1]);
        const exDuration = c.existing.duration || 30;
        const totalMin = exHour * 60 + exMin + exDuration + 15;
        const suggestH = Math.floor(totalMin / 60) % 24;
        const suggestM = totalMin % 60;
        const newTime = `${String(suggestH).padStart(2, '0')}:${String(suggestM).padStart(2, '0')}`;

        const kb = new InlineKeyboard()
          .text('Keep both', `cf_keep_${c.new.id}`)
          .text('Skip new', `cf_skip_${c.new.id}`)
          .text(`+15min`, `cf_move_${c.new.id}_${newTime}`)
          .text('Custom', `cf_custom_${c.new.id}`);

        await ctx.reply(
          `CONFLICT\n\n\u2014 ${c.existing.task} \u00B7 ${c.existing.time}\n\u2014 ${c.new.task} \u00B7 ${c.new.time}`,
          { reply_markup: kb }
        );
      }
      return;
    }

    // No conflicts — save plan immediately
    if (ctx.chat) {
      savePlan(ctx.chat.id, userId, analysis);
    }

    if (timedTasks.length > 0 && ctx.chat) {
      // Step 2: show reminder prompts first (only for tasks with actual time, not just date)
      const tasksWithTime = timedTasks.filter(t => t.time);

      if (tasksWithTime.length > 0) {
        setPendingPlan(ctx.chat.id, {
          chatId: ctx.chat.id,
          userId,
          analysis,
          statusMsgId: statusMsg.message_id,
          step: 'reminders',
          totalConflicts: 0,
          resolvedConflicts: new Set(),
        });

        setPendingReminderConfig(ctx.chat.id, userId, analysis.todos, analysis.language);
        const session = getPendingSession(ctx.chat.id);
        if (session) {
          const msg = await ctx.reply(getTaskMessage(session), {
            reply_markup: getTaskKeyboard(session.currentTaskIndex, session.tasks.length),
          });
          session.messageId = msg.message_id;
        }
        return;
      }
    }

    // No conflicts, no timed tasks — deliver immediately
    if (ctx.chat) {
      await deliverPlan(ctx, ctx.chat.id, userId, analysis, statusMsg.message_id);
    }

  } catch (error) {
    logger.error(error, '[Voice] Error:');
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('Failed to transcribe')) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Could not recognize speech.');
    } else if (transcript) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `Error during processing.\n\n${transcript.substring(0, 4000)}`);
    } else {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'Something went wrong.');
    }
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}
