# flexAI — Telegram Voice Bot (Agent Handbook)

## Quick Start
```bash
npm install
cp .env.example .env      # fill TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, GROQ_API_KEY
npm run dev                # tsx watch src/index.ts (no typecheck)
npm run build && npm start # production
```

Clean DB to test fresh:
```bash
rm -f data/flexai.db day_plan.json memory.json user_config.json
```

## Architecture

```
src/
  index.ts             — Bot entry, commands (/report, /weekly, /clear, /help, /reminders),
                         callback queries (conflict, reschedule, snooze, reminder, image),
                         message handlers (voice → handleVoice, text → processTextInput, photo → handleImage)
  config.ts            — Singleton config with initConfig() guard. Reads TELEGRAM_BOT_TOKEN,
                         OPENAI_API_KEY (supports GitHub PAT → GitHub Models), GROQ_API_KEY
  server.ts            — Express (port 3000), serves webapp.html + REST APIs (todo/complete,
                         todo/reschedule, todo/reminder, health, memory CRUD)

  handlers/
    voice.ts           — Core: handleVoice (download → transcribe → route),
                         handlePlanIntent (analyze → conflict → save → delivery),
                         processTextInput (shared pipeline: pending time → intent → memory → routeByIntent),
                         routeByIntent (dispatches to action/reschedule/delete/complete/report/etc.)
    image.ts           — Screenshot processing: handleImage (GPT-4o vision), mapSourceAppToTaskSource

  services/
    whisper.ts         — Groq Whisper (whisper-large-v3), OGG/Opus native, auto-detect RU/EN/KK
    analysis.ts        — GPT-4o LLM prompt for JSON extraction of todos/dates/times/priorities/locations
    intent.ts          — LLM-based intent classification + regex quickIntentOverride, extractMemoryUpdate
    planStore.ts       — SQLite query builder: savePlan (with dedup + same-batch conflict detection),
                         getTasksFiltered (with DISTINCT + is_reminder filter),
                         dedupeReportTasks, findFreeTimeGaps, getConflicts, CRUD operations
    scheduler.ts       — 30s interval checkReminders (DB-driven: SELECT is_reminder=1 AND notified=0
                         AND datetime<=now), marks notified=1 after send, snooze via callbacks
    pendingStore.ts    — In-memory pending state: flow state, reschedule state, image followup,
                         day memory, conflict state
    delivery.ts        — Post-save: summary → per-task reminder offset buttons → delivery flow
    pdf.ts             — Old PDFKit renderer (generateReportPdf, generateMultiDateReportPdf)
    report.ts          — New PDFKit renderer (generateDailyReportPdf, generateRangeReportPdf)
                         with direct SQLite queries, dark Obsidian theme
    messages.ts        — Inline keyboards and message builders (summary, conflict, reminder, nav)
    userConfig.ts      — Per-user settings: language, city, lat/lng, reminder_offset_minutes
    memoryStore.ts     — memory.json read/write, patterns sanitization, occurrence threshold
    location.ts        — Google Places / OpenWeather / BigDataCloud / OSM geocoding
    db.ts              — SQLite schema CREATE TABLE, migrations (ALTER TABLE ADD COLUMN),
                         insertReminder, detectTimeConflicts, getUserTasks
    textRouter.ts      — Alternative text regex router (fast path for complete/reschedule/report)
    groq.ts            — Groq LLM client (llama-3.3-70b-versatile), used for intent detection
    queue.ts           — PQueue for voice processing concurrency (5 concurrent)

  types/
    analysis.ts        — TodoItem, AnalysisResult, TimeFrame, TaskSource interfaces
    i18n.ts            — PDF label translations (en/ru/kk)

  utils/
    timezone.ts        — Luxon-based: kzLocalToUTC, utcToKzLocalTime, parseEventTimeAsKZ,
                         nowKZ(), getKzToday(). NEVER use raw Date.
```

## Database Schema (`data/flexai.db`)

### `todos` table
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (UUID) | PK |
| chat_id | INTEGER | FK → plans |
| user_id | INTEGER | FK → users |
| task | TEXT | Task description |
| priority | TEXT | 'high'/'medium'/'low' |
| done | INTEGER | 0/1 |
| time | TEXT | 'HH:MM' or null |
| datetime | TEXT | UTC ISO 'YYYY-MM-DDTHH:MM:00Z' |
| date | TEXT | 'YYYY-MM-DD' or null |
| duration | INTEGER | Default 30 (minutes) |
| location | TEXT | Optional |
| source | TEXT | 'teams'/'telegram'/'voice'/'manual' |
| completed_at | TEXT | UTC ISO |
| snoozed_until | TEXT | UTC ISO |
| scheduled_time_kz | TEXT | 'YYYY-MM-DDTHH:MM' (KZ local) |
| is_reminder | INTEGER | 0=task, 1=reminder row |
| scheduled_at | TEXT | UTC ISO (backfill target) |
| parent_task_id | TEXT | Links compound reminder to parent task |
| reminder_minutes | INTEGER | User-requested offset |
| notified | INTEGER | 0=unsent, 1=sent |
| explicitly_set | INTEGER | 1=user explicitly asked for this reminder |

### Key queries
```sql
-- Task report (daily)
SELECT DISTINCT * FROM todos WHERE user_id = ? AND (is_reminder IS NULL OR is_reminder = 0)
  AND (date = ? OR substr(COALESCE(scheduled_time_kz, date || 'T' || COALESCE(time, '00:00')), 1, 10) = ?)
  ORDER BY CASE WHEN time IS NULL THEN 1 ELSE 0 END, time ASC

-- Due reminders (scheduler tick)
SELECT id, chat_id, user_id, task, datetime, location FROM todos
  WHERE is_reminder = 1 AND datetime <= ? AND notified = 0 AND done = 0
  ORDER BY datetime ASC

-- Conflict detection
SELECT * FROM todos WHERE user_id = ? AND done = 0 AND (is_reminder IS NULL OR is_reminder = 0)
  AND (DATE(scheduled_at) = ? OR DATE(datetime) = ? OR date = ?)
```

## Data Flow

### Voice Message
```
Voice OGG → Groq Whisper → transcript → processTextInput → detectIntent → routeByIntent
  ├── "action" → handlePlanIntent → analyzeTranscript (GPT-4o) → getConflicts
  │     ├── conflicts exist → inline keyboard (Keep/Reschedule/Skip)
  │     └── no conflicts → savePlan → scheduleReminders → startDeliveryFlow
  │           └── untimed tasks? → pendingTimeUpdate → ask "В какое время?"
  ├── "reschedule" → handleRescheduleIntent → findTaskByText → updateTaskDateTime
  ├── "delete" → handleDeleteIntent → extractDeleteInfo → deleteTaskById
  ├── "complete" → handleCompleteIntent → findTasksByName → markTaskDone
  ├── "report" → generateDailyReportPdf (default) or generateRangeReportPdf (if date_from/date_to)
  ├── "free_time_query" → findFreeTimeGaps → buildFreeTimeMessage → reply
  ├── "reminder" → handleReminderIntent → insertReminder → scheduler.push
  ├── "query" → askQuestion (LLM with plans + memory context)
  └── "social" → chatReply (LLM with memory context)
```

### Text Message
```
Text → processTextInput (same pipeline as voice, no transcription step)
```

### Photo/Screenshot
```
Photo → handleImage (GPT-4o vision) → extract tasks → savePlan + delivery flow
```

## Key Rules (Taste Preferences)

1. **All datetime operations use luxon.** Never `new Date()`, `Date.now()`, `.toISOString()`, `.getHours()`, `.getMinutes()`.
2. **Convert UTC to local zone first** (`.setZone('Asia/Almaty')`), perform arithmetic in local time, then convert back via `.toUTC().toISO()`.
3. **`reminder_minutes` must be null unless user explicitly said "напомни за X минут".** Never default to 10.
4. **Only extract times user explicitly stated.** "вечером", "после обеда" → `time: null`, not inferred.
5. **Compound reminders only created when `reminder_minutes > 0`.** Check: `if (!todo.reminder_minutes && !todo.reminder_at) continue;`
6. **All task queries filter `is_reminder = 0`** to exclude reminder rows from task reports.
7. **Same-batch conflict detection** in `savePlan` — checks time overlap against already-inserted batch tasks.
8. **Scheduler is DB-driven.** Queries `todos WHERE is_reminder=1 AND notified=0 AND datetime<=now AND done=0`. Marks `notified=1` after send.
9. **Pattern storage requires 3+ occurrences.** `pattern_occurrences` tracks counts, `PATTERN_THRESHOLD = 3`.
10. **Config is a singleton.** `initConfig()` guard prevents double initialization.
11. **Memory patterns only store valid keys:** `sleep_time`, `wake_up_time`, `work_time`, `lunch_time`, `dinner_time`, `breakfast_time`, `gym_time`.
12. **`bed_time` merges into `sleep_time`.** Never stores `bed_time` as separate key.

## Common Bugs & Fixes

### Config prints twice
Check `src/index.ts` — it had its own `console.log` lines (lines 86-90) that duplicate the config output. Remove them if they reappear.

### Reminder created for every task
The LLM was defaulting `reminder_minutes = 10`. Fixed by:
- Changed example in prompt from `"reminder_minutes": 10` to `"reminder_minutes": null`
- Added rule: "Never set reminder_minutes = 10 or any other number as default"
- Added guard in `savePlan`: `if (!hasExplicitReminder) continue;`

### Task appears twice in PDF
Dedup key was `task::time` — same task with time vs without time were different keys. Fixed: dedup by task name only, preferring entry WITH time.

### "Could not recognize speech" on short voice
Added file size guard (`< 1000 bytes`), detailed error logging (`[Whisper] Failed: status, message, size, format`).

### Reminder shows raw time "11:00"
Fixed `checkReminders` display to show `сегодня в 11:00` or `завтра в 14:00` using `hasSame()` comparison.

### Tasks at same time saved without conflict
Added same-batch conflict detection in `savePlan` via `insertedThisBatch` array and `timeToMinutes` overlap check.

## LLM Prompt Patterns

### Intent detection (`intent.ts`)
Uses Groq LLaMA 3.3 70B. Returns JSON: `{ intent, confidence, target_task, target_date, target_time, ... }`. CRITICAL: fields must be null for intents they don't belong to.

### Analysis (`analysis.ts`)
Uses GPT-4o (or GitHub Models). Returns JSON: `{ title, summary, key_points, todos[], tags, language, timeframe, ... }`. CRITICAL: timezone context must be injected, relative times are NOT inferred (must have explicit HH:MM).

### Memory update (`intent.ts:extractMemoryUpdate`)
LLM decides if transcript contains new info worth remembering. Returns `{ should_update, memory_update }`. Memory includes habits, projects, preferences, important_dates, patterns, places.

## Testing

Start bot: `npm run dev`
Clean DB: `rm -f data/flexai.db day_plan.json memory.json user_config.json`
Send voice: speak into Telegram
Send text: type any message
Send photo: screenshot of calendar/app
Commands: `/report`, `/weekly`, `/clear`, `/reminders`, `/help`, `/language`
