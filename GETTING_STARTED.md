# 🎯 Getting Started with FlexAI

**Welcome!** This guide helps you get FlexAI up and running in under 5 minutes.

---

## 📚 Documentation Overview

FlexAI comes with comprehensive documentation:

| Document | Purpose | When to Use |
|----------|---------|-------------|
| **[HOW_TO_RUN.md](HOW_TO_RUN.md)** | Complete step-by-step setup guide | **START HERE** - First time setup |
| **[DOCKER_QUICKSTART.md](DOCKER_QUICKSTART.md)** | Essential Docker commands | Daily operations cheat sheet |
| **[DOCKER.md](DOCKER.md)** | Full Docker reference | Troubleshooting, production, advanced |
| **[README.md](README.md)** | Complete feature documentation | Understanding features & architecture |
| **[AGENTS.md](AGENTS.md)** | Technical implementation details | Development & code understanding |

---

## ⚡ Ultra-Quick Start (3 Commands)

If you already have Docker installed and API keys ready:

```bash
# 1. Setup
cp .env.example .env && nano .env

# 2. Run
docker compose up -d --build

# 3. Monitor
docker compose logs -f
```

That's it! Open Telegram and send `/start` to your bot. 🎉

---

## 📋 Prerequisites Checklist

Before starting, ensure you have:

- [ ] **Docker Desktop** installed
  - Download: https://www.docker.com/products/docker-desktop
  - Verify: `docker --version`

- [ ] **Telegram Bot Token**
  - Get from: [@BotFather](https://t.me/botfather)
  - Command: `/newbot`

- [ ] **OpenAI API Key**
  - Get from: https://platform.openai.com/api-keys
  - Required for task analysis

- [ ] **Groq API Key**
  - Get from: https://console.groq.com/keys
  - Required for voice transcription

- [ ] **Text Editor** (nano, vim, VS Code, or any)

---

## 🚀 First Time Setup (5 Minutes)

### Step 1: Clone/Download Project

```bash
cd ~/Desktop  # or wherever you want
# If using git:
git clone <repository-url> flexAI
cd flexAI

# If downloaded as ZIP:
unzip flexAI.zip
cd flexAI
```

### Step 2: Configure Environment

```bash
# Create environment file
cp .env.example .env

# Edit with your preferred editor
nano .env
# OR
code .env
# OR
vim .env
```

Fill in these **required** values:
```env
TELEGRAM_BOT_TOKEN=your_token_here
OPENAI_API_KEY=your_openai_key_here
GROQ_API_KEY=your_groq_key_here
```

Save and exit (in nano: `Ctrl+X`, then `Y`, then `Enter`).

### Step 3: Create Directories

```bash
mkdir -p data temp logs backups
```

### Step 4: Build and Start

```bash
docker compose up -d --build
```

This takes 2-3 minutes on first run (building image).

### Step 5: Verify Running

```bash
# Check status
docker compose ps

# Should show:
# NAME         STATUS        PORTS
# flexai-bot   Up (healthy)  0.0.0.0:3000->3000/tcp
```

### Step 6: Test Bot

1. Open Telegram
2. Find your bot by username (the one you created with @BotFather)
3. Send `/start`
4. Send a voice message: *"Tomorrow at 3pm I have a meeting with John"*
5. Receive task analysis and PDF! 🎉

---

## 🎮 Daily Usage

### Starting/Stopping

```bash
# Start bot
docker compose up -d

# Stop bot
docker compose down

# Restart bot
docker compose restart
```

### Monitoring

```bash
# View logs (real-time)
docker compose logs -f

# Press Ctrl+C to exit (bot keeps running)
```

### Health Check

```bash
curl http://localhost:3000/health
# Should return: {"status":"ok"}
```

---

## 🤖 Bot Commands

Once your bot is running, use these Telegram commands:

| Command | What it Does |
|---------|--------------|
| `/start` | Show welcome message |
| `/help` | Show help information |
| `/report` | Generate AI-powered task report (PDF) |
| `/weekly` | Get summary of past 7 days |
| `/clear` | Archive all completed tasks |
| `/language` | Switch language (RU/EN/KK) |
| `/stats` | Admin only: view system statistics |

### Voice Messages

Just record and send! The bot understands:
- 🇷🇺 Russian
- 🇬🇧 English
- 🇰🇿 Kazakh

### Screenshots

Send a screenshot of:
- Calendar apps
- To-do lists
- Teams/Slack messages
- Notion pages

Bot extracts tasks automatically!

### Text Messages

Type naturally:
- "Add task: buy groceries tomorrow at 5pm"
- "What do I have scheduled today?"
- "Reschedule the meeting to 3pm"

---

## 🔍 Troubleshooting

### Problem: Container won't start

```bash
# Check what's wrong
docker compose logs flexai

# Common fixes:
# 1. Check .env file has all required keys
# 2. Check port 3000 is not in use: lsof -i :3000
# 3. Verify Docker is running: docker ps
```

### Problem: Bot not responding in Telegram

```bash
# 1. Check if container is running
docker compose ps

# 2. Check logs for errors
docker compose logs flexai | grep ERROR

# 3. Restart
docker compose restart

# 4. Test health endpoint
curl http://localhost:3000/health
```

### Problem: Permission denied on data/temp

```bash
# Fix permissions
chmod -R 755 data temp logs
docker compose restart
```

### Still Having Issues?

See **[DOCKER.md](DOCKER.md)** for detailed troubleshooting guide.

---

## 📖 Learn More

### Feature Documentation

Read **[README.md](README.md)** to learn about:
- Voice transcription pipeline
- Screenshot task extraction
- Long-term memory
- Location assistant
- PDF report generation
- Mini App (WebApp)
- All 20+ features

### Docker Deep Dive

Read **[DOCKER.md](DOCKER.md)** for:
- Production deployment
- Webhook setup
- Reverse proxy configuration
- Performance tuning
- Security best practices
- Backup strategies

### Quick Reference

Keep **[DOCKER_QUICKSTART.md](DOCKER_QUICKSTART.md)** handy for:
- Essential commands
- Common tasks
- Quick troubleshooting
- Daily operations

---

## 🎯 Common Tasks Reference

| Task | Command |
|------|---------|
| View live logs | `docker compose logs -f` |
| Check if running | `docker compose ps` |
| Restart bot | `docker compose restart` |
| Update bot | `docker compose build --no-cache && docker compose up -d` |
| Backup database | `cp data/flexai.db backups/backup-$(date +%Y%m%d).db` |
| View resource usage | `docker stats flexai-bot` |
| Access container shell | `docker compose exec flexai /bin/sh` |

---

## 🌟 Next Steps

Now that your bot is running:

1. **Test all features:**
   - ✅ Voice messages in different languages
   - ✅ Screenshot task extraction
   - ✅ Text commands
   - ✅ `/report` and `/weekly` commands
   - ✅ Reminders and notifications

2. **Optional integrations:**
   - Add `GOOGLE_MAPS_API_KEY` for location features
   - Add `OPENWEATHER_API_KEY` for weather
   - Set `ADMIN_TELEGRAM_ID` for admin commands

3. **Production setup:**
   - Set up webhook mode (see DOCKER.md)
   - Configure reverse proxy
   - Set up automated backups
   - Monitor with logging tools

4. **Customize:**
   - Adjust resource limits in docker-compose.yml
   - Configure user limits
   - Tune performance settings

---

## 💡 Pro Tips

1. **Regular Backups:**
   ```bash
   # Add to crontab for daily backups
   0 2 * * * cp ~/flexAI/data/flexai.db ~/flexAI/backups/flexai-$(date +\%Y\%m\%d).db
   ```

2. **Monitor Logs:**
   ```bash
   # Watch for errors
   docker compose logs -f | grep -i error
   ```

3. **Update Regularly:**
   ```bash
   # Weekly update routine
   git pull && docker compose build --no-cache && docker compose up -d
   ```

4. **Clean Old Files:**
   ```bash
   # Monthly cleanup
   find temp/ -mtime +30 -delete
   find logs/ -mtime +30 -delete
   ```

---

## 🆘 Getting Help

1. **Check Documentation:**
   - HOW_TO_RUN.md - Setup guide
   - DOCKER.md - Complete reference
   - README.md - Feature documentation

2. **Check Logs:**
   ```bash
   docker compose logs -f
   ```

3. **Test Health:**
   ```bash
   curl http://localhost:3000/health
   docker compose ps
   ```

4. **Common Solutions:**
   - Restart: `docker compose restart`
   - Rebuild: `docker compose build --no-cache`
   - Fresh start: `docker compose down && docker compose up -d --build`

5. **Still Stuck?**
   - Check GitHub issues
   - Review DOCKER.md troubleshooting section
   - Collect logs: `docker compose logs > debug.log`

---

## 🎉 You're All Set!

Your FlexAI bot is now running and ready to help you manage tasks via voice messages, screenshots, and text!

**Quick test:** Send your bot a voice message in Telegram and watch the magic happen! 🚀

---

**Documentation Tree:**
```
📁 FlexAI/
├── 📄 GETTING_STARTED.md  ← YOU ARE HERE
├── 📄 HOW_TO_RUN.md       ← Detailed setup steps
├── 📄 DOCKER_QUICKSTART.md ← Command cheat sheet
├── 📄 DOCKER.md           ← Complete Docker guide
├── 📄 README.md           ← Feature documentation
└── 📄 AGENTS.md           ← Technical details
```

**Happy task managing! ✨**
