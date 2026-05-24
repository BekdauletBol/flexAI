import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { AnalysisResult, TodoItem } from '../types/analysis.js';

const WIDTH = 1200;
const HEIGHT = 800;

const chartCanvas = new ChartJSNodeCanvas({ width: WIDTH, height: HEIGHT, backgroundColour: '#0F172A' });

function priorityColor(p: string, done: boolean): string {
  if (done) return '#2DD4BF';
  if (p === 'high') return '#F87171';
  if (p === 'medium') return '#FBBF24';
  return '#94A3B8';
}

function parseTime(time?: string): number {
  if (!time) return 9; // default 9:00
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1]) + parseInt(m[2]) / 60 : 9;
}

export async function generateChart(analysis: AnalysisResult): Promise<Buffer> {
  const todos = analysis.todos;
  if (todos.length === 0) {
    // Return a minimal "no tasks" image
    return chartCanvas.renderToBuffer({
      type: 'bar',
      data: { labels: ['No tasks'], datasets: [{ data: [0], backgroundColor: '#1E293B' }] },
      options: { plugins: { title: { display: true, text: analysis.title, color: '#FFF', font: { size: 20 } } } },
    });
  }

  // Sort by time
  const sorted = [...todos].sort((a, b) => parseTime(a.time) - parseTime(b.time));

  // ── Gantt-style horizontal bar chart data ──
  const labels = sorted.map(t => {
    const timeStr = t.time || '';
    const name = t.task.length > 30 ? t.task.substring(0, 30) + '…' : t.task;
    return timeStr ? `${timeStr}  ${name}` : name;
  });

  const startTimes = sorted.map(t => parseTime(t.time));
  const durations = sorted.map(t => (t.duration || 30) / 60);
  const colors = sorted.map(t => priorityColor(t.priority, t.done));

  // Find time range
  const minTime = Math.max(0, Math.floor(Math.min(...startTimes)) - 1);
  const maxTime = Math.min(24, Math.ceil(Math.max(...startTimes.map((s, i) => s + durations[i]))) + 1);

  // Priority counts for donut
  const high = todos.filter(t => t.priority === 'high').length;
  const med = todos.filter(t => t.priority === 'medium').length;
  const low = todos.filter(t => t.priority === 'low').length;
  const done = todos.filter(t => t.done).length;

  const config: any = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Start',
          data: startTimes,
          backgroundColor: 'transparent',
          borderWidth: 0,
          barPercentage: 0.6,
        },
        {
          label: 'Duration',
          data: durations,
          backgroundColor: colors,
          borderWidth: 0,
          borderRadius: 6,
          barPercentage: 0.6,
        },
      ],
    },
    options: {
      indexAxis: 'y' as const,
      responsive: false,
      scales: {
        x: {
          stacked: true,
          min: minTime,
          max: maxTime,
          title: { display: true, text: 'Time of Day', color: '#94A3B8', font: { size: 12 } },
          ticks: {
            color: '#CBD5E1',
            stepSize: 1,
            callback: (v: number) => `${Math.floor(v)}:${((v % 1) * 60).toString().padStart(2, '0')}`,
          },
          grid: { color: 'rgba(148,163,184,0.1)' },
        },
        y: {
          stacked: true,
          ticks: { color: '#E2E8F0', font: { size: 11 } },
          grid: { display: false },
        },
      },
      plugins: {
        title: {
          display: true,
          text: `📋 ${analysis.title}`,
          color: '#FFFFFF',
          font: { size: 18, weight: 'bold' as const },
          padding: { bottom: 20 },
        },
        subtitle: {
          display: true,
          text: `🔴 High: ${high}  🟡 Medium: ${med}  ⚪ Low: ${low}  ✅ Done: ${done}`,
          color: '#94A3B8',
          font: { size: 12 },
          padding: { bottom: 10 },
        },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: any) => {
              if (ctx.datasetIndex === 0) return '';
              const todo = sorted[ctx.dataIndex];
              return `${todo.task} (${todo.priority}) — ${todo.duration || 30} min`;
            },
          },
        },
      },
    },
  };

  const buffer = await chartCanvas.renderToBuffer(config);
  console.log(`[Chart] Generated: ${(buffer.byteLength / 1024).toFixed(0)} KB`);
  return buffer;
}
