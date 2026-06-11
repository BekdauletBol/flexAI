import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { AnalysisResult } from '../types/analysis.js';
import { getLabels } from '../types/i18n.js';

const ROOT = path.resolve(process.cwd());
const BG_PATH = path.join(ROOT, 'assets', 'background.png');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');

function getFonts(lang: string) {
  if (lang === 'en') {
    return {
      regular: path.join(FONT_DIR, 'PublicSans-Regular.ttf'),
      bold: path.join(FONT_DIR, 'PublicSans-Bold.ttf'),
      italic: path.join(FONT_DIR, 'PublicSans-Italic.ttf'),
    };
  }
  return {
    regular: path.join(FONT_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(FONT_DIR, 'Roboto-Bold.ttf'),
    italic: path.join(FONT_DIR, 'Roboto-Italic.ttf'),
  };
}

// ── Brighter colors ──────────────────────────────────────
const WHITE = '#FFFFFF';
const SNOW = '#F8FAFC';       // bright body text
const LIGHT_GRAY = '#CBD5E1'; // secondary text — much brighter than before
const MUTED = '#94A3B8';
const TEAL = '#5EEAD4';       // brighter teal for better contrast
const SKY = '#38BDF8';
const OVERLAY_BG = '#0F172A';
const RED = '#F87171';        // brighter red
const AMBER = '#FBBF24';      // brighter amber
const SLATE = '#E2E8F0';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50;
const CW = PAGE_W - M * 2;
const MAX_Y = PAGE_H - 40; // absolute bottom limit — single page

function fmtDate(d: Date): string {
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${mo[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

function drawBg(doc: PDFKit.PDFDocument) {
  if (fs.existsSync(BG_PATH)) {
    doc.image(BG_PATH, 0, 0, { width: PAGE_W, height: PAGE_H });
  }
  // Lighter overlay so background shows through more
  doc.save();
  doc.rect(0, 0, PAGE_W, PAGE_H).fillOpacity(0.72).fill(OVERLAY_BG);
  doc.restore();
  doc.fillOpacity(1);
}

/** Draw the blue glow timeline graph. */
function drawTimeline(doc: PDFKit.PDFDocument, tasks: string[], startY: number, maxY: number): number {
  if (tasks.length === 0) return startY;

  const leftX = M + 30;
  const lineLen = CW - 60;
  const rowH = 32;
  const dotR = 5;

  const points: { x: number; y: number }[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const y = startY + i * rowH;
    if (y > maxY) break;

    // Track line
    doc.save();
    doc.moveTo(leftX, y).lineTo(leftX + lineLen, y);
    doc.strokeOpacity(0.2).lineWidth(1).strokeColor(LIGHT_GRAY).stroke();
    doc.restore();

    const progress = tasks.length > 1 ? i / (tasks.length - 1) : 0.5;
    const dotX = leftX + lineLen * (0.12 + progress * 0.76);
    points.push({ x: dotX, y });

    // Track dots
    for (let d = 0; d < 4; d++) {
      const dx = leftX + lineLen * ((d + 1) / 5);
      doc.save().circle(dx, y, 1.8).fillOpacity(0.25).fill(LIGHT_GRAY).restore();
    }

    // Task label — brighter text
    doc.save();
    doc.font('Bold').fontSize(7.5).fillColor(SNOW).fillOpacity(0.85);
    doc.text(tasks[i].substring(0, 25), M - 8, y - 4, { width: 38, align: 'right' });
    doc.restore();
    doc.fillOpacity(1);
  }

  // Blue glow path
  if (points.length >= 2) {
    for (let layer = 4; layer >= 0; layer--) {
      doc.save();
      const w = 6 + layer * 8;
      const op = layer === 0 ? 0.7 : 0.04 + (4 - layer) * 0.02;
      doc.lineWidth(w).strokeColor(SKY).strokeOpacity(op);
      doc.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1], curr = points[i];
        const midY = (prev.y + curr.y) / 2;
        doc.bezierCurveTo(prev.x, midY, curr.x, midY, curr.x, curr.y);
      }
      doc.stroke();
      doc.restore();
    }
  }

  // Dots
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    doc.save().circle(p.x, p.y, 12).fillOpacity(0.1).fill(SKY).restore();
    doc.save().circle(p.x, p.y, dotR).fillOpacity(1).fill(i === 0 ? '#FB923C' : '#1E293B').restore();
    if (i === 0) { doc.save().circle(p.x, p.y, 2.5).fillOpacity(0.6).fill(WHITE).restore(); }
  }

  doc.fillOpacity(1);
  return startY + Math.min(tasks.length, Math.floor((maxY - startY) / rowH)) * rowH + 8;
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

    drawBg(doc);

    let y = M;

    // ── Title ────────────────────────────────────────
    doc.font('Bold').fontSize(22).fillColor(WHITE);
    doc.text(analysis.title, M, y, { width: CW });
    y = doc.y + 3;

    doc.font('Regular').fontSize(8.5).fillColor(LIGHT_GRAY);
    doc.text(fmtDate(now), M, y, { width: CW });
    y = doc.y + 10;

    // Teal accent line
    doc.save().moveTo(M, y).lineTo(M + 50, y).lineWidth(2).strokeColor(TEAL).stroke().restore();
    y += 14;

    // ── Summary ──────────────────────────────────────
    doc.font('Bold').fontSize(7.5).fillColor(TEAL);
    doc.text(labels.summary, M, y, { characterSpacing: 2, width: CW });
    y = doc.y + 4;
    doc.font('Regular').fontSize(9.5).fillColor(SNOW);
    doc.text(analysis.summary, M, y, { width: CW, lineGap: 2 });
    y = doc.y + 12;

    // ── Key Points ───────────────────────────────────
    doc.font('Bold').fontSize(7.5).fillColor(TEAL);
    doc.text(labels.keyPoints, M, y, { characterSpacing: 2, width: CW });
    y = doc.y + 4;

    for (const pt of analysis.key_points) {
      if (y > MAX_Y - 200) break; // Reserve space for rest
      doc.font('Regular').fontSize(9).fillColor(TEAL);
      doc.text('▸ ', M + 4, y, { continued: true, width: CW - 4 });
      doc.fillColor(SNOW).text(pt, { lineGap: 1 });
      y = doc.y + 2;
    }
    y += 10;

    // ── Task Timeline Graph ──────────────────────────
    if (analysis.todos.length > 0 && y < MAX_Y - 180) {
      doc.font('Bold').fontSize(7.5).fillColor(TEAL);
      doc.text(labels.tasks + ' TIMELINE', M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 8;

      const taskNames = analysis.todos.map(t => {
        const tag = t.time ? ` ${t.time}` : '';
        const name = t.task.length > 20 ? t.task.substring(0, 20) + '…' : t.task;
        return name + tag;
      });

      const timelineMaxY = Math.min(y + analysis.todos.length * 32 + 10, MAX_Y - 120);
      y = drawTimeline(doc, taskNames, y, timelineMaxY);
    }

    // ── Tasks List (compact) ─────────────────────────
    if (analysis.todos.length > 0 && y < MAX_Y - 80) {
      doc.font('Bold').fontSize(7.5).fillColor(TEAL);
      doc.text(labels.tasks, M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 6;

      for (const todo of analysis.todos) {
        if (y > MAX_Y - 60) break;

        const pColor = todo.priority === 'high' ? RED : todo.priority === 'medium' ? AMBER : SLATE;
        const pLabel = todo.priority === 'high' ? labels.high : todo.priority === 'medium' ? labels.medium : labels.low;
        const timeStr = todo.time ? `  · ${todo.time}` : '';

        doc.save().rect(M, y - 1, CW, 18).fillOpacity(0.08).fill(WHITE).restore();
        doc.fillOpacity(1);

        doc.font('Regular').fontSize(9).fillColor(todo.done ? TEAL : LIGHT_GRAY);
        doc.text(todo.done ? '✓' : '○', M + 6, y + 1, { width: 14 });

        doc.font('Regular').fontSize(9).fillColor(WHITE);
        doc.text(todo.task + timeStr, M + 22, y + 1, { width: CW * 0.65 });

        doc.font('Bold').fontSize(7).fillColor(pColor);
        doc.text(pLabel, M + CW - 50, y + 2, { width: 50, align: 'right' });

        y = Math.max(doc.y + 2, y + 20);
      }
      y += 8;
    }

    // ── Tags ─────────────────────────────────────────
    if (y < MAX_Y - 40) {
      doc.font('Bold').fontSize(7.5).fillColor(TEAL);
      doc.text(labels.tags, M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 4;
      doc.font('Regular').fontSize(8.5).fillColor(TEAL);
      doc.text(analysis.tags.length > 0 ? analysis.tags.join('   ') : '—', M + 4, y, { width: CW });
      y = doc.y + 10;
    }

    // ── Transcript (truncated to fit single page) ────
    if (y < MAX_Y - 30) {
      doc.save().moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.3).strokeOpacity(0.25).strokeColor(TEAL).stroke().restore();
      y += 10;

      doc.font('Bold').fontSize(7.5).fillColor(TEAL);
      doc.text(labels.transcript, M, y, { characterSpacing: 2, width: CW });
      y = doc.y + 4;

      // Hard cap: calculate exact space left for transcript text
      const spaceLeft = MAX_Y - y - 4;
      if (spaceLeft > 12) {
        const charsPerLine = 85;
        const lineH = 10;
        const maxLines = Math.max(1, Math.floor(spaceLeft / lineH));
        const maxChars = maxLines * charsPerLine;
        const truncated = analysis.raw_transcript.length > maxChars
          ? analysis.raw_transcript.substring(0, maxChars) + '…'
          : analysis.raw_transcript;

        doc.font('Italic').fontSize(7.5).fillColor(LIGHT_GRAY);
        doc.text(truncated, M + 4, y, { width: CW - 4, lineGap: 2, height: spaceLeft });
      }
    }

    // No footer — prevents PDFKit from auto-creating page 2

    doc.end();
  });
}
