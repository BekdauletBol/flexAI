# Flex — Telegram Voice Notes Assistant

Voice-to-task bot with scheduling, reminders, conflict detection, multi-language support, and PDF reports.

## Features

- Voice transcription (Groq Whisper) + AI analysis (GPT-4o)
- Task extraction with priorities, dates, times, locations
- Per-task reminder keyboard (5/10/15/30/60 min + custom)
- Conflict detection (overlapping tasks)
- PDF report generation
- Multi-language: English, Russian, Kazakh
- Auto-detected location (geocoding + weather)
- SQLite persistence (no JSON corruption)

## Quick Start

```bash
cp .env.example .env   # fill in your tokens
npm install
npm run dev
```

## Usage

1. Open the bot in Telegram.
2. Send `/start` to begin.
3. Record and send a voice message.
4. Receive:
   - 📎 PDF report with structured notes.
   - 📝 Text summary in chat with tasks.
   - 🔔 Reminders for tasks with specific times.

## Commands

- `/start` — welcome message & navigation
- `/report` — view all current tasks (AI-powered report)
- `/weekly` — summary of the past 7 days
- `/clear` — archive (mark done) all completed tasks
- `/language` — switch language
- `/help` — usage info

## Configuration

| Var | Required | Description |
|-----|----------|-------------|
| TELEGRAM_BOT_TOKEN | yes | From @BotFather |
| OPENAI_API_KEY | yes | OpenAI key or GitHub PAT (`ghp_...`) |
| GROQ_API_KEY | yes | Groq Whisper (free at console.groq.com) |
| WEBHOOK_DOMAIN | no | HTTPS URL for webhook mode (omit = long polling) |
| GOOGLE_MAPS_API_KEY | no | Location/weather features |
| OPENWEATHER_API_KEY | no | Weather forecast |
| WEBAPP_URL | no | Telegram Mini App public URL |
| LOG_LEVEL | no | `info` (default), `debug`, `trace` |

## Docker

```bash
docker compose up -d --build
```
Starts on port 3000 with healthcheck, auto-restart, persistent volume.

## Production Checklist

- Set `WEBHOOK_DOMAIN` to your HTTPS URL (required for Telegram webhook)
- Use Docker with `docker compose up -d`
- Monitor via healthcheck: `GET /health`
- Logs via `docker compose logs -f`
- DB volume persists across restarts

## Architecture

```
voice/audio -> Groq Whisper -> GPT-4o analysis -> tasks stored in SQLite
                                                     -> PDF report
                                                     -> reminders (30s interval)
                                                     -> conflict check
```
