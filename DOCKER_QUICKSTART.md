# 🐳 FlexAI Docker Quick Reference

Essential commands for running FlexAI with Docker.

---

## ⚡ Quick Start (3 Steps)

```bash
# 1. Setup environment
cp .env.example .env
# Edit .env with your API keys

# 2. Build and run
docker compose up -d --build

# 3. Check status
docker compose logs -f
```

---

## 📋 Daily Commands

### Start/Stop
```bash
# Start
docker compose up -d

# Stop
docker compose down

# Restart
docker compose restart
```

### Monitor
```bash
# View logs (real-time)
docker compose logs -f

# View logs (last 50 lines)
docker compose logs --tail=50 flexai

# Check status
docker compose ps

# Resource usage
docker stats flexai-bot
```

### Update
```bash
# Update bot to latest version
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Backup
```bash
# Quick backup
cp data/flexai.db backups/flexai-$(date +%Y%m%d).db
```

---

## 🔧 Troubleshooting

### Check Health
```bash
curl http://localhost:3000/health
```

### View Errors
```bash
docker compose logs flexai | grep ERROR
```

### Container Not Starting?
```bash
# Check logs first
docker compose logs flexai

# Verify config
docker compose config

# Check port availability
lsof -i :3000  # macOS/Linux
```

### Shell Access
```bash
docker compose exec flexai /bin/sh
```

---

## 📖 Full Documentation

See `DOCKER.md` for complete guide including:
- Detailed troubleshooting
- Production deployment
- Performance tuning
- Security best practices
- Advanced configurations

---

## 🎯 Common Tasks

| Task | Command |
|------|---------|
| View all tasks | Send `/report` to bot |
| Check bot health | `curl localhost:3000/health` |
| Backup database | `cp data/flexai.db backups/` |
| Clean old files | `find temp/ -mtime +7 -delete` |
| Rebuild image | `docker compose build --no-cache` |
| Stop everything | `docker compose down -v` |

---

**Need help?** Check `DOCKER.md` for detailed documentation.
