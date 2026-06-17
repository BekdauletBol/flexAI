# FlexAI — Telegram Voice Assistant for Task Management

A personal AI secretary that lives inside Telegram. Send voice messages, screenshots, or text — FlexAI transcribes, analyzes, extracts structured tasks with priorities/dates/times/locations, detects scheduling conflicts, sets up timed reminders, and generates polished PDF reports.

## What It Does

FlexAI turns voice notes into actionable task plans. Speak naturally in Russian, English, or Kazakh — the bot understands context, detects intent, manages your schedule, and keeps you on track with timed reminders and visual reports.

### Core Voice Pipeline

1. **Voice Transcription** — Groq Whisper (`whisper-large-v3`) transcribes OGG/Opus natively (no ffmpeg required). Auto-detects RU/EN/KK.
2. **AI Analysis** — GPT-4o (or Groq LLaMA 3.3 70B as fallback) extracts structured JSON: title, summary, key points, todos with priority/time/date/duration/location, tags, language, timeframe.
3. **Intent Detection** — Dual-layer: fast regex override for common patterns + LLM classification for complex inputs. Intents: `action`, `query`, `reschedule`, `delete`, `complete`, `report`, `summary`, `social`.
4. **Conflict Detection** — Compares new task time+duration windows against existing unfinished tasks. Detects overlapping time slots.
5. **Interactive Resolution** — Three modes: "Keep all", "Skip all", or resolve one-by-one with per-task Keep/Reschedule/Skip buttons.
6. **Reminder Setup** — Per-task reminder offset selection: 10min / 30min / 1hr / None / Custom.
7. **Snooze** — When a reminder fires, snooze +10min, +30min, +1hr, "Tomorrow morning", or mark as Done.
8. **PDF Report** — Obsidian-style dark theme A4 PDFs with timeline visualization, priority badges, tags, and transcript.

### Screenshot Task Extraction

Send a photo (screenshot of calendars, to-do apps, Teams, Notion, etc.) and the bot uses GPT-4o vision to extract tasks, identify the source app, and parse dates/times/priorities. Send a voice note after a screenshot to combine both — "add all these tasks" / "merge with my plan" / "check for conflicts".

### Text Message Support

Plain text messages go through the same intent detection pipeline as voice. Type tasks, questions, commands, or chat naturally.

### Long-Term User Memory

The bot remembers your habits, projects, preferences, important dates, patterns, and places across sessions. After each voice note, the LLM checks if new information is worth remembering and auto-updates memory. When answering questions, the bot injects user memory as context for personalized responses.

### Reporting

- **Full Report** — AI-powered productivity report with summary, focus areas, motivational closing.
- **Weekly Report** — Plain text summary of all tasks from the past 7 days.
- **Period Summaries** — "Today" / "Tomorrow" / "Week" / "All" task summaries via voice or text.
- **Filtered Reports** — Reports filtered by date, time range, priority, date ranges with multi-date PDF generation.

### Telegram Mini App (WebApp)

A single-page dashboard with 4 tabs:
- **Agenda** — Today's tasks with toggle done, edit, delete.
- **Week** — Interactive 7-day strip with task density indicators.
- **Month** — Plan cards with progress bars.
- **Year** — Long-term goal cards.

Task management directly in-app via REST API: toggle done, edit time/priority, delete, create new tasks.

### Location Assistant

When tasks mention a place:
- Google Places Text Search for place details (rating, hours, phone).
- OpenWeatherMap for current weather at your coordinates.
- Google Directions API for driving distance/duration.
- LLM generates contextual advice ("Is this a good time to visit?").

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript 6 |
| Bot Framework | Grammy |
| LLM | OpenAI GPT-4o / Groq LLaMA 3.3 70B |
| Speech-to-Text | Groq Whisper (whisper-large-v3) |
| Database | SQLite (better-sqlite3, WAL mode) |
| HTTP Server | Express 5 |
| PDF Generation | PDFKit (dark theme, Roboto font) |
| Queue | p-queue (concurrency 5) |
| Logging | Pino (structured JSON in prod, pretty in dev) |
| Container | Docker (multi-stage, Alpine) |

### External APIs

| API | Purpose | Required |
|-----|---------|----------|
| Telegram Bot API | Bot communication | Yes |
| Groq Whisper | Speech-to-text | Yes |
| OpenAI GPT-4o | LLM analysis/intent/reports | Yes |
| Groq LLaMA 3.3 70B | LLM fallback (cheaper) | No |
| Google Places | Place search & details | No |
| Google Directions | Driving directions | No |
| Google Geocoding | Forward/reverse geocoding | No |
| OpenWeatherMap | Weather forecasts | No |
| BigDataCloud | Reverse geocoding fallback (free) | No |
| OpenStreetMap/Nominatim | Geocoding fallback (free) | No |

## Quick Start

```bash
cp .env.example .env   # fill in your tokens
npm install
npm run dev
```

### Available Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx src/index.ts` | Development (fast reload, no typecheck) |
| `build` | `tsc` | TypeScript compilation |
| `start` | `node dist/index.js` | Production |
| `test` | `node --import tsx --import ./tests/setup.ts --test tests/**/*.test.ts` | Run tests |
| `typecheck` | `tsc --noEmit` | Type checking only |

## Usage

1. Open the bot in Telegram.
2. Send `/start` to begin.
3. Send a voice message, screenshot, or text.
4. Receive:
   - Text summary in chat with task list.
   - PDF report with structured notes and timeline.
   - Timed reminders for tasks with specific times.
   - Interactive buttons to manage conflicts and reminders.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + navigation keyboard |
| `/help` | Usage information |
| `/report` | AI-powered task report (PDF) |
| `/weekly` | Past 7 days summary (PDF) |
| `/clear` | Archive (delete) all completed tasks |
| `/language` | Inline language picker (ru/en/kk) |
| `/stats` | Admin only: user count, task count, queue status, uptime |
| `/ping` | Returns "pong" |

## Callback Interactions

| Button | Action |
|--------|--------|
| Language picker | Set language (ru/en/kk) |
| Navigation (Report/Weekly/Clear) | Trigger report generation or task cleanup |
| Conflict resolution | Keep all / Skip all / One-by-one with per-task buttons |
| Reschedule picker | Date picker (Today/Tomorrow/+2 days/Custom) → Time picker (00:00-23:00 grid + custom) → Confirm |
| Reminder offset | 10min / 30min / 1hr / None / Custom per task |
| Snooze reminder | +10min / +30min / +1hr / Tomorrow morning / Mark Done |
| Screenshot import | Add all tasks from image / Cancel |

## REST API

All endpoints served by Express on port 3000.

| Method | Endpoint | Body | Purpose |
|--------|----------|------|---------|
| GET | `/health` | — | Health check |
| GET | `/webapp` | — | Serves Mini App |
| POST | `/webhook` | Raw body | Telegram webhook (with secret token validation) |
| POST | `/api/todo/complete` | `{chatId, taskId, done}` | Toggle task done |
| POST | `/api/todo/reschedule` | `{chatId, taskId, newTime}` | Reschedule task |
| POST | `/api/todo/delete` | `{userId, taskId, date}` | Delete task |
| POST | `/api/todo/create` | `{chatId, userId, task, time, priority, date}` | Create task |
| POST | `/api/todo/reminder` | `{chatId, userId, offsetMinutes}` | Set global reminder offset |
| POST | `/api/plans/delete` | `{userId, date}` | Delete all plans for date |
| POST | `/api/plans/delete/plan` | `{userId, planId}` | Delete specific plan |
| POST | `/api/memory/delete` | `{userId, key, index}` | Delete memory entry |
| POST | `/api/memory/clear` | `{userId}` | Clear all user memory |
| GET | `/api/plans/all` | `?userId=X` | Get all plans |
| GET | `/api/plans/timeframe/:tf` | `?userId=X` | Plans by timeframe (day/week/month/year) |
| GET | `/api/plans/:date` | `?userId=X` | Plan for specific date |
| GET | `/api/memory` | `?userId=X` | Get user memory |

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | From @BotFather |
| `OPENAI_API_KEY` | Yes | — | OpenAI key or GitHub PAT (`ghp_...`) |
| `GROQ_API_KEY` | Yes | — | Groq for Whisper + optional LLM |
| `ADMIN_TELEGRAM_ID` | No | — | Your Telegram ID for `/stats` |
| `TELEGRAM_BOT_API_SECRET_TOKEN` | No | — | Webhook security token |
| `WEBHOOK_DOMAIN` | No | — | HTTPS URL for webhook mode |
| `MAX_USERS` | No | 30000 | Hard user cap |
| `ALLOWED_USER_ID` | No | — | Restrict to single user (testing) |
| `GOOGLE_MAPS_API_KEY` | No | — | Places/Directions/Geocoding |
| `WEATHERAPI` / `OPENWEATHER_API_KEY` | No | — | Weather forecasts |
| `WEBAPP_URL` | No | — | Public URL for Mini App |
| `PORT` | No | 3000 | Express server port |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `FLEXAI_DB_PATH` | No | `data/flexai.db` | Custom DB path |
| `OPENAI_MODEL` | No | `gpt-4o` | LLM model for analysis |
| `OPENAI_BASE_URL` | No | — | Custom OpenAI endpoint |

### Webhook Setup

1. Set `WEBHOOK_DOMAIN` to `https://your-domain.com`.
2. Set `TELEGRAM_BOT_API_SECRET_TOKEN` to a secure random string.
3. Start the bot — it automatically calls `setWebhook`.

### GitHub Models

If `OPENAI_API_KEY` starts with `ghp_` or `github_pat_`, the bot automatically switches to Azure-hosted GitHub Models (`models.inference.ai.azure.com`).

## Docker

### Quick Start

```bash
# 1. Setup environment
cp .env.example .env
# Edit .env with your API keys

# 2. Build and run
docker compose up -d --build

# 3. Check logs
docker compose logs -f
```

Starts on port 3000 with healthcheck, auto-restart, persistent volume for SQLite database.

**Volumes:**
- `./data:/app/data` — Persistent SQLite database
- `./temp:/app/temp` — Temporary voice/image files
- `./logs:/app/logs` — Application logs

### Docker Documentation

📖 **[Complete Docker Guide](DOCKER.md)** - Full deployment, monitoring, troubleshooting, and production setup

⚡ **[Quick Reference](DOCKER_QUICKSTART.md)** - Essential commands cheat sheet

## Architecture

```
User (Telegram)
     |
     v
  Grammy Bot (src/index.ts)
     |
     +---> Voice Queue (p-queue, concurrency 5)
     |        |
     |        +---> Download OGG → temp/
     |        +---> Groq Whisper (transcribe)
     |        +---> Memory Update (LLM)
     |        +---> Intent Detection (regex + LLM)
     |        +---> Route by Intent
     |              |
     |              +---> action → Full Analysis Pipeline
     |              |        +---> GPT-4o Analysis (structured JSON)
     |              |        +---> Location Assistant (Google + Weather)
     |              |        +---> Conflict Detection
     |              |        +---> Conflict Resolution (interactive)
     |              |        +---> Plan Storage (SQLite)
     |              |        +---> Reminder Scheduling
     |              |        +---> Delivery (summary → reminders → PDF)
     |              |
     |              +---> query → LLM Q&A (plans + memory context)
     |              +---> reschedule → Find task → Update time
     |              +---> delete → Find task → Remove
     |              +---> complete → Mark task done
     |              +---> report → PDF report generation
     |              +---> summary → Period task summary
     |
     +---> Screenshot Handler → GPT-4o Vision → Extract tasks
     |
     +---> Text Message → Intent Detection → Route
     |
     +---> Express Server (port 3000)
              +---> REST API (task CRUD, plans, memory)
              +---> Webhook endpoint
              +---> Mini App (webapp.html)
```

### Data Flow (Voice Message)

1. **Receive voice** — Grammy bot enqueues to `voiceQueue` (concurrency 5).
2. **Rate limit check** — Sliding window (30 req/min/user). User cap check for new users.
3. **Download OGG** — From Telegram API to `temp/v_{timestamp}.ogg`.
4. **Transcribe** — Groq Whisper, auto-detects RU/EN/KK. No ffmpeg needed.
5. **Context check** — If pending image tasks exist, route to voice+image flow.
6. **Memory update** — LLM checks if transcript contains new info to remember.
7. **Intent detection** — Quick regex override first, then LLM classification.
8. **Route by intent** — Dispatch to appropriate handler.
9. **LLM Analysis** (for `action` intent) — Extracts structured JSON with todos.
10. **Location assistant** — Parallel: Google Places + Weather + Directions.
11. **Conflict detection** — Compares new vs existing task time windows.
12. **Conflict resolution** — Interactive inline keyboard if conflicts found.
13. **Delivery** — Summary → per-task reminder offsets → PDF → Mini App link.

## Storage

### SQLite Database (`data/flexai.db`)

| Table | Purpose |
|-------|---------|
| `users` | Per-user settings (language, city, coordinates, reminder offset) |
| `plans` | Latest plan per chat |
| `plan_history` | Accumulative plan history |
| `todos` | Individual task items (UUID, priority, time, date, duration, location, done status) |

WAL mode for concurrent read performance. Safe migrations via `ALTER TABLE` with try/catch.

### JSON File (`memory.json`)

Per-user long-term memory: habits, projects, preferences, important dates, patterns, places. Loaded at startup, written on every update.

### In-Memory Stores (lost on restart)

- **Reminders** — Active scheduled reminders (60s cleanup after notification).
- **Pending notes** — Voice note analysis state (10min TTL).
- **Flow state** — Active user flow (reschedule/clarification).
- **Pending image tasks** — Extracted tasks from screenshots (5min TTL).
- **Rate limiter** — Sliding window timestamps per user.

## Production Features

- **Rate limiting** — 30 requests per minute per user (sliding window).
- **User cap** — Hard limit of 30,000 configurable via `MAX_USERS`.
- **Processing queue** — p-queue with concurrency 5 for voice messages.
- **Structured logging** — Pino with JSON in production, pretty-print in dev. Redacts sensitive headers/tokens.
- **Graceful shutdown** — SIGTERM/SIGINT handlers: stops bot, drains queue, force-exit after 5s.
- **Temp file cleanup** — On boot, cleans `.ogg` and `.jpg` from `temp/`.
- **Global error handling** — `unhandledRejection` and `uncaughtException` handlers.
- **Webhook security** — `X-Telegram-Bot-Api-Secret-Token` header validation.
- **Duplicate detection** — Silently skips tasks with same normalized name + date.
- **Auto-cleanup** — Pending notes expire after 10min, reschedule states after 5min.

## Multi-Language Support

Three languages: Russian, English, Kazakh. Auto-detected from transcript language. User can override via `/language` command. All UI strings (buttons, messages, error handling, PDF labels) are localized.

## PDF Reports

Three report types with Obsidian-inspired dark theme (#0D1117 background, #58A6FF accent):

- **Full Analysis PDF** — Title, summary, timeline visualization with nodes, priority pills, tags, transcript.
- **Task Report PDF** — Pending/completed tables with priority badges, stats section.
- **Multi-Date Report PDF** — Filtered/multi-date reports with sections per date.

## License

MIT
