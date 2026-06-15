import PDFDocument from 'pdfkit';
import { logger } from '../logger.js';
import { AnalysisResult, TodoItem } from '../types/analysis.js';

const WIDTH = 1200;
const HEIGHT = 800;

function priorityColor(p: string, done: boolean): string {
  if (done) return '#2DD4BF';
  if (p === 'high') return '#F87171';
  if (p === 'medium') return '#FBBF24';
  return '#94A3B8';
}

function parseTime(time?: string): number {
  if (!time) return 9;
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1]) + parseInt(m[2]) / 60 : 9;
}

export async function generateChart(analysis: AnalysisResult): Promise<Buffer> {
  const todos = analysis.todos;
  const sorted = [...todos].sort((a, b) => parseTime(a.time) - parseTime(b.time));

  const doc = new PDFDocument({ size: [WIDTH, HEIGHT], margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      logger.info(`[Chart] Generated PDF chart: ${(buf.byteLength / 1024).toFixed(0)} KB`);
      resolve(buf);
    });
    doc.on('error', reject);

    // ── Background ──
    doc.rect(0, 0, WIDTH, HEIGHT).fill('#0F172A');

    // ── Title ──
    doc.fontSize(18).fillColor('#FFFFFF').text(analysis.title, 40, 40, { width: WIDTH - 80 });

    // ── Subtitle stats ──
    const high = todos.filter(t => t.priority === 'high').length;
    const med = todos.filter(t => t.priority === 'medium').length;
    const low = todos.filter(t => t.priority === 'low').length;
    const done = todos.filter(t => t.done).length;
    doc.fontSize(12).fillColor('#94A3B8').text(`High: ${high}  Medium: ${med}  Low: ${low}  Done: ${done}`, 40, 65, { width: WIDTH - 80 });

    // ── Find time range ──
    const startTimes = sorted.map(t => parseTime(t.time));
    const durations = sorted.map(t => (t.duration || 30) / 60);
    const minTime = Math.max(0, Math.floor(Math.min(...startTimes)) - 1);
    const maxTime = Math.min(24, Math.ceil(Math.max(...startTimes.map((s, i) => s + durations[i]))) + 1);

    // ── Chart area ──
    const chartLeft = 160;
    const chartTop = 110;
    const chartWidth = WIDTH - chartLeft - 60;
    const chartHeight = Math.max(200, sorted.length * 40 + 40);
    const barHeight = 28;
    const barGap = 12;

    // Y-axis labels (tasks)
    sorted.forEach((t, i) => {
      const y = chartTop + i * (barHeight + barGap);
      const timeStr = t.time || '';
      const name = t.task.length > 30 ? t.task.substring(0, 30) + '…' : t.task;
      const label = timeStr ? `${timeStr}  ${name}` : name;
      doc.fontSize(10).fillColor('#E2E8F0').text(label, 40, y + 6, { width: chartLeft - 50, align: 'right' });
    });

    // ── X-axis grid ──
    const hourRange = maxTime - minTime;
    if (hourRange > 0) {
      for (let h = Math.ceil(minTime); h <= Math.floor(maxTime); h++) {
        const x = chartLeft + ((h - minTime) / hourRange) * chartWidth;
        doc.moveTo(x, chartTop).lineTo(x, chartTop + sorted.length * (barHeight + barGap)).strokeColor('rgba(148,163,184,0.15)').stroke();
        doc.fontSize(9).fillColor('#CBD5E1').text(`${h}:00`, x - 10, chartTop + sorted.length * (barHeight + barGap) + 5, { width: 20, align: 'center' });
      }
    }

    // ── Bars ──
    sorted.forEach((t, i) => {
      const y = chartTop + i * (barHeight + barGap);
      const start = parseTime(t.time);
      const dur = (t.duration || 30) / 60;
      if (hourRange > 0 && dur > 0) {
        const x = chartLeft + ((start - minTime) / hourRange) * chartWidth;
        const w = (dur / hourRange) * chartWidth;
        const color = priorityColor(t.priority, t.done);
        doc.roundedRect(x, y, Math.max(w, 4), barHeight, 6).fill(color);
        // Task name inside bar if wide enough
        if (w > 60) {
          doc.fontSize(8).fillColor('#FFFFFF').text(t.task.length > 20 ? t.task.substring(0, 20) + '…' : t.task, x + 4, y + 8, { width: w - 8 });
        }
      }
    });

    // ── Empty state ──
    if (sorted.length === 0) {
      doc.fontSize(16).fillColor('#94A3B8').text('No tasks', 40, chartTop + 40);
    }

    doc.end();
  });
}
