import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  Footer,
  Header,
} from 'docx';
import { AnalysisResult } from '../types/analysis.js';

// Color constants
const DARK_BLUE = '1F3864';
const RED = 'CC0000';
const ORANGE = 'E67E22';
const GRAY = '808080';
const LIGHT_GRAY = '999999';
const WHITE = 'FFFFFF';
const HEADER_BG = 'D6E4F0';

/**
 * Create a styled section heading paragraph.
 */
function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: true,
        size: 28,  // 14pt
        color: DARK_BLUE,
        font: 'Calibri',
      }),
    ],
    spacing: { before: 400, after: 200 },
  });
}

/**
 * Format date in Russian locale.
 */
function formatDate(date: Date): string {
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day} ${month} ${year} г., ${hours}:${minutes}`;
}

/**
 * Get priority color for TODO items.
 */
function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'high': return RED;
    case 'medium': return ORANGE;
    case 'low': return GRAY;
    default: return GRAY;
  }
}

/**
 * Get priority label in Russian.
 */
function getPriorityLabel(priority: string): string {
  switch (priority) {
    case 'high': return 'Высокий';
    case 'medium': return 'Средний';
    case 'low': return 'Низкий';
    default: return priority;
  }
}

/**
 * Create a table cell with consistent styling.
 */
function styledCell(text: string, options?: { bold?: boolean; color?: string; bgColor?: string }): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: options?.bold || false,
            color: options?.color || '000000',
            size: 22, // 11pt
            font: 'Calibri',
          }),
        ],
        spacing: { before: 60, after: 60 },
      }),
    ],
    shading: options?.bgColor ? { fill: options.bgColor, type: 'clear' as any, color: 'auto' } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}

/**
 * Generate a professionally styled .docx document from the analysis result.
 */
export async function generateDocx(analysis: AnalysisResult): Promise<Buffer> {
  const now = new Date();
  const dateStr = formatDate(now);
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: 'Calibri',
            size: 22, // 11pt
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,    // 1 inch
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: `Создано голосовым ботом • ${dateStr}`,
                    size: 16,    // 8pt
                    color: LIGHT_GRAY,
                    font: 'Calibri',
                    italics: true,
                  }),
                ],
              }),
            ],
          }),
        },
        children: [
          // ── Title ──────────────────────────────────────────
          new Paragraph({
            children: [
              new TextRun({
                text: analysis.title,
                bold: true,
                size: 36,  // 18pt
                color: DARK_BLUE,
                font: 'Calibri',
              }),
            ],
            spacing: { after: 100 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: dateStr,
                italics: true,
                size: 20,  // 10pt
                color: LIGHT_GRAY,
                font: 'Calibri',
              }),
            ],
            spacing: { after: 400 },
          }),

          // ── Summary ────────────────────────────────────────
          sectionHeading('📋 Краткое содержание'),
          new Paragraph({
            children: [
              new TextRun({
                text: analysis.summary,
                size: 22,
                font: 'Calibri',
              }),
            ],
            spacing: { before: 100, after: 400 },
          }),

          // ── Key Points ─────────────────────────────────────
          sectionHeading('🔑 Ключевые моменты'),
          ...analysis.key_points.map(
            (point) =>
              new Paragraph({
                children: [
                  new TextRun({
                    text: point,
                    size: 22,
                    font: 'Calibri',
                  }),
                ],
                bullet: { level: 0 },
                spacing: { before: 80, after: 80 },
              })
          ),

          // ── TODOs ──────────────────────────────────────────
          sectionHeading('✅ Задачи (TODO)'),
          ...(analysis.todos.length > 0
            ? [
                new Table({
                  width: { size: 100, type: WidthType.PERCENTAGE },
                  rows: [
                    // Header row
                    new TableRow({
                      children: [
                        styledCell('Задача', { bold: true, bgColor: HEADER_BG }),
                        styledCell('Приоритет', { bold: true, bgColor: HEADER_BG }),
                        styledCell('Статус', { bold: true, bgColor: HEADER_BG }),
                      ],
                    }),
                    // Data rows
                    ...analysis.todos.map((todo) =>
                      new TableRow({
                        children: [
                          styledCell(todo.task),
                          styledCell(getPriorityLabel(todo.priority), {
                            color: getPriorityColor(todo.priority),
                            bold: true,
                          }),
                          styledCell(todo.done ? '☑ Готово' : '☐ Нужно сделать'),
                        ],
                      })
                    ),
                  ],
                }),
              ]
            : [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: 'Задач не обнаружено.',
                      italics: true,
                      color: GRAY,
                      size: 22,
                      font: 'Calibri',
                    }),
                  ],
                  spacing: { before: 100 },
                }),
              ]),

          // Spacer
          new Paragraph({ text: '', spacing: { after: 200 } }),

          // ── Tags ───────────────────────────────────────────
          sectionHeading('🏷 Теги'),
          new Paragraph({
            children: [
              new TextRun({
                text: analysis.tags.length > 0 ? analysis.tags.join('  ') : 'Теги не определены',
                size: 22,
                color: analysis.tags.length > 0 ? DARK_BLUE : GRAY,
                font: 'Calibri',
                italics: analysis.tags.length === 0,
              }),
            ],
            spacing: { before: 100, after: 400 },
          }),

          // ── Raw Transcript ─────────────────────────────────
          sectionHeading('📝 Полная транскрипция'),
          new Paragraph({
            children: [
              new TextRun({
                text: analysis.raw_transcript,
                size: 18,     // 9pt — smaller gray font
                color: '666666',
                font: 'Calibri',
              }),
            ],
            spacing: { before: 200, after: 200 },
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  console.log(`[DOCX] Generated document: ${(buffer.byteLength / 1024).toFixed(1)} KB`);
  return buffer as Buffer;
}
