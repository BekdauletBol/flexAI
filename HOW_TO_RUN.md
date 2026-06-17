# 🚀 How to Run FlexAI with Docker

**Complete step-by-step guide for running FlexAI Telegram bot using Docker.**

---

## Prerequisites

Make sure you have:
- Docker Desktop installed (or Docker + Docker Compose)
- Telegram Bot Token from [@BotFather](https://t.me/botfather)
- OpenAI API Key
- Groq API Key

Check Docker installation:
```bash
docker --version
docker compose version
```

---

## Step-by-Step Instructions

### 1️⃣ Navigate to Project Directory

```bash
cd flexAI
```

### 2️⃣ Create Environment Configuration

```bash
# Copy the example environment file
cp .env.example .env
```

### 3️⃣ Edit Environment Variables

Open `.env` file in your text editor and fill in your credentials:

```bash
# Edit with nano
nano .env

# Or with vim
vim .env

# Or with VS Code
code .env
```

**Required variables:**
```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz  # From @BotFather
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxx           # From OpenAI
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxx                # From Groq
```

**Optional but recommended:**
```env
ADMIN_TELEGRAM_ID=123456789                            # Your Telegram user ID
GOOGLE_MAPS_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXX    # For location features
OPENWEATHER_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # For weather
```

Save and close the file.

### 4️⃣ Create Required Directories

```bash
# Create directories for data persistence
mkdir -p data temp logs backups
```

### 5️⃣ Build and Start the Container

```bash
# Build and start in detached mode (background)
docker compose up -d --build
```

This will:
- ✅ Build the Docker image
- ✅ Start the container
- ✅ Run health checks
- ✅ Restart automatically if crashed

### 6️⃣ Verify It's Running

```bash
# Check container status
docker compose ps

# View logs (real-time)
docker compose logs -f

# Or view last 50 lines
docker compose logs --tail=50 flexai
```

You should see output like:
```
flexai-bot | Bot started successfully
flexai-bot | Listening on port 3000
flexai-bot | Database initialized
```

Press `Ctrl+C` to exit log viewing (container keeps running).

### 7️⃣ Test the Bot

Open Telegram and:
1. Find your bot by username
2. Send `/start` command
3. Send a voice message in English, Russian, or Kazakh
4. Receive task analysis and PDF report!

### 8️⃣ Check Health

```bash
# Test health endpoint
curl http://localhost:3000/health
```

Should return: `{"status":"ok"}`

---

## Common Commands

### View Logs
```bash
# Real-time logs
docker compose logs -f

# Search for errors
docker compose logs flexai | grep ERROR
```

### Stop the Bot
```bash
# Graceful stop
docker compose stop

# Stop and remove container
docker compose down
```

### Restart the Bot
```bash
docker compose restart
```

### Update the Bot
```bash
# Stop current version
docker compose down

# Pull latest code (if using git)
git pull

# Rebuild and start
docker compose up -d --build
```

### Check Resource Usage
```bash
docker stats flexai-bot
```

### Backup Database
```bash
# Create timestamped backup
cp data/flexai.db backups/flexai-$(date +%Y%m%d-%H%M%S).db
```

### Access Container Shell
```bash
docker compose exec flexai /bin/sh
```

---

## Troubleshooting

### ❌ Container Won't Start

**Check logs:**
```bash
docker compose logs flexai
```

**Common issues:**
- Missing environment variables → Check `.env` file
- Port 3000 already in use → Change `PORT` in `.env`
- Invalid API keys → Verify tokens in `.env`

### ❌ Bot Not Responding

**Verify bot is running:**
```bash
docker compose ps
```

**Check health:**
```bash
curl http://localhost:3000/health
```

**Restart:**
```bash
docker compose restart
```

### ❌ Database Errors

**Backup and reset:**
```bash
docker compose down
cp data/flexai.db data/flexai.db.backup
rm data/flexai.db-shm data/flexai.db-wal
docker compose up -d
```

### ❌ Out of Memory

**Check usage:**
```bash
docker stats flexai-bot
```

**Adjust limits in `docker-compose.yml`:**
```yaml
deploy:
  resources:
    limits:
      memory: 4G  # Increase if needed
```

Then restart:
```bash
docker compose down
docker compose up -d
```

---

## Getting Your Telegram User ID

To use admin commands like `/stats`:

1. Message [@userinfobot](https://t.me/userinfobot)
2. Copy your user ID number
3. Add to `.env`:
   ```env
   ADMIN_TELEGRAM_ID=123456789
   ```
4. Restart container:
   ```bash
   docker compose restart
   ```

---

## Production Deployment

### Using Webhook Mode

For production servers, use webhooks instead of polling:

1. **Get a domain with HTTPS** (required by Telegram)

2. **Update `.env`:**
   ```env
   WEBHOOK_DOMAIN=https://yourdomain.com
   TELEGRAM_BOT_API_SECRET_TOKEN=your_random_secret_token_here
   ```

3. **Restart:**
   ```bash
   docker compose up -d --build
   ```

4. **Verify webhook:**
   - Bot will automatically set webhook on startup
   - Check logs for confirmation

### Nginx Reverse Proxy

If running behind Nginx, add to your config:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

---

## Directory Structure After Setup

```
flexAI/
├── data/
│   ├── flexai.db         # SQLite database
│   ├── flexai.db-shm     # Shared memory file
│   └── flexai.db-wal     # Write-ahead log
├── temp/
│   └── *.ogg            # Temporary voice files
├── logs/
│   └── *.log            # Application logs
├── backups/
│   └── flexai-*.db      # Database backups
├── .env                 # Your configuration
└── docker-compose.yml   # Docker config
```

---

## Next Steps

✅ Bot is running? Great! Now you can:

1. **Test features:**
   - Voice messages (RU/EN/KK)
   - Screenshot task extraction
   - Text commands
   - `/report` and `/weekly` commands

2. **Configure integrations:**
   - Add Google Maps API key for locations
   - Add OpenWeather API key for weather

3. **Read documentation:**
   - `README.md` - Full feature documentation
   - `DOCKER.md` - Complete Docker guide
   - `DOCKER_QUICKSTART.md` - Command reference

4. **Monitor and maintain:**
   - Regular backups: `cp data/flexai.db backups/`
   - Check logs: `docker compose logs -f`
   - Update regularly: `docker compose build --no-cache`

---

## Quick Reference Card

| Action | Command |
|--------|---------|
| **Start** | `docker compose up -d` |
| **Stop** | `docker compose down` |
| **Logs** | `docker compose logs -f` |
| **Restart** | `docker compose restart` |
| **Status** | `docker compose ps` |
| **Health** | `curl localhost:3000/health` |
| **Update** | `docker compose up -d --build` |
| **Backup** | `cp data/flexai.db backups/` |

---

## Need Help?

- 📖 Full docs: `DOCKER.md`
- ⚡ Quick commands: `DOCKER_QUICKSTART.md`
- 🐛 Check logs: `docker compose logs -f`
- 💬 Telegram: Test with `/help` command

**Happy task managing! 🎉**
