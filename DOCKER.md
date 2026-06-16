# FlexAI Docker Deployment Guide

Complete guide to building, running, and managing FlexAI using Docker.

## 📋 Prerequisites

Before you begin, ensure you have installed:

- **Docker** (version 20.10 or higher)
- **Docker Compose** (version 2.0 or higher)

Check your versions:
```bash
docker --version
docker compose version
```

## 🚀 Quick Start

### 1. Clone and Setup

```bash
# Clone the repository (if not already done)
cd flexAI

# Create environment file
cp .env.example .env
```

### 2. Configure Environment Variables

Edit `.env` file with your credentials:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
OPENAI_API_KEY=your_openai_api_key
GROQ_API_KEY=your_groq_api_key

# Optional but recommended
ADMIN_TELEGRAM_ID=your_telegram_user_id
WEBHOOK_DOMAIN=https://yourdomain.com
TELEGRAM_BOT_API_SECRET_TOKEN=your_random_secret_string

# Optional integrations
GOOGLE_MAPS_API_KEY=your_google_api_key
OPENWEATHER_API_KEY=your_weather_api_key
```

### 3. Build and Run

```bash
# Build and start the container
docker compose up -d --build
```

That's it! Your bot is now running. 🎉

---

## 📦 Docker Commands Reference

### Building

```bash
# Build the image
docker compose build

# Build without cache (fresh build)
docker compose build --no-cache

# Build with specific tag
docker build -t flexai:v1.0.0 .
```

### Running

```bash
# Start in detached mode (background)
docker compose up -d

# Start with logs visible
docker compose up

# Start and rebuild if needed
docker compose up -d --build
```

### Stopping

```bash
# Stop containers gracefully
docker compose stop

# Stop and remove containers
docker compose down

# Stop, remove, and clean volumes
docker compose down -v

# Stop, remove, clean everything (including images)
docker compose down --rmi all -v
```

### Monitoring

```bash
# View logs (real-time)
docker compose logs -f

# View logs (last 100 lines)
docker compose logs --tail=100

# View logs for specific service
docker compose logs -f flexai

# Check container status
docker compose ps

# View resource usage
docker stats flexai-bot
```

### Management

```bash
# Restart the container
docker compose restart

# Execute command inside container
docker compose exec flexai sh

# View container details
docker inspect flexai-bot

# Access interactive shell
docker compose exec flexai /bin/sh
```

---

## 🗂️ Directory Structure

```
flexAI/
├── data/              # Persistent SQLite database
│   └── flexai.db     # Auto-created on first run
├── temp/              # Temporary voice/image files
│   └── *.ogg         # Auto-cleaned
├── logs/              # Application logs (optional)
├── .env               # Your environment configuration
├── Dockerfile         # Docker image definition
└── docker-compose.yml # Docker Compose configuration
```

### Volume Mounts

The following directories are mounted for persistence:

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `./data` | `/app/data` | SQLite database storage |
| `./temp` | `/app/temp` | Temporary files (voice/images) |
| `./logs` | `/app/logs` | Application logs (optional) |

---

## 🔍 Debugging

### View Application Logs

```bash
# Real-time logs
docker compose logs -f flexai

# Filter by error level
docker compose logs flexai | grep ERROR

# Save logs to file
docker compose logs flexai > flexai-logs.txt
```

### Check Health Status

```bash
# View health check status
docker inspect --format='{{.State.Health.Status}}' flexai-bot

# View health check logs
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' flexai-bot

# Test health endpoint manually
curl http://localhost:3000/health
```

### Access Container Shell

```bash
# Interactive shell
docker compose exec flexai /bin/sh

# Run commands directly
docker compose exec flexai ls -la /app/data
docker compose exec flexai cat /app/data/flexai.db
```

### Check Resource Usage

```bash
# Real-time stats
docker stats flexai-bot

# Disk usage
docker system df
```

---

## 🔧 Troubleshooting

### Container Won't Start

**Problem:** Container exits immediately after starting

```bash
# Check logs for errors
docker compose logs flexai

# Check if ports are available
lsof -i :3000  # macOS/Linux
netstat -ano | findstr :3000  # Windows

# Verify environment variables
docker compose config
```

### Database Issues

**Problem:** Database locked or corrupted

```bash
# Stop container
docker compose down

# Backup existing database
cp data/flexai.db data/flexai.db.backup

# Remove WAL files
rm data/flexai.db-shm data/flexai.db-wal

# Restart
docker compose up -d
```

### Permission Issues

**Problem:** Cannot write to data/temp directories

```bash
# Fix permissions on host
chmod -R 755 data temp logs

# If needed, change ownership
sudo chown -R $(id -u):$(id -g) data temp logs
```

### Memory Issues

**Problem:** Container using too much memory

```bash
# Check current usage
docker stats flexai-bot

# Restart container to clear memory
docker compose restart

# Adjust memory limits in docker-compose.yml
# Edit deploy.resources.limits.memory value
```

### Network Issues

**Problem:** Cannot connect to external APIs

```bash
# Test from inside container
docker compose exec flexai wget -O- https://api.telegram.org
docker compose exec flexai wget -O- https://api.openai.com

# Check DNS resolution
docker compose exec flexai nslookup api.telegram.org
```

---

## 🔄 Updates & Maintenance

### Update to Latest Version

```bash
# Stop current container
docker compose down

# Pull latest code (if using git)
git pull

# Rebuild with latest code
docker compose build --no-cache

# Start updated container
docker compose up -d

# Verify it's running
docker compose ps
docker compose logs -f
```

### Backup Database

```bash
# Create backup
docker compose exec flexai sqlite3 /app/data/flexai.db ".backup /app/data/backup.db"

# Copy to host
docker cp flexai-bot:/app/data/backup.db ./backup-$(date +%Y%m%d).db

# Or simply copy the file
cp data/flexai.db backups/flexai-$(date +%Y%m%d).db
```

### Restore Database

```bash
# Stop container
docker compose down

# Replace database
cp backups/flexai-20240615.db data/flexai.db

# Start container
docker compose up -d
```

### Clean Up Old Data

```bash
# Remove old temp files (older than 7 days)
find temp/ -type f -mtime +7 -delete

# Remove old logs (older than 30 days)
find logs/ -type f -mtime +30 -delete

# Clean Docker system
docker system prune -f

# Remove unused images
docker image prune -a -f
```

---

## 🌐 Production Deployment

### Using Webhook Mode

For production, use webhook mode instead of polling:

1. Set environment variables in `.env`:
```bash
WEBHOOK_DOMAIN=https://yourdomain.com
TELEGRAM_BOT_API_SECRET_TOKEN=your_random_secret_string_here
```

2. Ensure your domain has valid SSL certificate

3. Restart container:
```bash
docker compose up -d --build
```

### Reverse Proxy Setup (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Environment-Specific Configs

Create multiple compose files:

```bash
# Development
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Production
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## 📊 Monitoring & Logs

### Structured Logging

Logs are in JSON format when `NODE_ENV=production`:

```bash
# Pretty print logs
docker compose logs flexai | jq '.'

# Filter by level
docker compose logs flexai | jq 'select(.level >= 40)'  # Errors only

# Filter by time
docker compose logs --since 1h flexai
```

### Health Checks

The container includes automatic health checks:

```bash
# View health status
docker compose ps

# Detailed health info
docker inspect flexai-bot | jq '.[0].State.Health'
```

### Admin Stats

Check bot statistics:

1. Send `/stats` command to the bot (must be admin)
2. Or query via API:
```bash
curl http://localhost:3000/health
```

---

## 🔐 Security Best Practices

1. **Never commit `.env` file** - Contains sensitive keys
2. **Use secrets management** - Consider Docker secrets or external vaults
3. **Regular updates** - Keep base images and dependencies updated
4. **Resource limits** - Set CPU/memory limits in docker-compose.yml
5. **Network isolation** - Use Docker networks for isolation
6. **Read-only filesystem** - Mount volumes as read-only where possible
7. **Scan images** - Use `docker scan flexai:latest` for vulnerabilities

---

## 📈 Performance Tuning

### Database Optimization

```bash
# Vacuum database to reclaim space
docker compose exec flexai sqlite3 /app/data/flexai.db "VACUUM;"

# Analyze for query optimization
docker compose exec flexai sqlite3 /app/data/flexai.db "ANALYZE;"
```

### Resource Limits

Adjust in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '2.0'        # Maximum 2 CPU cores
      memory: 2G         # Maximum 2GB RAM
    reservations:
      cpus: '0.5'        # Reserve 0.5 cores
      memory: 512M       # Reserve 512MB RAM
```

### Concurrency Settings

Edit environment variables:

```bash
# In .env
MAX_USERS=50000           # Increase user limit
CONCURRENCY=10            # Increase voice processing queue
```

---

## ❓ FAQ

**Q: How do I check if the bot is running?**
```bash
docker compose ps
curl http://localhost:3000/health
```

**Q: How do I see real-time logs?**
```bash
docker compose logs -f flexai
```

**Q: How do I restart the bot?**
```bash
docker compose restart
```

**Q: How do I update the bot?**
```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

**Q: Where is my database stored?**
```bash
./data/flexai.db
```

**Q: How do I backup my data?**
```bash
cp data/flexai.db backups/flexai-$(date +%Y%m%d).db
```

**Q: Container keeps restarting?**
```bash
docker compose logs flexai  # Check error logs
docker compose down         # Stop everything
# Fix the issue (usually .env configuration)
docker compose up -d        # Start again
```

---

## 📞 Support

If you encounter issues:

1. Check logs: `docker compose logs -f flexai`
2. Verify health: `curl http://localhost:3000/health`
3. Check environment: `docker compose config`
4. Review this guide's troubleshooting section
5. Open an issue on GitHub with logs and error details

---

## 📝 License

MIT License - See LICENSE file for details
