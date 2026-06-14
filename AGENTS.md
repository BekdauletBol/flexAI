# flexAI — Voice Bot

## Quick start
```bash
npm install              # dependencies
cp .env.example .env     # fill tokens
npm run dev              # tsx watch (no typecheck)
npm run build && npm start  # production
```

## Architecture

```
src/
  index.ts          — bot entry, commands, callbacks, message routing
  config.ts         — env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, GROQ_API_KEY, etc.
  server.ts         — Express server (port 3000), serves webapp.html + REST APIs
  handlers/
    voice.ts        — voice message pipeline: download → whisper → analysis → location → conflict → delivery
  services/
    whisper.ts      — Groq Whisper (whisper-large-v3), no ffmpeg needed (OGG/Opus natively supported)
    analysis.ts     — GPT-4o JSON extraction of todos, dates, locations, priorities
    planStore.ts    — in-memory + day_plan.json persistence (accumulative per userId)
    scheduler.ts    — in-process 30s interval, sends plain-text reminders
    pendingStore.ts — pending voice notes + user flow state (awaiting_reschedule, awaiting_custom_reminder)
    delivery.ts     — post-analysis flow: summary → sequential reminder buttons → chart + PDF
    chart.ts        — ChartJSNodeCanvas (Gantt-style horizontal bar)
    pdf.ts          — PDFKit A4 single-page, dark theme
    messages.ts     — inline keyboards and summary/conflict/reminder message builders
    userConfig.ts   — user_config.json: language, location, reminder_offset_minutes
    location.ts     — Google Places / OpenWeather / BigDataCloud / OSM geocoding
    reporter.ts     — /report and /weekly plain-text formatting
  types/
    analysis.ts     — TodoItem, AnalysisResult interfaces
    i18n.ts         — PDF label translations (en/ru/kk)
public/
  webapp.html       — Telegram Mini App with timeline, tasks, reschedule modal
day_plan.json       — persistent store (auto-migrated from v1 to v2 format)
user_config.json    — per-user settings
```

## Data flow (voice message)
1. Download OGG → `temp/v_{timestamp}.ogg`
2. Groq Whisper (auto-detect RU/EN/KK)
3. GPT-4o analysis → structured JSON (todos, dates, priorities, locations)
4. Location assistant (parallel: Google Places, weather, directions)
5. Conflict detection (time overlaps with existing todos)
6. If conflicts → inline keyboard: "Keep both" / "Reschedule"
7. Else → save plan → schedule reminders → delivery flow
8. Delivery: summary text → per-task reminder offset buttons → chart image + PDF

## Key commands & callbacks
| Command | Action |
|---------|--------|
| `/start` | Welcome + nav keyboard |
| `/report` | All pending + completed tasks |
| `/weekly` | Past 7 days summary |
| `/clear` | Archive completed tasks |
| `/language` | Inline lang picker (ru/en/kk) |
| `conflict_keep_{id}` | Keep overlapping tasks |
| `conflict_reschedule_{id}` | Enter new time (flow state) |
| `srem_{10,30,60,none,custom}_{id}` | Set reminder offset per task |

## API endpoints (Express, port 3000)
| Endpoint | Body | Purpose |
|----------|------|---------|
| `POST /api/todo/complete` | `{chatId, taskId, done}` | Toggle done |
| `POST /api/todo/reschedule` | `{chatId, taskId, newTime}` | Change time, update scheduler |
| `POST /api/todo/reminder` | `{chatId, userId, offsetMinutes}` | Global offset |
| `GET /health` | — | Health check |
| `GET /webapp` | — | Serves webapp.html |

## Storage format
- `day_plan.json`: `{ __version: 2, userPlans: { userId: [StoredPlan[]] }, latestByChatId: { chatId: StoredPlan } }`
- `user_config.json`: `{ userId: { language, city, lat, lng, reminder_offset_minutes } }`
- Temp files: `temp/v_*.ogg` (auto-deleted after processing)

## Scheduler
- In-process `setInterval(checkReminders, 30_000)`
- Reminders are in-memory `ScheduledReminder[]` array (not persisted across restarts)
- Offset: `eventTime - offset_minutes * 60_000`
- Skips if `todo.done` at trigger time
- Cleans up notified reminders older than 60s
- `rescheduleReminder()` replaces reminder by `taskId`

## Mini App (webapp.html)
- Receives plan data as base64 JSON in URL hash (`/#{base64}`)
- 3 tabs: Timeline, Tasks, Reminder
- Toggle done, reschedule via time picker modal, set global reminder offset
- Telegram WebApp SDK: `tg.ready()`, `tg.expand()`, `tg.HapticFeedback`
- Dark theme, glass-morphism design, accent color #1e51de

## i18n
- Three languages: en, ru, kk
- Language detection from transcript (analysis.ts sets `language` field)
- User can override via `/language` command (stored in `user_config.json`)
- Error messages in `index.ts` use `getLang(userId)` lookup

## Important quirks
- **No ffmpeg needed** — Groq Whisper accepts raw OGG/Opus
- **No typecheck in dev** — `tsx src/index.ts` skips type checking
- **LLM prompt** in `analysis.ts` — must include current date context for relative date resolution
- **UUID v4** assigned to every todo item in `analysis.ts:98-107`
- **Flow state** (`pendingStore.ts`) — user's active flow tracked by userId, auto-cleaned after 10 min
- **Conflict detection** compares time+duration windows, ignores date mismatch
- **Reminders are ephemeral** — lost on restart unless persisted (currently in-memory only)
- **GitHub Models support** — if `OPENAI_API_KEY` starts with `ghp_` or `github_pat_`, baseURL switches to `models.inference.ai.azure.com`
