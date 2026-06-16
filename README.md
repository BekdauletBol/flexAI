# Flex — Telegram Voice Notes Assistant

Voice-to-task bot with scheduling, reminders, conflict detection, multi-language support, and PDF reports.

## Features

- Voice transcription (Groq Whisper) + AI analysis (GPT-4o)
- Task extraction with priorities, dates, times, locations
- Per-task reminder keyboard (5/10/15/30/60 min + custom)
- Conflict detection (overlapping tasks)
- PDF report generation (Buffer-based, no disk leakage)
- Multi-language: English, Russian, Kazakh
- Auto-detected location (geocoding + weather)
- SQLite persistence with WAL mode
- **Production Ready**: 30,000 user hard cap, rate limiting, async processing queue.

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
- `/stats` — (Admin only) view user count, task count, and queue status

## Configuration

| Var | Required | Description |
|-----|----------|-------------|
| TELEGRAM_BOT_TOKEN | yes | From @BotFather |
| OPENAI_API_KEY | yes | OpenAI key or GitHub PAT (`ghp_...`) |
| GROQ_API_KEY | yes | Groq Whisper |
| ADMIN_TELEGRAM_ID | yes | Your Telegram ID for `/stats` |
| TELEGRAM_BOT_API_SECRET_TOKEN | yes | Arbitrary string for webhook security |
| WEBHOOK_DOMAIN | no | HTTPS URL for webhook mode |
| MAX_USERS | no | Default: 30000 |
| LOG_LEVEL | no | `info` (default), `debug` |

## Webhook Setup

To enable webhook mode:
1. Set `WEBHOOK_DOMAIN` to `https://your-domain.com`.
2. Set `TELEGRAM_BOT_API_SECRET_TOKEN` to a secure random string.
3. Start the bot. It will automatically call `setWebhook`.

## Docker

```bash
docker compose up -d --build
```
Starts on port 3000 with healthcheck, auto-restart, persistent volume.

## Architecture

```
voice -> Processing Queue -> Whisper -> GPT-4o -> SQLite
                                               -> PDF
                                               -> Reminders
```
