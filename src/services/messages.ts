import { InlineKeyboard } from 'grammy';
import { TodoItem, AnalysisResult } from '../types/analysis.js';
import { Conflict } from './planStore.js';

const SEP = '———————————————';

function formatPriority(p: string): string {
  if (p === 'high') return 'High';
  if (p === 'medium') return 'Medium';
  return 'Low';
}

export function buildSummaryMessage(
  title: string,
  summary: string,
  todos: TodoItem[],
  tags: string[],
  language: string,
  recordedAt: Date
): string {
  const time = recordedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  const lines: string[] = [];

  if (language === 'ru') lines.push('СВОДКА');
  else if (language === 'kk') lines.push('ҚЫСҚАША');
  else lines.push('SUMMARY');

  lines.push('');
  lines.push(title);

  if (language === 'ru') lines.push(`Записано в ${time}.`);
  else if (language === 'kk') lines.push(`${time} сағатта жазылды.`);
  else lines.push(`Note recorded at ${time}.`);

  if (todos.length > 0) {
    lines.push('');
    lines.push(SEP);
    lines.push('');

    if (language === 'ru') lines.push('ЗАДАЧИ');
    else if (language === 'kk') lines.push('ТАПСЫРМАЛАР');
    else lines.push('TASKS');

    lines.push('');

    for (const t of todos) {
      let line = `— ${t.task} · ${formatPriority(t.priority)}`;
      if (t.time) line += ` · ${t.time}`;
      if (t.location) line += ` · ${t.location}`;
      lines.push(line);
    }
  }

  if (tags.length > 0) {
    lines.push('');
    lines.push(SEP);
    lines.push('');
    lines.push(tags.join(' '));
  }

  return lines.join('\n');
}

export function buildConflictMessage(
  conflicts: Conflict[],
  language: string
): string {
  const lines: string[] = [];

  if (language === 'ru') {
    lines.push('КОНФЛИКТ');
    lines.push('');
    lines.push('У вас уже запланировано на это время:');
  } else if (language === 'kk') {
    lines.push('ҚАЙШЫЛЫҚ');
    lines.push('');
    lines.push('Бұл уақытта бұрыннан жоспарланған:');
  } else {
    lines.push('CONFLICT DETECTED');
    lines.push('');
    lines.push('You have an existing plan at this time:');
  }

  lines.push('');

  for (const c of conflicts) {
    let existing = `— ${c.existingTodo.task}`;
    if (c.existingTodo.time) existing += ` · ${c.existingTodo.time}`;
    lines.push(existing);

    let incoming = `  with: ${c.newTodo.task}`;
    if (c.newTodo.time) incoming += ` · ${c.newTodo.time}`;
    lines.push(incoming);
  }

  lines.push('');

  if (language === 'ru') lines.push('Перенести или оставить оба?');
  else if (language === 'kk') lines.push('Жылжыту немесе екеуін де қалдыру?');
  else lines.push('Reschedule, or keep both?');

  return lines.join('\n');
}

export function getConflictKeyboard(pendingId: string, language: string): InlineKeyboard {
  const keepLabel = language === 'ru' ? 'Оставить оба' : language === 'kk' ? 'Екеуін де қалдыру' : 'Keep both';
  const reschedLabel = language === 'ru' ? 'Перенести' : language === 'kk' ? 'Жылжыту' : 'Reschedule';
  
  return new InlineKeyboard()
    .text(keepLabel, `conflict_keep_${pendingId}`)
    .text(reschedLabel, `conflict_reschedule_${pendingId}`);
}

export function buildSequentialReminderMessage(taskName: string, language: string): string {
  if (language === 'ru') return `Установите напоминание для:\n"${taskName}"`;
  if (language === 'kk') return `Мына тапсырмаға еске салу орнатыңыз:\n"${taskName}"`;
  return `Set reminder for:\n"${taskName}"`;
}

export function getSequentialReminderKeyboard(pendingId: string, currentOffset: number, language: string): InlineKeyboard {
  const mark = (val: number | 'none') => {
    if (val === 'none') return currentOffset === -1 ? ' ·' : '';
    return currentOffset === val ? ' ·' : '';
  };
  
  let label10 = `10 min before${mark(10)}`;
  let label30 = `30 min before${mark(30)}`;
  let label60 = `1 hour before${mark(60)}`;
  let labelNone = `No reminder${mark('none')}`;
  let labelCustom = `Custom`;
  
  if (language === 'ru') {
    label10 = `За 10 мин${mark(10)}`;
    label30 = `За 30 мин${mark(30)}`;
    label60 = `За 1 час${mark(60)}`;
    labelNone = `Без напоминания${mark('none')}`;
    labelCustom = `Свое время`;
  } else if (language === 'kk') {
    label10 = `10 мин бұрын${mark(10)}`;
    label30 = `30 мин бұрын${mark(30)}`;
    label60 = `1 сағат бұрын${mark(60)}`;
    labelNone = `Еске салусыз${mark('none')}`;
    labelCustom = `Өз уақытым`;
  }
  
  return new InlineKeyboard()
    .text(label10, `srem_10_${pendingId}`)
    .text(label30, `srem_30_${pendingId}`)
    .text(label60, `srem_60_${pendingId}`)
    .row()
    .text(labelNone, `srem_none_${pendingId}`)
    .text(labelCustom, `srem_custom_${pendingId}`);
}

export function getNavKeyboard(language: string): InlineKeyboard {
  const repLabel = language === 'ru' ? 'Отчет' : language === 'kk' ? 'Есеп' : 'Report';
  const weekLabel = language === 'ru' ? 'Неделя' : language === 'kk' ? 'Апта' : 'Weekly';
  const clearLabel = language === 'ru' ? 'Очистить' : language === 'kk' ? 'Тазарту' : 'Clear done';
  const langLabel = language === 'ru' ? 'Язык' : language === 'kk' ? 'Тіл' : 'Language';
  
  return new InlineKeyboard()
    .text(repLabel, 'nav_report')
    .text(weekLabel, 'nav_weekly')
    .text(clearLabel, 'nav_clear')
    .text(langLabel, 'nav_language');
}
