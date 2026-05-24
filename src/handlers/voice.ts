import { Context, InputFile, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { transcribeAudio } from '../services/whisper.js';
import { analyzeTranscript } from '../services/analysis.js';
import { generatePdf } from '../services/pdf.js';
import { generateChart } from '../services/chart.js';
import { scheduleReminders } from '../services/scheduler.js';
import { savePlan, getPlanForWebApp } from '../services/planStore.js';
import { getUserConfig } from '../services/userConfig.js';
import { searchPlace, getWeatherForecast, getDirections, generateLocationAdvice } from '../services/location.js';
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

export async function handleVoice(ctx: Context) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || '?';
  if (!ctx.message?.voice) return;
  if (!userId) return;
  if (config.allowedUserId && userId !== config.allowedUserId) { await ctx.reply('❌ Access denied.'); return; }

  const statusMsg = await ctx.reply('🎙 Transcribing...');
  let tempFile = '', transcript = '';

  try {
    // 1. Download voice message
    const f = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`;
    const tmpDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFile = path.join(tmpDir, `v_${Date.now()}.ogg`);
    await downloadFile(url, tempFile);

    // 2. Transcribe
    transcript = await transcribeAudio(tempFile);
    if (!transcript?.trim()) { await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Could not recognize speech.'); return; }

    // 3. Analyze transcript with AI
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '🧠 Analyzing...');
    let analysis;
    try { analysis = await analyzeTranscript(transcript); }
    catch (e) {
      console.error('[Voice] Analysis failed:', e);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ Analysis failed.\n\n${transcript}`);
      return;
    }

    // 4. Persist plan in PlanStore
    if (ctx.chat) {
      savePlan(ctx.chat.id, userId, analysis);
    }

    // 5. Schedule reminders
    const timedTasks = analysis.todos.filter(t => t.time);
    if (timedTasks.length > 0 && ctx.chat) {
      scheduleReminders(ctx.chat.id, userId, analysis.todos, analysis.language);
    }

    // 6. Check Location Assistant
    let locationAdvice = '';
    if (analysis.needs_location_check && analysis.location_query && analysis.visit_datetime) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '📍 Checking location details...');
      
      const userSettings = getUserConfig(userId);
      const hasCoords = userSettings.lat !== undefined && userSettings.lng !== undefined;

      try {
        const placePromise = searchPlace(analysis.location_query);
        const weatherPromise = hasCoords 
          ? getWeatherForecast(userSettings.lat!, userSettings.lng!, analysis.visit_datetime)
          : Promise.resolve(null);
        const directionsPromise = hasCoords
          ? getDirections(userSettings.lat!, userSettings.lng!, analysis.location_query)
          : Promise.resolve(null);

        const [place, weather, directions] = await Promise.all([placePromise, weatherPromise, directionsPromise]);

        locationAdvice = await generateLocationAdvice(
          analysis.location_query,
          analysis.visit_datetime,
          place,
          weather,
          directions,
          analysis.language
        );

        if (!hasCoords) {
          const coordTip = analysis.language === 'ru' 
            ? '\n\n💡 *Подсказка:* Чтобы бот мог построить маршрут и показать погоду, отправьте свою геолокацию с помощью кнопки /setlocation.'
            : analysis.language === 'kk'
            ? '\n\n💡 *Кеңес:* Маршрут құру және ауа райын білу үшін /setlocation командасы арқылы геолокацияңызды жіберіңіз.'
            : '\n\n💡 *Tip:* To get route directions and weather forecast, send your location coordinates using the /setlocation command.';
          locationAdvice += coordTip;
        }
      } catch (err) {
        console.error('[Voice] Location assistant error:', err);
      }
    }

    // 7. Generate Timeline & Priority Chart
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '📊 Generating timeline graph...');
    let chartBuf: Buffer | null = null;
    try {
      chartBuf = await generateChart(analysis);
    } catch (e) {
      console.error('[Voice] Chart generation failed:', e);
    }

    // 8. Generate PDF
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '📄 Creating PDF...');
    const fn = fileName();
    let pdfBuf: Buffer;
    try { 
      pdfBuf = await generatePdf(analysis); 
    } catch (e) {
      console.error('[Voice] PDF generation failed, falling back to text:', e);
      const txt = `# ${analysis.title}\n\n${analysis.summary}\n\n${analysis.key_points.map(p => `- ${p}`).join('\n')}`;
      await ctx.replyWithDocument(new InputFile(Buffer.from(txt, 'utf-8'), fn.replace('.pdf', '.txt')));
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); 
      return;
    }

    // 9. Send results
    // Send chart if generated
    if (chartBuf) {
      const chartCaption = analysis.language === 'ru' ? '📊 График задач и приоритеты' : analysis.language === 'kk' ? '📊 Тапсырмалар графигі' : '📊 Task Timeline & Priorities';
      await ctx.replyWithPhoto(new InputFile(chartBuf, 'chart.png'), { caption: chartCaption });
    }

    // Send PDF note
    await ctx.replyWithDocument(new InputFile(pdfBuf, fn), { caption: `📎 ${analysis.title}` });

    // Send Location Advice if generated
    if (locationAdvice) {
      const locationTitle = analysis.language === 'ru' ? '📍 *Ассистент по локации*' : analysis.language === 'kk' ? '📍 *Локация ассистенті*' : '📍 *Location Assistant*';
      await ctx.reply(`${locationTitle}\n\n${locationAdvice}`, { parse_mode: 'Markdown' });
    }

    // Prepare Mini App URL
    let webAppKeyboard: InlineKeyboard | undefined;
    if (config.webappUrl && ctx.chat) {
      const planData = getPlanForWebApp(ctx.chat.id);
      if (planData) {
        const base64 = Buffer.from(JSON.stringify(planData), 'utf-8').toString('base64');
        const fullUrl = `${config.webappUrl}#${base64}`;
        const btnLabel = analysis.language === 'ru' ? '📅 Открыть план в Mini App' : analysis.language === 'kk' ? '📅 Жоспарды Mini App-та ашу' : '📅 Open Plan in Mini App';
        webAppKeyboard = new InlineKeyboard().webApp(btnLabel, fullUrl);
      }
    }

    // Prepare chat summary text
    const todoLines = analysis.todos.length > 0
      ? analysis.todos.map(t => {
          const dot = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '⚪';
          const time = t.time ? ` ⏰${t.time}` : '';
          return `${t.done ? '☑' : '☐'} ${dot} ${t.task}${time}`;
        }).join('\n')
      : '—';

    const reminderNote = timedTasks.length > 0
      ? (analysis.language === 'ru' 
         ? `\n\n⏰ *Установлено ${timedTasks.length} напоминаний* — сообщу за 30 мин до начала!` 
         : analysis.language === 'kk'
         ? `\n\n⏰ *${timedTasks.length} еске салғыш орнатылды* — тапсырмаға 30 мин қалғанда хабарлаймын!`
         : `\n\n⏰ *${timedTasks.length} reminder(s) set* — I'll notify you 30 min before each task!`)
      : '';

    const summaryTitle = analysis.language === 'ru' ? '📌 *Сводка плана*' : analysis.language === 'kk' ? '📌 *Жоспар жиынтығы*' : '📌 *Plan Summary*';
    const tasksTitle = analysis.language === 'ru' ? '✅ *Задачи:*' : analysis.language === 'kk' ? '✅ *Тапсырмалар:*' : '✅ *Tasks:*';

    await ctx.reply(
      `${summaryTitle}\n\n*${analysis.title}*\n${analysis.summary}\n\n${tasksTitle}\n${todoLines}\n\n🏷 ${analysis.tags.join(', ') || '—'}${reminderNote}`,
      { parse_mode: 'Markdown', reply_markup: webAppKeyboard }
    );

    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}
    console.log(`[Voice] ✅ processed voice note "${analysis.title}" [${analysis.language}]`);

  } catch (error) {
    console.error('[Voice] Error:', error);
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('Failed to transcribe')) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Could not recognize speech.');
    } else if (transcript) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ Error during processing.\n\n${transcript.substring(0, 4000)}`);
    } else {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Something went wrong.');
    }
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}
