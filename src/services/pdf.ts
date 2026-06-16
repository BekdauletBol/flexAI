import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { AnalysisResult, TodoItem } from '../types/analysis.js';
import { getLabels } from '../types/i18n.js';

const ROOT = path.resolve(process.cwd());
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');

function getFonts(_lang: string) {
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
// MAX_Y must be ABOVE the bottom margin (PAGE_H - M) to prevent auto page-breaks
const MAX_Y = PAGE_H - M - 10;

function fmtDate(d: Date): string {
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${mo[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

function formatDate(dateStr: string, lang: string): string {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString(
    lang === 'ru' ? 'ru-RU' : 'en-US',
    { day: 'numeric', month: 'long' }
  );
}

function drawBg(doc: PDFKit.PDFDocument) {
  doc.save().rect(0, 0, PAGE_W, PAGE_H).fill(BG).restore();
}

export async function generatePdf(analysis: AnalysisResult): Promise<Buffer> {
  const labels = getLabels(analysis.language);
  const fonts = getFonts(analysis.language);
  const now = new Date();

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
    doc.font('Bold').fontSize(28).fillColor(TEXT_PRI);
    doc.text(analysis.title, M, y, { width: CW });
    y = doc.y + 4;

    doc.font('Regular').fontSize(13).fillColor(TEXT_SEC);
    doc.text(fmtDate(now), M, y, { width: CW });
    y = doc.y + 14;

    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1).strokeColor(BORDER).stroke().restore();
    y += 16;

    // ── Summary ──────────────────────────────────────
    doc.font('Bold').fontSize(11).fillColor(ACCENT);
    doc.text(labels.summary.toUpperCase(), M, y, { characterSpacing: 2, width: CW });
    y = doc.y + 6;

    doc.font('Regular').fontSize(13).fillColor(TEXT_SEC);
    doc.text(analysis.summary, M, y, { width: CW, lineGap: 6 });
    y = doc.y + 16;

    // ── Timeline ─────────────────────────────────────
    const timedTasks = analysis.todos.filter(t => t.time).sort((a, b) => a.time!.localeCompare(b.time!));
    if (timedTasks.length > 0) {
      const lineX = 60;
      const nodeYs: number[] = [];
      const nodeSpacing = 60;
      const pageBottom = PAGE_H - M;
      let currentY = y + 20;

      for (const t of timedTasks) {
        if (currentY > pageBottom - nodeSpacing) {
          doc.addPage();
          currentY = M + 20;
          nodeYs.length = 0;
        }

        nodeYs.push(currentY);

        // Time text at (85, currentY - 6)
        doc.font('Bold').fontSize(13).fillColor(TEXT_PRI);
        doc.text(t.time!, 85, currentY - 6);

        // Priority pill (right-aligned)
        const pColor = t.priority === 'high' ? PRI_HIGH : t.priority === 'medium' ? PRI_MED : PRI_LOW;
        const pLabel = t.priority.toUpperCase();
        doc.font('Bold').fontSize(9).fillColor(pColor);
        const pWidth = doc.widthOfString(pLabel) + 12;
        const pX = PAGE_W - M - pWidth;

        doc.save().roundedRect(pX, currentY - 6, pWidth, 16, 4).fillOpacity(0.1).fill(pColor).restore();
        doc.save().roundedRect(pX, currentY - 6, pWidth, 16, 4).lineWidth(1).strokeColor(pColor).strokeOpacity(0.5).stroke().restore();
        doc.text(pLabel, pX, currentY - 2, { width: pWidth, align: 'center' });

        // Task name at (85, currentY + 10)
        doc.font('Regular').fontSize(14).fillColor(TEXT_PRI);
        doc.text(t.task, 85, currentY + 10, { width: CW - (85 - M) - 80 });

        currentY += nodeSpacing;
      }

      // Draw the vertical line from first to last node Y
      if (nodeYs.length > 1) {
        doc.save().moveTo(lineX, nodeYs[0]).lineTo(lineX, nodeYs[nodeYs.length - 1]).lineWidth(2).strokeColor(ACCENT).stroke().restore();
      } else if (nodeYs.length === 1) {
        doc.save().moveTo(lineX, nodeYs[0] - 8).lineTo(lineX, nodeYs[0] + 8).lineWidth(2).strokeColor(ACCENT).stroke().restore();
      }

      // Draw the nodes
      for (const ny of nodeYs) {
        doc.save().circle(lineX, ny, 6).fill(BG).restore();
        doc.save().circle(lineX, ny, 5).lineWidth(2).strokeColor('#FFFFFF').stroke().restore();
        doc.save().circle(lineX, ny, 4).fill(ACCENT).restore();
      }

      y = currentY + 10;
    }

    // ── No Time Set ──────────────────────────────────
    const untimedTasks = analysis.todos.filter(t => !t.time);
    if (untimedTasks.length > 0) {
      if (y > MAX_Y - 60) { doc.addPage(); y = M; }

      doc.font('Bold').fontSize(11).fillColor(ACCENT);
      doc.text('NO TIME SET', M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 8;

      for (const t of untimedTasks) {
        if (y > MAX_Y - 20) { doc.addPage(); y = M; }
        
        doc.font('Regular').fontSize(14).fillColor(TEXT_PRI);
        doc.text(t.task, M, y, { width: CW });
        y = doc.y + 6;
      }
      y += 10;
    }

    // ── Tags ─────────────────────────────────────────
    if (analysis.tags && analysis.tags.length > 0) {
      if (y > MAX_Y - 40) { doc.addPage(); y = M; }
      
      doc.font('Bold').fontSize(11).fillColor(ACCENT);
      doc.text('TAGS', M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 8;

      let tx = M;
      doc.font('Regular').fontSize(12).fillColor(ACCENT);
      for (const tag of analysis.tags) {
        const tw = doc.widthOfString(tag) + 16;
        if (tx + tw > PAGE_W - M) { tx = M; y += 24; }
        if (y > MAX_Y - 20) { doc.addPage(); y = M; tx = M; }
        
        doc.save().roundedRect(tx, y, tw, 20, 4).fill(CARD_BG).restore();
        doc.save().roundedRect(tx, y, tw, 20, 4).lineWidth(1).strokeColor(BORDER).stroke().restore();
        doc.text(tag, tx, y + 5, { width: tw, align: 'center' });
        
        tx += tw + 8;
      }
      y += 30;
    }

    // ── Transcript ───────────────────────────────────
    if (y < MAX_Y - 30 && analysis.raw_transcript) {
      doc.font('Bold').fontSize(11).fillColor(ACCENT);
      doc.text('FULL TRANSCRIPT', M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 6;

      const spaceLeft = MAX_Y - y;
      if (spaceLeft > 12) {
        doc.font('Italic').fontSize(11).fillColor(TEXT_SEC);
        
        const charsPerLine = 100;
        const lineH = 14;
        const maxLines = Math.max(1, Math.floor(spaceLeft / lineH));
        const maxChars = maxLines * charsPerLine;
        const truncated = analysis.raw_transcript.length > maxChars
          ? analysis.raw_transcript.substring(0, maxChars) + '…'
          : analysis.raw_transcript;

        doc.text(truncated, M, y, { width: CW, lineGap: 3, height: spaceLeft });
      }
    }

    doc.end();
  });
}

export async function generateReportPdf(tasks: TodoItem[], language: string): Promise<Buffer> {
  const fonts = getFonts(language);
  const now = new Date();
  const isRu = language === 'ru';
  const isKk = language === 'kk';

  const titleText = isRu ? 'ОТЧЕТ ПО ЗАДАЧАМ' : isKk ? 'ТАПСЫРМАЛАР ЕСЕБІ' : 'TASK REPORT';
  const pendingLabel = isRu ? 'В ОЖИДАНИИ' : isKk ? 'КҮТУДЕ' : 'PENDING';
  const completedLabel = isRu ? 'ВЫПОЛНЕНО' : isKk ? 'ОРЫНДАЛДЫ' : 'COMPLETED';
  const statsLabel = isRu ? 'Статистика' : isKk ? 'Статистика' : 'Stats';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Regular', fonts.regular);
    doc.registerFont('Bold', fonts.bold);

    doc.on('pageAdded', () => drawBg(doc));
    drawBg(doc);

    let y = M;

    // Title
    doc.font('Bold').fontSize(28).fillColor(TEXT_PRI);
    doc.text(titleText, M, y, { width: CW });
    y = doc.y + 4;

    doc.font('Regular').fontSize(13).fillColor(TEXT_SEC);
    doc.text(fmtDate(now), M, y, { width: CW });
    y = doc.y + 14;

    // Accent line
    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1).strokeColor(BORDER).stroke().restore();
    y += 16;

    const pending = tasks.filter(t => !t.done);
    const completed = tasks.filter(t => t.done);

    function drawTaskTable(label: string, items: TodoItem[], startY: number): number {
      if (items.length === 0) return startY;

      doc.font('Bold').fontSize(11).fillColor(ACCENT);
      doc.text(label, M, startY, { characterSpacing: 2, width: CW });
      let yy = doc.y + 8;

      for (const todo of items) {
        if (yy > MAX_Y - 40) {
          doc.addPage();
          yy = M;
        }

        const pColor = todo.priority === 'high' ? PRI_HIGH : todo.priority === 'medium' ? PRI_MED : PRI_LOW;
        const priorityStr = todo.priority === 'high' ? (isRu ? 'ВЫСОКИЙ' : isKk ? 'ЖОҒАРЫ' : 'HIGH')
                         : todo.priority === 'medium' ? (isRu ? 'СРЕДНИЙ' : isKk ? 'ОРТА' : 'MEDIUM')
                         : (isRu ? 'НИЗКИЙ' : isKk ? 'ТӨМЕН' : 'LOW');
        const timeStr = todo.time ? `  ${todo.time}` : '';
        const locationStr = todo.location ? `  ${todo.location}` : '';
        const dateStr = todo.date ? `  ${formatDate(todo.date, language)}` : '';

        // Row background
        doc.save().roundedRect(M, yy - 1, CW, 22, 4).fillOpacity(1).fill(CARD_BG).restore();
        doc.save().roundedRect(M, yy - 1, CW, 22, 4).lineWidth(1).strokeColor(BORDER).stroke().restore();

        // Task name + metadata
        doc.font('Regular').fontSize(12).fillColor(TEXT_PRI);
        const meta = `${todo.task}${timeStr}${locationStr}${dateStr}`;
        doc.text(meta, M + 8, yy + 3, { width: CW * 0.65 });

        // Priority badge
        doc.font('Bold').fontSize(9).fillColor(pColor);
        doc.text(priorityStr, M + CW - 80, yy + 4, { width: 70, align: 'right' });

        yy += 28;
      }

      return yy + 8;
    }

    y = drawTaskTable(pendingLabel, pending, y);
    y = drawTaskTable(completedLabel, completed, y);

    // Stats section
    if (y > MAX_Y - 40) { doc.addPage(); y = M; }

    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1).strokeColor(BORDER).stroke().restore();
    y += 12;

    doc.font('Bold').fontSize(11).fillColor(ACCENT);
    doc.text(statsLabel.toUpperCase(), M, y, { characterSpacing: 2, width: CW });
    y = doc.y + 6;

    doc.font('Regular').fontSize(12).fillColor(TEXT_SEC);
    const total = tasks.length;
    const doneCount = completed.length;
    const statsText = isRu
      ? `Всего: ${total}  |  Выполнено: ${doneCount}  |  Осталось: ${total - doneCount}`
      : isKk
      ? `Барлығы: ${total}  |  Орындалды: ${doneCount}  |  Қалды: ${total - doneCount}`
      : `Total: ${total}  |  Completed: ${doneCount}  |  Remaining: ${total - doneCount}`;
    doc.text(statsText, M, y, { width: CW });

    doc.end();
  });
}

export async function generateMultiDateReportPdf(
  sections: { label: string; tasks: TodoItem[] }[],
  language: string
): Promise<Buffer> {
  const fonts = getFonts(language);
  const now = new Date();
  const isRu = language === 'ru';
  const isKk = language === 'kk';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Regular', fonts.regular);
    doc.registerFont('Bold', fonts.bold);

    doc.on('pageAdded', () => drawBg(doc));
    drawBg(doc);

    let y = M;

    const titleText = isRu ? 'ОТЧЕТ ПО ЗАДАЧАМ' : isKk ? 'ТАПСЫРМАЛАР ЕСЕБІ' : 'TASK REPORT';
    doc.font('Bold').fontSize(28).fillColor(TEXT_PRI);
    doc.text(titleText, M, y, { width: CW });
    y = doc.y + 4;

    doc.font('Regular').fontSize(13).fillColor(TEXT_SEC);
    doc.text(fmtDate(now), M, y, { width: CW });
    y = doc.y + 14;

    doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1).strokeColor(BORDER).stroke().restore();
    y += 16;

    for (const section of sections) {
      if (section.tasks.length === 0) continue;

      if (y > MAX_Y - 60) { doc.addPage(); y = M; }

      // Section header
      doc.font('Bold').fontSize(14).fillColor(ACCENT);
      doc.text(section.label, M, y, { width: CW });
      y = doc.y + 8;

      doc.font('Regular').fontSize(12).fillColor(TEXT_SEC);
      const countLabel = isRu ? `задач: ${section.tasks.length}`
        : isKk ? `тапсырма: ${section.tasks.length}`
        : `tasks: ${section.tasks.length}`;
      doc.text(countLabel, M, y, { width: CW });
      y = doc.y + 10;

      for (const todo of section.tasks) {
        if (y > MAX_Y - 30) { doc.addPage(); y = M; }

        const pColor = todo.priority === 'high' ? PRI_HIGH : todo.priority === 'medium' ? PRI_MED : PRI_LOW;
        const priorityStr = todo.priority === 'high' ? (isRu ? 'ВЫСОКИЙ' : isKk ? 'ЖОҒАРЫ' : 'HIGH')
          : todo.priority === 'medium' ? (isRu ? 'СРЕДНИЙ' : isKk ? 'ОРТА' : 'MEDIUM')
          : (isRu ? 'НИЗКИЙ' : isKk ? 'ТӨМЕН' : 'LOW');
        const timeStr = todo.time ? `  ${todo.time}` : '';
        const locationStr = todo.location ? `  ${todo.location}` : '';
        const dateStr = todo.date ? `  ${formatDate(todo.date, language)}` : '';

        doc.save().roundedRect(M, y, CW, 22, 4).fill(CARD_BG).restore();
        doc.save().roundedRect(M, y, CW, 22, 4).lineWidth(1).strokeColor(BORDER).stroke().restore();

        doc.font('Regular').fontSize(12).fillColor(TEXT_PRI);
        const meta = `${todo.task}${timeStr}${locationStr}${dateStr}`;
        doc.text(meta, M + 8, y + 3, { width: CW * 0.65 });

        doc.font('Bold').fontSize(9).fillColor(pColor);
        doc.text(priorityStr, M + CW - 80, y + 4, { width: 70, align: 'right' });

        y += 28;
      }

      y += 12;
    }

    doc.end();
  });
}
