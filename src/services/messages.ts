import { InlineKeyboard } from "grammy";
import { TodoItem, AnalysisResult, TaskSource } from "../types/analysis.js";
import { Conflict } from "./planStore.js";
import { DateTime } from 'luxon';

const KZ_ZONE = 'Asia/Almaty';

const SEP = "———————————————";

function formatPriority(p: string): string {
  if (p === "high") return "High";
  if (p === "medium") return "Medium";
  return "Low";
}

/** Format minutes into human-readable duration: "30 мин", "1.5 ч", "2 ч" */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h} ч`;
  return `${h}.${Math.floor(m / 30)} ч`;
}

/** Format a UTC ISO datetime to HH:mm in KZ timezone */
export function formatTimeKz(isoStr: string | null | undefined): string {
  if (!isoStr) return '—:——';
  const dt = DateTime.fromISO(isoStr, { zone: 'utc' }).setZone(KZ_ZONE);
  return dt.isValid ? dt.toFormat('HH:mm') : '—:——';
}

/** Get localized source label */
export function sourceLabel(source: TaskSource | string | undefined, lang: string): string {
  if (lang === 'ru') {
    if (source === 'voice' || source === 'telegram') return 'голос';
    if (source === 'teams') return 'Teams';
    if (source === 'manual') return 'вручную';
    return 'telegram';
  }
  return source || 'manual';
}

export function buildSummaryMessage(
  title: string,
  summary: string,
  todos: TodoItem[],
  tags: string[],
  language: string,
  recordedAt: DateTime,
): string {
  const lines: string[] = [];

  if (language === "ru") lines.push("СОХРАНЕНО");
  else if (language === "kk") lines.push("САҚТАЛДЫ");
  else lines.push("SAVED");

  lines.push("");

  for (const t of todos) {
    let line = `— ${t.task}`;
    if (t.time) line += ` · ${t.time}`;
    lines.push(line);
  }

  lines.push("");

  const count = todos.length;
  if (language === "ru") {
    const label =
      count === 1
        ? "задача добавлена"
        : count > 1 && count < 5
          ? "задачи добавлены"
          : "задач добавлено";
    lines.push(`${count} ${label}.`);
  } else if (language === "kk") {
    lines.push(`${count} тапсырма қосылды.`);
  } else {
    lines.push(`${count} task${count === 1 ? "" : "s"} added.`);
  }

  return lines.join("\n");
}

export function buildConflictMessage(
  conflicts: Conflict[],
  language: string,
): string {
  const lines: string[] = [];

  if (language === "ru") {
    lines.push(
      `КОНФЛИКТ${conflicts.length === 1 ? "" : " — " + conflicts.length}`,
    );
  } else if (language === "kk") {
    lines.push(
      `ҚАЙШЫЛЫҚ${conflicts.length === 1 ? "" : " — " + conflicts.length}`,
    );
  } else {
    lines.push(
      `CONFLICT${conflicts.length === 1 ? "" : " — " + conflicts.length}`,
    );
  }

  lines.push("");

  for (const c of conflicts) {
    const exTime = c.existingTodo.time || formatTimeKz((c.existingTodo as any).datetime || (c.existingTodo as any).scheduled_at);
    const exDur = c.existingTodo.duration || (c.existingTodo as any).duration_minutes || 30;
    const exEnd = addMinutesToTime(exTime, exDur);
    const exSrc = sourceLabel(c.existingTodo.source, language);

    const newTime = c.newTodo.time || formatTimeKz((c.newTodo as any).datetime || (c.newTodo as any).scheduled_at);
    const newDur = c.newTodo.duration || (c.newTodo as any).duration_minutes || 30;
    const newEnd = addMinutesToTime(newTime, newDur);
    const newSrc = sourceLabel(c.newTodo.source, language);

    lines.push(`— ${c.existingTodo.task} · ${exTime}–${exEnd} [${exSrc}]`);
    lines.push(`  пересекается с`);
    lines.push(`— ${c.newTodo.task} · ${newTime}–${newEnd} [${newSrc}]`);
    lines.push("");
  }

  if (language === "ru") {
    lines.push("Что делать?");
  } else if (language === "kk") {
    lines.push("Не істеу керек?");
  } else {
    lines.push("What to do?");
  }

  return lines.join("\n");
}

/** Add minutes to HH:mm string, returns new HH:mm */
function addMinutesToTime(timeStr: string, minutes: number): string {
  if (!timeStr || timeStr === '—:——') return '—:——';
  const parts = timeStr.split(':').map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return timeStr;
  const totalMins = parts[0] * 60 + parts[1] + minutes;
  const h = Math.floor(totalMins / 60) % 24;
  const m = totalMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Combined conflict message for multiple tasks. */
export function buildCombinedConflictMessage(
  conflicts: Conflict[],
  language: string,
): string {
  const lines: string[] = [];
  const conflictCount = conflicts.length;

  if (language === "ru") {
    lines.push(`ОБНАРУЖЕНО КОНФЛИКТОВ — ${conflictCount}`);
  } else if (language === "kk") {
    lines.push(`ҚАЙШЫЛЫҚТАР АНЫҚТАЛДЫ — ${conflictCount}`);
  } else {
    lines.push(
      `CONFLICTS DETECTED — ${conflictCount} task${conflictCount === 1 ? "" : "s"}`,
    );
  }

  lines.push("");

  // Limit to first 10 conflicts to avoid MESSAGE_TOO_LONG error (Telegram 4096 char limit)
  const MAX_CONFLICTS_SHOWN = 10;
  const conflictsToShow = conflicts.slice(0, MAX_CONFLICTS_SHOWN);
  const hasMore = conflicts.length > MAX_CONFLICTS_SHOWN;

  const existingLabel =
    language === "ru" ? "СУЩЕСТВУЮЩИЙ" : language === "kk" ? "БАР" : "EXISTING";
  const newLabel =
    language === "ru" ? "НОВЫЙ" : language === "kk" ? "ЖАҢА" : "NEW";

  for (const c of conflictsToShow) {
    let line = `${existingLabel}: ${c.existingTodo.task} · ${c.existingTodo.time}`;
    lines.push(line);
    line = `${newLabel}: ${c.newTodo.task} · ${c.newTodo.time}`;
    lines.push(line);
    lines.push("");
  }

  // Show summary if there are more conflicts
  if (hasMore) {
    const remaining = conflicts.length - MAX_CONFLICTS_SHOWN;
    if (language === "ru") {
      lines.push(
        `... и ещё ${remaining} конфликт${remaining === 1 ? "" : remaining < 5 ? "а" : "ов"}`,
      );
    } else if (language === "kk") {
      lines.push(`... және тағы ${remaining} қайшылық`);
    } else {
      lines.push(
        `... and ${remaining} more conflict${remaining === 1 ? "" : "s"}`,
      );
    }
    lines.push("");
  }

  lines.push("");

  if (language === "ru") {
    lines.push("Сохранить все  |  Пропустить все  |  По одному");
  } else if (language === "kk") {
    lines.push("Барлығын сақтау  |  Барлығын өткізіп жіберу  |  Бір-бірден");
  } else {
    lines.push("Keep all new  |  Skip all new  |  Resolve one by one");
  }

  return lines.join("\n");
}

export function getConflictKeyboard(
  pendingId: string,
  language: string,
): InlineKeyboard {
  const keepLabel =
    language === "ru"
      ? "Оставить оба"
      : language === "kk"
        ? "Екеуін де қалдыру"
        : "Keep both";
  const replaceLabel =
    language === "ru"
      ? "Заменить старый"
      : language === "kk"
        ? "Ескісін ауыстыру"
        : "Replace old";
  const cancelLabel =
    language === "ru"
      ? "Отменить новый"
      : language === "kk"
        ? "Жаңасын болдыру"
        : "Cancel new";

  return new InlineKeyboard()
    .text(keepLabel, `conflict_keep_${pendingId}`)
    .text(replaceLabel, `conflict_replace_${pendingId}`)
    .row()
    .text(cancelLabel, `conflict_skip_${pendingId}`);
}

export function getCombinedConflictKeyboard(
  pendingId: string,
  language: string,
): InlineKeyboard {
  const keepLabel =
    language === "ru"
      ? "Сохранить все"
      : language === "kk"
        ? "Барлығын сақтау"
        : "Keep all";
  const skipLabel =
    language === "ru"
      ? "Пропустить все"
      : language === "kk"
        ? "Барлығын өткізіп жіберу"
        : "Skip all";
  const oneByOneLabel =
    language === "ru"
      ? "По одному"
      : language === "kk"
        ? "Бір-бірден"
        : "One by one";

  return new InlineKeyboard()
    .text(keepLabel, `conflict_keep_all_${pendingId}`)
    .text(skipLabel, `conflict_skip_all_${pendingId}`)
    .text(oneByOneLabel, `conflict_one_by_one_${pendingId}`);
}

export function getSingleConflictKeyboard(
  pendingId: string,
  conflictIndex: number,
  language: string,
): InlineKeyboard {
  const keepLabel =
    language === "ru" ? "Оставить" : language === "kk" ? "Қалдыру" : "Keep";
  const replaceLabel =
    language === "ru"
      ? "Заменить"
      : language === "kk"
        ? "Ауыстыру"
        : "Replace";
  const nextLabel =
    language === "ru"
      ? "Пропустить"
      : language === "kk"
        ? "Өткізіп жіберу"
        : "Skip";

  return new InlineKeyboard()
    .text(keepLabel, `conflict_keep_idx_${pendingId}_${conflictIndex}`)
    .text(replaceLabel, `conflict_replace_idx_${pendingId}_${conflictIndex}`)
    .text(nextLabel, `conflict_skip_idx_${pendingId}_${conflictIndex}`);
}

// ─── Interactive Reschedule Picker ─────────────────────────────────────────────

export function buildRescheduleDatePicker(
  taskName: string,
  language: string,
): string {
  if (language === "ru") return `RESCHEDULE\n\n— ${taskName}\n\nВыберите дату:`;
  if (language === "kk")
    return `ҚАЙТА ЖОСПАРЛАУ\n\n— ${taskName}\n\nКүнді таңдаңыз:`;
  return `RESCHEDULE\n\n— ${taskName}\n\nSelect a date:`;
}

export function getRescheduleDateKeyboard(language: string): InlineKeyboard {
  const now = DateTime.now().setZone(KZ_ZONE);
  const fmt = (dt: DateTime) => dt.toFormat('MMM d');
  const tom = now.plus({ days: 1 });
  const in2 = now.plus({ days: 2 });

  const today = fmt(now);
  const tomorrow = fmt(tom);
  const dayAfter = fmt(in2);

  const todayLabel =
    language === "ru"
      ? `Сегодня · ${today}`
      : language === "kk"
        ? `Бүгін · ${today}`
        : `Today · ${today}`;
  const tomLabel =
    language === "ru"
      ? `Завтра · ${tomorrow}`
      : language === "kk"
        ? `Ертең · ${tomorrow}`
        : `Tomorrow · ${tomorrow}`;
  const in2Label =
    language === "ru"
      ? `Через 2 дня · ${dayAfter}`
      : language === "kk"
        ? `2 күннен кейін · ${dayAfter}`
        : `In 2 days · ${dayAfter}`;
  const customLabel =
    language === "ru"
      ? "Другая дата"
      : language === "kk"
        ? "Басқа күн"
        : "Custom date";

  return new InlineKeyboard()
    .text(todayLabel, "rs_d_today")
    .row()
    .text(tomLabel, "rs_d_tomorrow")
    .row()
    .text(in2Label, "rs_d_plus2")
    .row()
    .text(customLabel, "rs_d_custom");
}

export function buildRescheduleTimePicker(
  taskName: string,
  dateLabel: string,
  language: string,
): string {
  if (language === "ru")
    return `RESCHEDULE\n\n— ${taskName} · ${dateLabel}\n\nВыберите время:`;
  if (language === "kk")
    return `ҚАЙТА ЖОСПАРЛАУ\n\n— ${taskName} · ${dateLabel}\n\nУақытты таңдаңыз:`;
  return `RESCHEDULE\n\n— ${taskName} · ${dateLabel}\n\nSelect a time:`;
}

export function getRescheduleTimeKeyboard(language: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const rows = [
    ["07:00", "08:00", "09:00", "10:00", "11:00"],
    ["12:00", "13:00", "14:00", "15:00", "16:00"],
    ["17:00", "18:00", "19:00", "20:00", "21:00"],
    ["22:00", "23:00", "00:00"],
  ];
  for (let i = 0; i < rows.length; i++) {
    for (const t of rows[i]) kb.text(t, `rs_t_${t}`);
    if (i < rows.length - 1) kb.row();
  }
  const customLabel =
    language === "ru"
      ? "Свое время"
      : language === "kk"
        ? "Өз уақытым"
        : "Custom time";
  kb.text(customLabel, "rs_t_custom");
  return kb;
}

export function buildRescheduleConfirm(
  taskName: string,
  oldDate: string,
  oldTime: string,
  newDate: string,
  newTime: string,
  language: string,
): string {
  const fmt = (s: string) => {
    if (!s) return "";
    return DateTime.fromISO(s, { zone: KZ_ZONE }).toFormat('MMM d');
  };
  const oldLabel = fmt(oldDate);
  const newLabel = fmt(newDate);
  if (language === "ru")
    return `RESCHEDULED\n\n— ${taskName}\n— ${oldLabel} · ${oldTime}  →  ${newLabel} · ${newTime}\n\nГотово.`;
  if (language === "kk")
    return `ҚАЙТА ЖОСПАРЛАНДЫ\n\n— ${taskName}\n— ${oldLabel} · ${oldTime}  →  ${newLabel} · ${newTime}\n\nДайын.`;
  return `RESCHEDULED\n\n— ${taskName}\n— ${oldLabel} · ${oldTime}  →  ${newLabel} · ${newTime}\n\nDone.`;
}

export function buildSequentialReminderMessage(
  taskName: string,
  language: string,
): string {
  if (language === "ru") return `Установите напоминание для:\n"${taskName}"`;
  if (language === "kk")
    return `Мына тапсырмаға еске салу орнатыңыз:\n"${taskName}"`;
  return `Set reminder for:\n"${taskName}"`;
}

export function getSequentialReminderKeyboard(
  pendingId: string,
  currentOffset: number,
  language: string,
): InlineKeyboard {
  const mark = (val: number | "none") => {
    if (val === "none") return currentOffset === -1 ? " ·" : "";
    return currentOffset === val ? " ·" : "";
  };

  let label10 = `10 min before${mark(10)}`;
  let label30 = `30 min before${mark(30)}`;
  let label60 = `1 hour before${mark(60)}`;
  let labelNone = `No reminder${mark("none")}`;
  let labelCustom = `Custom`;

  if (language === "ru") {
    label10 = `За 10 мин${mark(10)}`;
    label30 = `За 30 мин${mark(30)}`;
    label60 = `За 1 час${mark(60)}`;
    labelNone = `Без напоминания${mark("none")}`;
    labelCustom = `Свое время`;
  } else if (language === "kk") {
    label10 = `10 мин бұрын${mark(10)}`;
    label30 = `30 мин бұрын${mark(30)}`;
    label60 = `1 сағат бұрын${mark(60)}`;
    labelNone = `Еске салусыз${mark("none")}`;
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
  const repLabel =
    language === "ru" ? "Отчет" : language === "kk" ? "Есеп" : "Report";
  const weekLabel =
    language === "ru" ? "Неделя" : language === "kk" ? "Апта" : "Weekly";
  const clearLabel =
    language === "ru"
      ? "Очистить"
      : language === "kk"
        ? "Тазарту"
        : "Clear done";
  const langLabel =
    language === "ru" ? "Язык" : language === "kk" ? "Тіл" : "Language";

  return new InlineKeyboard()
    .text(repLabel, "nav_report")
    .text(weekLabel, "nav_weekly")
    .text(clearLabel, "nav_clear")
    .text(langLabel, "nav_language");
}

// ─── Free Time & Availability ──────────────────────────────────────────────────

export interface FreeTimeGap {
  start: string;  // HH:mm
  end: string;    // HH:mm
  durationMin: number;
}

export interface BreakInfo {
  afterTask: string;
  afterTime: string;
  durationMin: number;
  beforeNextTask: string;
}

/** Build the free time + breaks message */
export function buildFreeTimeMessage(
  dateLabel: string,
  gaps: FreeTimeGap[],
  breaks: BreakInfo[],
  language: string,
): string {
  const lines: string[] = [];

  if (language === 'ru') {
    lines.push(`Свободное время ${dateLabel}:`);
  } else if (language === 'kk') {
    lines.push(`Бос уақыт ${dateLabel}:`);
  } else {
    lines.push(`Free time ${dateLabel}:`);
  }

  lines.push('');

  if (gaps.length === 0) {
    if (language === 'ru') lines.push('Нет свободных окон (15+ мин).');
    else if (language === 'kk') lines.push('Бос терезе жоқ (15+ мин).');
    else lines.push('No free windows (15+ min).');
  } else {
    for (const g of gaps) {
      const durLabel = formatDuration(g.durationMin);
      // Evening label
      if (g.start >= '18:00' && g.end === '22:00') {
        if (language === 'ru') lines.push(`— ${g.start}–${g.end} (${durLabel}, вечер свободен)`);
        else if (language === 'kk') lines.push(`— ${g.start}–${g.end} (${durLabel}, кеш бос)`);
        else lines.push(`— ${g.start}–${g.end} (${durLabel}, evening free)`);
      } else {
        lines.push(`— ${g.start}–${g.end} (${durLabel})`);
      }
    }
  }

  if (breaks.length > 0) {
    lines.push('');
    if (language === 'ru') lines.push('Перерывы между задачами:');
    else if (language === 'kk') lines.push('Тапсырмалар арасындағы үзілістер:');
    else lines.push('Breaks between tasks:');

    for (const b of breaks) {
      const durLabel = formatDuration(b.durationMin);
      if (language === 'ru') {
        lines.push(`— ${b.afterTime} после «${b.afterTask}» · ${durLabel} до следующей`);
      } else if (language === 'kk') {
        lines.push(`— ${b.afterTime} «${b.afterTask}» кейін · ${durLabel} келесіге дейін`);
      } else {
        lines.push(`— ${b.afterTime} after "${b.afterTask}" · ${durLabel} until next`);
      }
    }
  }

  return lines.join('\n');
}
