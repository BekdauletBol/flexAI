import PDFDocument from 'pdfkit';
import path from 'path';
import { db } from './db.js';
import { getLabels, Lang } from '../types/i18n.js';
import { DateTime } from 'luxon';

const KZ_ZONE = 'Asia/Almaty';

const ROOT = path.resolve(process.cwd());
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');

function getFonts() {
  return {
    regular: path.join(FONT_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(FONT_DIR, 'Roboto-Bold.ttf'),
    italic: path.join(FONT_DIR, 'Roboto-Italic.ttf'),
  };
}

// ── Obsidian-style colors ────────────────────────────────
const BG = '#0D1117';
const CARD_BG = '#161B22';
const BORDER = '#30363D';
const ACCENT = '#58A6FF';
const TEXT_PRI = '#E6EDF3';
const TEXT_SEC = '#8B949E';
const PRI_HIGH = '#F85149';
const PRI_MED = '#D29922';
const PRI_LOW = '#3FB950';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50;
const CW = PAGE_W - M * 2;
const MAX_Y = PAGE_H - M - 10;

function drawBg(doc: PDFKit.PDFDocument) {
  doc.save().rect(0, 0, PAGE_W, PAGE_H).fill(BG).restore();
}

function drawPriorityBadge(doc: PDFKit.PDFDocument, priority: string, x: number, y: number): number {
  const pColor = priority === 'high' ? PRI_HIGH : priority === 'medium' ? PRI_MED : PRI_LOW;
  const pLabel = priority.toUpperCase();
  doc.font('Bold').fontSize(8).fillColor(pColor);
  const pWidth = doc.widthOfString(pLabel) + 10;
  doc.save().roundedRect(x, y - 2, pWidth, 14, 3).fillOpacity(0.15).fill(pColor).restore();
  doc.save().roundedRect(x, y - 2, pWidth, 14, 3).lineWidth(1).strokeColor(pColor).strokeOpacity(0.5).stroke().restore();
  doc.text(pLabel, x, y, { width: pWidth, align: 'center' });
  return x + pWidth + 6;
}

function drawStatusIcon(doc: PDFKit.PDFDocument, done: boolean, x: number, y: number) {
  if (done) {
    doc.save().circle(x + 6, y + 6, 6).fill(PRI_LOW).restore();
    doc.save().moveTo(x + 3, y + 6).lineTo(x + 5.5, y + 8.5).lineTo(x + 9, y + 3.5)
      .lineWidth(1.5).strokeColor(BG).stroke().restore();
  } else {
    doc.save().circle(x + 6, y + 6, 6).fill(BG).restore();
    doc.save().circle(x + 6, y + 6, 5.5).lineWidth(1).strokeColor(BORDER).stroke().restore();
  }
}

interface TaskRow {
  id: string;
  task: string;
  priority: string;
  done: number;
  time: string | null;
  date: string | null;
  duration: number;
  location: string | null;
  source: string | null;
  datetime: string | null;
  scheduled_time_kz: string | null;
  has_conflict: number;
}

function queryTasksForDate(userId: number, dateStr: string): TaskRow[] {
  // Direct SQL query matching tasks for a specific date
  // Check both `date` column and `scheduled_time_kz` column
  const stmt = db.prepare(`
    SELECT DISTINCT * FROM todos
    WHERE user_id = ?
      AND (is_reminder IS NULL OR is_reminder = 0)
      AND (
        date = ?
        OR substr(COALESCE(scheduled_time_kz, date || 'T' || COALESCE(time, '00:00')), 1, 10) = ?
      )
    ORDER BY
      CASE WHEN time IS NULL THEN 1 ELSE 0 END,
      time ASC,
      id ASC
  `);
  return stmt.all(userId, dateStr, dateStr) as TaskRow[];
}

function queryAllTasks(userId: number): TaskRow[] {
  const stmt = db.prepare(`
    SELECT DISTINCT * FROM todos
    WHERE user_id = ?
    ORDER BY
      date ASC,
      CASE WHEN time IS NULL THEN 1 ELSE 0 END,
      time ASC
  `);
  return stmt.all(userId) as TaskRow[];
}

function formatDateHeader(dateStr: string, lang: string): string {
  const d = DateTime.fromISO(dateStr, { zone: KZ_ZONE });
  const locale = lang === 'ru' ? 'ru-RU' : lang === 'kk' ? 'kk-KZ' : 'en-US';
  return d.setLocale(locale).toFormat('cccc, d MMMM yyyy');
}

function formatNow(): string {
  const d = DateTime.now().setZone(KZ_ZONE);
  return d.toFormat('MMM d, yyyy · HH:mm');
}

/**
 * Generate a daily report PDF directly from SQLite data.
 * No LLM involved - pure database query + PDFKit rendering.
 */
export async function generateDailyReportPdf(userId: number, dateStr: string, lang: string = 'ru'): Promise<Buffer> {
  const labels = getLabels(lang);
  const fonts = getFonts();
  const tasks = queryTasksForDate(userId, dateStr);
  const timed = tasks.filter(t => t.time);
  const untimed = tasks.filter(t => !t.time);
  console.log('[DailyReport] Rows from DB:', tasks.length, '| Timed:', timed.length, '| Untimed:', untimed.length);
  const allTasks = tasks;

  const pending = allTasks.filter(t => !t.done);
  const completed = allTasks.filter(t => t.done);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Regular', fonts.regular);
    doc.registerFont('Bold', fonts.bold);
    doc.registerFont('Italic', fonts.italic);

    doc.on('pageAdded', () => drawBg(doc));
    drawBg(doc);

    let y = M;

    // ── Header ────────────────────────────────────────
    const titleText = lang === 'ru' ? 'ОТЧЁТ ПО ЗАДАЧАМ' : lang === 'kk' ? 'ТАПСЫРМАЛАР ЕСЕБІ' : 'TASK REPORT';
    doc.font('Bold').fontSize(28).fillColor(TEXT_PRI);
    doc.text(titleText, M, y, { width: CW });
    y = doc.y + 4;

    doc.font('Regular').fontSize(13).fillColor(TEXT_SEC);
    doc.text(formatDateHeader(dateStr, lang), M, y, { width: CW });
    y = doc.y + 4;

    doc.font('Regular').fontSize(11).fillColor(TEXT_SEC);
    doc.text(formatNow(), M, y, { width: CW });
    y = doc.y + 14;

    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1).strokeColor(BORDER).stroke().restore();
    y += 16;

    // ── Summary Stats ──────────────────────────────────
    const totalLabel = lang === 'ru' ? 'Всего' : lang === 'kk' ? 'Барлығы' : 'Total';
    const doneLabel = lang === 'ru' ? 'Выполнено' : lang === 'kk' ? 'Орындалды' : 'Done';
    const pendingLabel = lang === 'ru' ? 'В ожидании' : lang === 'kk' ? 'Күтуде' : 'Pending';

    doc.font('Bold').fontSize(11).fillColor(ACCENT);
    doc.text(labels.summary.toUpperCase(), M, y, { characterSpacing: 2, width: CW });
    y = doc.y + 8;

    // Stats row
    doc.font('Regular').fontSize(12).fillColor(TEXT_PRI);
    doc.text(`${totalLabel}: ${allTasks.length}`, M, y);
    doc.font('Regular').fontSize(12).fillColor(PRI_LOW);
    doc.text(`${doneLabel}: ${completed.length}`, M + 100, y);
    doc.font('Regular').fontSize(12).fillColor(PRI_MED);
    doc.text(`${pendingLabel}: ${pending.length}`, M + 220, y);
    y = doc.y + 16;

    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(BORDER).stroke().restore();
    y += 16;

    // ── Tasks Timeline ─────────────────────────────
    if (allTasks.length > 0) {
      doc.font('Bold').fontSize(11).fillColor(ACCENT);
      doc.text(labels.tasks.toUpperCase(), M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 10;

      const lineX = 60;
      const nodeYs: number[] = [];
      const nodeSpacing = 52;
      const pageBottom = PAGE_H - M;

      for (const task of allTasks) {
        if (y > pageBottom - nodeSpacing) {
          doc.addPage();
          y = M + 20;
          nodeYs.length = 0;
        }

        nodeYs.push(y + 6);

        // Status icon
        drawStatusIcon(doc, !!task.done, lineX - 6, y);

        // Time text
        if (task.time) {
          doc.font('Bold').fontSize(12).fillColor(TEXT_PRI);
          doc.text(task.time, 80, y + 1);
        } else {
          doc.font('Regular').fontSize(10).fillColor(TEXT_SEC);
          doc.text('--:--', 80, y + 1);
        }

        // Priority pill (right-aligned)
        const pColor = task.priority === 'high' ? PRI_HIGH : task.priority === 'medium' ? PRI_MED : PRI_LOW;
        const pLabel = task.priority.toUpperCase();
        doc.font('Bold').fontSize(8).fillColor(pColor);
        const pWidth = doc.widthOfString(pLabel) + 12;
        const pX = PAGE_W - M - pWidth;
        doc.save().roundedRect(pX, y - 1, pWidth, 14, 4).fillOpacity(0.1).fill(pColor).restore();
        doc.save().roundedRect(pX, y - 1, pWidth, 14, 4).lineWidth(1).strokeColor(pColor).strokeOpacity(0.5).stroke().restore();
        doc.text(pLabel, pX, y + 2, { width: pWidth, align: 'center' });

        // Task name
        const taskStyle = task.done ? 'Italic' : 'Regular';
        doc.font(taskStyle as any).fontSize(13).fillColor(task.done ? TEXT_SEC : TEXT_PRI);
        const taskPrefix = task.has_conflict ? '⚠️ ' : '';
        const srcLabel = task.source === 'teams' ? '  [Teams]' : (task.source === 'voice' || task.source === 'telegram') ? '  [Voice]' : task.source === 'manual' ? '  [Manual]' : '';
        doc.text(`${taskPrefix}${task.task}${srcLabel}`, 80, y + 16, { width: CW - (80 - M) - 90 });

        // Location if present
        if (task.location) {
          doc.font('Regular').fontSize(10).fillColor(TEXT_SEC);
          doc.text(`📍 ${task.location}`, 80, y + 32, { width: CW - (80 - M) - 20 });
        }

        // Done strikethrough line
        if (task.done) {
          const textWidth = Math.min(doc.widthOfString(task.task), CW - (80 - M) - 90);
          doc.save()
            .moveTo(80, y + 23)
            .lineTo(80 + textWidth, y + 23)
            .lineWidth(1)
            .strokeColor(TEXT_SEC)
            .strokeOpacity(0.4)
            .stroke()
            .restore();
        }

        y += nodeSpacing;
      }

      // Draw the vertical timeline line
      if (nodeYs.length > 1) {
        doc.save().moveTo(lineX, nodeYs[0]).lineTo(lineX, nodeYs[nodeYs.length - 1]).lineWidth(2).strokeColor(ACCENT).stroke().restore();
      } else if (nodeYs.length === 1) {
        doc.save().moveTo(lineX, nodeYs[0] - 8).lineTo(lineX, nodeYs[0] + 8).lineWidth(2).strokeColor(ACCENT).stroke().restore();
      }

      // Draw the timeline nodes
      for (const ny of nodeYs) {
        doc.save().circle(lineX, ny, 6).fill(BG).restore();
        doc.save().circle(lineX, ny, 5).lineWidth(2).strokeColor('#FFFFFF').stroke().restore();
        doc.save().circle(lineX, ny, 4).fill(ACCENT).restore();
      }
    }

    // ── Empty State ──────────────────────────────────
    if (allTasks.length === 0) {
      doc.font('Regular').fontSize(14).fillColor(TEXT_SEC);
      const emptyMsg = lang === 'ru'
        ? 'Задач на эту дату нет.'
        : lang === 'kk'
          ? 'Бұл күнге тапсырмалар жоқ.'
          : 'No tasks for this date.';
      doc.text(emptyMsg, M, y + 40, { width: CW, align: 'center' });
    }

    // ── Footer ──────────────────────────────────────
    const footerY = PAGE_H - M + 10;
    doc.font('Regular').fontSize(8).fillColor(TEXT_SEC);
    doc.text(labels.footer, M, footerY, { width: CW, align: 'center' });

    doc.end();
  });
}

/**
 * Generate a report PDF for any date range directly from SQLite.
 */
export async function generateRangeReportPdf(
  userId: number,
  dateFrom: string,
  dateTo: string,
  lang: string = 'ru',
): Promise<Buffer> {
  const fonts = getFonts();

  const stmt = db.prepare(`
    SELECT DISTINCT * FROM todos
    WHERE user_id = ?
      AND (is_reminder IS NULL OR is_reminder = 0)
      AND substr(COALESCE(scheduled_time_kz, date || 'T' || COALESCE(time, '00:00')), 1, 10) >= ?
      AND substr(COALESCE(scheduled_time_kz, date || 'T' || COALESCE(time, '00:00')), 1, 10) <= ?
    ORDER BY date ASC, time ASC
  `);
  const tasks = stmt.all(userId, dateFrom, dateTo) as TaskRow[];

  const labels = getLabels(lang);
  const pending = tasks.filter(t => !t.done);
  const completed = tasks.filter(t => t.done);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Regular', fonts.regular);
    doc.registerFont('Bold', fonts.bold);

    doc.on('pageAdded', () => drawBg(doc));
    drawBg(doc);

    let y = M;

    const titleText = lang === 'ru' ? 'ОТЧЁТ ПО ЗАДАЧАМ' : lang === 'kk' ? 'ТАПСЫРМАЛАР ЕСЕБІ' : 'TASK REPORT';
    doc.font('Bold').fontSize(28).fillColor(TEXT_PRI);
    doc.text(titleText, M, y, { width: CW });
    y = doc.y + 4;

    doc.font('Regular').fontSize(13).fillColor(TEXT_SEC);
    const rangeLabel = `${dateFrom} — ${dateTo}`;
    doc.text(rangeLabel, M, y, { width: CW });
    y = doc.y + 14;

    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1).strokeColor(BORDER).stroke().restore();
    y += 16;

    // Stats
    doc.font('Bold').fontSize(11).fillColor(ACCENT);
    doc.text(labels.summary.toUpperCase(), M, y, { characterSpacing: 2, width: CW });
    y = doc.y + 8;
    doc.font('Regular').fontSize(12).fillColor(TEXT_PRI);
    doc.text(`Total: ${tasks.length} | Done: ${completed.length} | Pending: ${pending.length}`, M, y);
    y = doc.y + 16;

    // Group tasks by date
    const byDate = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const d = t.date || 'unknown';
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(t);
    }

    for (const [date, dayTasks] of byDate) {
      if (y > MAX_Y - 80) { doc.addPage(); y = M; }

      doc.font('Bold').fontSize(12).fillColor(ACCENT);
      doc.text(formatDateHeader(date, lang), M, y, { width: CW });
      y = doc.y + 6;

      for (const task of dayTasks) {
        if (y > MAX_Y - 30) { doc.addPage(); y = M; }

        drawStatusIcon(doc, !!task.done, M, y);

        if (task.time) {
          doc.font('Bold').fontSize(11).fillColor(TEXT_PRI);
          doc.text(task.time, M + 18, y + 1);
        }

        const pColor = task.priority === 'high' ? PRI_HIGH : task.priority === 'medium' ? PRI_MED : PRI_LOW;
        const pLabel = task.priority.toUpperCase();
        doc.font('Bold').fontSize(8).fillColor(pColor);
        const pWidth = doc.widthOfString(pLabel) + 10;
        doc.save().roundedRect(PAGE_W - M - pWidth, y - 1, pWidth, 14, 3).fillOpacity(0.1).fill(pColor).restore();
        doc.save().roundedRect(PAGE_W - M - pWidth, y - 1, pWidth, 14, 3).lineWidth(1).strokeColor(pColor).strokeOpacity(0.5).stroke().restore();
        doc.text(pLabel, PAGE_W - M - pWidth, y + 2, { width: pWidth, align: 'center' });

        doc.font(task.done ? 'Italic' : 'Regular').fontSize(12).fillColor(task.done ? TEXT_SEC : TEXT_PRI);
        const textX = task.time ? M + 50 : M + 18;
        const taskPrefix = task.has_conflict ? '⚠️ ' : '';
        const srcLabel = task.source === 'teams' ? '  [Teams]' : (task.source === 'voice' || task.source === 'telegram') ? '  [Voice]' : task.source === 'manual' ? '  [Manual]' : '';
        doc.text(`${taskPrefix}${task.task}${srcLabel}`, textX, y + 1, { width: CW - (textX - M) - 80 });

        y += 26;
      }

      y += 10;
    }

    doc.end();
  });
}

/**
 * Get all tasks for a user (unfiltered by date) for "all tasks" report.
 */
export async function generateFullReportPdf(userId: number, lang: string = 'ru'): Promise<Buffer> {
  const fonts = getFonts();
  const tasks = queryAllTasks(userId);
  const labels = getLabels(lang);

  const pending = tasks.filter(t => !t.done);
  const completed = tasks.filter(t => t.done);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Regular', fonts.regular);
    doc.registerFont('Bold', fonts.bold);

    doc.on('pageAdded', () => drawBg(doc));
    drawBg(doc);

    let y = M;

    const titleText = lang === 'ru' ? 'ВСЕ ЗАДАЧИ' : lang === 'kk' ? 'БАРЛЫҚ ТАПСЫРМАЛАР' : 'ALL TASKS';
    doc.font('Bold').fontSize(28).fillColor(TEXT_PRI);
    doc.text(titleText, M, y, { width: CW });
    y = doc.y + 4;

    doc.font('Regular').fontSize(13).fillColor(TEXT_SEC);
    doc.text(formatNow(), M, y, { width: CW });
    y = doc.y + 14;

    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1).strokeColor(BORDER).stroke().restore();
    y += 16;

    doc.font('Bold').fontSize(11).fillColor(ACCENT);
    doc.text(labels.summary.toUpperCase(), M, y, { characterSpacing: 2, width: CW });
    y = doc.y + 8;
    doc.font('Regular').fontSize(12).fillColor(TEXT_PRI);
    doc.text(`Total: ${tasks.length} | Done: ${completed.length} | Pending: ${pending.length}`, M, y);
    y = doc.y + 16;

    // Group by date
    const byDate = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const d = t.date || 'undated';
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(t);
    }

    for (const [date, dayTasks] of byDate) {
      if (y > MAX_Y - 80) { doc.addPage(); y = M; }

      doc.font('Bold').fontSize(12).fillColor(ACCENT);
      doc.text(date === 'undated' ? 'No date' : formatDateHeader(date, lang), M, y, { width: CW });
      y = doc.y + 6;

      for (const task of dayTasks) {
        if (y > MAX_Y - 30) { doc.addPage(); y = M; }

        drawStatusIcon(doc, !!task.done, M, y);

        if (task.time) {
          doc.font('Bold').fontSize(11).fillColor(TEXT_PRI);
          doc.text(task.time, M + 18, y + 1);
        }

        const pColor = task.priority === 'high' ? PRI_HIGH : task.priority === 'medium' ? PRI_MED : PRI_LOW;
        const pLabel = task.priority.toUpperCase();
        doc.font('Bold').fontSize(8).fillColor(pColor);
        const pWidth = doc.widthOfString(pLabel) + 10;
        doc.save().roundedRect(PAGE_W - M - pWidth, y - 1, pWidth, 14, 3).fillOpacity(0.1).fill(pColor).restore();
        doc.save().roundedRect(PAGE_W - M - pWidth, y - 1, pWidth, 14, 3).lineWidth(1).strokeColor(pColor).strokeOpacity(0.5).stroke().restore();
        doc.text(pLabel, PAGE_W - M - pWidth, y + 2, { width: pWidth, align: 'center' });

        doc.font(task.done ? 'Italic' : 'Regular').fontSize(12).fillColor(task.done ? TEXT_SEC : TEXT_PRI);
        const textX = task.time ? M + 50 : M + 18;
        const taskPrefix = task.has_conflict ? '⚠️ ' : '';
        const srcLabel = task.source === 'teams' ? '  [Teams]' : (task.source === 'voice' || task.source === 'telegram') ? '  [Voice]' : task.source === 'manual' ? '  [Manual]' : '';
        doc.text(`${taskPrefix}${task.task}${srcLabel}`, textX, y + 1, { width: CW - (textX - M) - 80 });

        y += 26;
      }

      y += 10;
    }

    doc.end();
  });
}
