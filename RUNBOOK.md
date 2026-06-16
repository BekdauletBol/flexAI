# 📘 FlexAI Operations Runbook

**Purpose:** Quick reference for handling production incidents and common operational tasks.

---

## 🚨 Emergency Contacts

| Role | Name | Contact | Backup |
|------|------|---------|--------|
| On-Call Engineer | TBD | TBD | TBD |
| DevOps Lead | TBD | TBD | TBD |
| CTO/Engineering Manager | TBD | TBD | TBD |
| Telegram Bot Admin | TBD | TBD | TBD |

**Escalation Path:** On-Call → DevOps Lead → Engineering Manager → CTO

---

## 🔴 P0 - Critical Incidents

### Bot Completely Down (No Response)

**Symptoms:**
- Health check failing
- No responses in Telegram
- Users reporting bot is dead

**Diagnosis:**
```bash
# Check if container is running
docker compose ps

# Check logs for fatal errors
docker compose logs --tail=100 flexai | grep -i "fatal\|error"

# Check system resources
docker stats flexai-bot
free -h
df -h

# Test health endpoint
curl -v http://localhost:3000/health
```

**Fix:**
```bash
# Option 1: Quick restart
docker compose restart

# Option 2: If restart fails, redeploy
docker compose down
docker compose up -d --build

# Option 3: Rollback to previous version
docker compose down
git checkout <previous-commit>
docker compose up -d --build
```

**Notify:**
```bash
# Send alert to Slack
curl -X POST $SLACK_WEBHOOK_URL \
  -d '{"text":"🚨 P0: FlexAI bot is DOWN. Investigating..."}'
```

---

### Database Corruption

**Symptoms:**
- "database disk image is malformed"
- SQLite errors in logs
- Data integrity errors

**Diagnosis:**
```bash
# Check database integrity
docker compose exec flexai sqlite3 /app/data/flexai.db "PRAGMA integrity_check;"
```

**Fix:**
```bash
# 1. STOP THE BOT IMMEDIATELY
docker compose down

# 2. Backup corrupted database
cp data/flexai.db data/flexai.db.corrupted

# 3. Try to recover
sqlite3 data/flexai.db.corrupted ".recover" | sqlite3 data/flexai.db.recovered

# 4. If recovery works, use recovered database
mv data/flexai.db.recovered data/flexai.db

# 5. If recovery fails, restore from latest backup
aws s3 cp s3://your-backups/flexai/flexai_YYYYMMDD_HHMMSS.db.gz .
gunzip flexai_YYYYMMDD_HHMMSS.db.gz
mv flexai_YYYYMMDD_HHMMSS.db data/flexai.db

# 6. Restart bot
docker compose up -d

# 7. Verify data integrity
docker compose exec flexai sqlite3 /app/data/flexai.db "PRAGMA integrity_check;"
```

---

### Out of Memory (OOM)

**Symptoms:**
- Container keeps restarting
- "JavaScript heap out of memory"
- Slow response times

**Diagnosis:**
```bash
# Check memory usage
docker stats flexai-bot

# Check logs for OOM errors
docker compose logs flexai | grep -i "memory\|heap"

# Check system memory
free -h
```

**Fix:**
```bash
# Quick fix: Restart to clear memory
docker compose restart

# Permanent fix: Increase memory limit in docker-compose.yml
# Edit docker-compose.yml:
#   limits:
#     memory: 8G  # Increase from 2G

# Apply changes
docker compose down
docker compose up -d
```

---

### API Rate Limits Hit (OpenAI/Groq)

**Symptoms:**
- 429 errors in logs
- "Rate limit exceeded"
- Bot responding slowly or not at all

**Diagnosis:**
```bash
# Check logs for rate limit errors
docker compose logs flexai | grep -i "rate limit\|429"

# Check current queue size
curl http://localhost:3000/metrics | grep queue_size
```

**Fix:**
```bash
# Option 1: Enable LLM fallback in .env
# GROQ_API_KEY=your_groq_key  # Use Groq as fallback

# Option 2: Increase OpenAI tier/limits at platform.openai.com

# Option 3: Implement request throttling (temporary)
# Reduce MAX_USERS or add cooldown period

# Notify users
# Send message via bot admin account: "Service temporarily limited"
```

---

## 🟠 P1 - High Priority Incidents

### Telegram Webhook Not Working

**Symptoms:**
- Bot not receiving messages
- Webhook returning errors
- Logs show connection issues

**Diagnosis:**
```bash
# Check webhook status
curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo

# Check if port is accessible
curl https://yourdomain.com/webhook

# Check nginx logs
sudo tail -f /var/log/nginx/error.log
```

**Fix:**
```bash
# Delete and recreate webhook
curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook

# Restart bot (it will auto-set webhook)
docker compose restart

# Verify webhook is set
curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo
```

---

### Database Locked

**Symptoms:**
- "database is locked"
- Slow queries
- Write failures

**Diagnosis:**
```bash
# Check for long-running queries
docker compose exec flexai sqlite3 /app/data/flexai.db "PRAGMA wal_checkpoint(FULL);"

# Check WAL file size
ls -lh data/
```

**Fix:**
```bash
# Checkpoint WAL
docker compose exec flexai sqlite3 /app/data/flexai.db "PRAGMA wal_checkpoint(RESTART);"

# If that fails, restart bot
docker compose restart

# Verify WAL mode is enabled
docker compose exec flexai sqlite3 /app/data/flexai.db "PRAGMA journal_mode;"
# Should return: wal
```

---

### High Error Rate (>1%)

**Symptoms:**
- Grafana showing error spike
- Users reporting issues
- Sentry showing high error count

**Diagnosis:**
```bash
# Check error logs
docker compose logs flexai | grep -i error | tail -50

# Check error rate
curl http://localhost:3000/metrics | grep error_rate

# Check which endpoint is failing
docker compose logs flexai | grep "POST\|GET" | grep "500\|502\|503"
```

**Fix:**
```bash
# Identify root cause from logs
# Common fixes:

# 1. External API timeout - increase timeout
# 2. Database slow - optimize queries
# 3. Memory leak - restart container
# 4. Code bug - rollback or hotfix

# Temporary mitigation: Restart
docker compose restart
```

---

## 🟡 P2 - Medium Priority

### Slow Response Times

**Symptoms:**
- Bot responses delayed
- Users complaining about slowness
- High p95 latency in Grafana

**Diagnosis:**
```bash
# Check response times
curl -w "@curl-format.txt" -o /dev/null -s http://localhost:3000/health

# Create curl-format.txt:
echo "time_total: %{time_total}\n" > curl-format.txt

# Check CPU usage
docker stats flexai-bot

# Check queue size
curl http://localhost:3000/metrics | grep queue
```

**Fix:**
```bash
# Option 1: Scale horizontally (add more instances)
# Copy docker-compose.yml and run on port 3001

# Option 2: Optimize database
docker compose exec flexai sqlite3 /app/data/flexai.db "VACUUM;"
docker compose exec flexai sqlite3 /app/data/flexai.db "ANALYZE;"

# Option 3: Clear old data
docker compose exec flexai sqlite3 /app/data/flexai.db \
  "DELETE FROM todos WHERE done = 1 AND created_at < datetime('now', '-30 days');"

# Option 4: Restart to clear memory
docker compose restart
```

---

### Disk Space Running Low

**Symptoms:**
- Alerts showing <10% disk space
- Logs growing large
- Database writes failing

**Diagnosis:**
```bash
# Check disk usage
df -h

# Check largest directories
du -sh /var/log/* /opt/flexai/* | sort -hr | head -20

# Check log files
ls -lh /var/log/nginx/
ls -lh /opt/flexai/logs/
```

**Fix:**
```bash
# Clean old logs
sudo find /var/log -name "*.gz" -mtime +30 -delete
sudo find /opt/flexai/logs -name "*.log" -mtime +7 -delete

# Clean old temp files
sudo find /opt/flexai/temp -mtime +1 -delete

# Clean old backups
sudo find /backups/flexai -name "*.db.gz" -mtime +7 -delete

# Clean Docker
docker system prune -af --volumes

# Rotate logs immediately
sudo logrotate -f /etc/logrotate.conf
```

---

## 🔧 Common Operational Tasks

### Deploy New Version

```bash
# 1. Create maintenance announcement (optional)
# Send message to all users via admin bot

# 2. Backup current state
/usr/local/bin/backup-flexai-db.sh

# 3. Pull latest code
cd /opt/flexai
git pull origin main

# 4. Build new image
docker compose build

# 5. Deploy with zero downtime
/usr/local/bin/deploy-flexai.sh

# 6. Verify deployment
curl http://localhost:3000/health
docker compose logs --tail=50 flexai

# 7. Monitor for 30 minutes
watch -n 10 'curl -s http://localhost:3000/health && docker stats --no-stream flexai-bot'
```

---

### Rollback Deployment

```bash
# 1. Find previous working commit
git log --oneline -10

# 2. Checkout previous version
git checkout <commit-hash>

# 3. Rebuild and deploy
docker compose down
docker compose build
docker compose up -d

# 4. Verify
curl http://localhost:3000/health
docker compose logs --tail=50 flexai
```

---

### Add New User to Whitelist

```bash
# Edit .env
nano .env

# Add user ID to ALLOWED_USER_ID (comma-separated)
ALLOWED_USER_ID=123456,789012,345678

# Restart bot
docker compose restart
```

---

### Increase User Limit

```bash
# Edit .env
nano .env

# Change MAX_USERS
MAX_USERS=50000

# Restart bot
docker compose restart

# Verify
docker compose logs flexai | grep "MAX_USERS"
```

---

### Manually Backup Database

```bash
# Create timestamped backup
timestamp=$(date +%Y%m%d_%H%M%S)
docker compose exec flexai sqlite3 /app/data/flexai.db ".backup /app/data/backup_$timestamp.db"

# Copy to host
docker cp flexai-bot:/app/data/backup_$timestamp.db ./backups/

# Upload to S3
aws s3 cp ./backups/backup_$timestamp.db s3://your-backups/flexai/

# Verify backup integrity
sqlite3 ./backups/backup_$timestamp.db "PRAGMA integrity_check;"
```

---

### Restore Database from Backup

```bash
# 1. STOP BOT
docker compose down

# 2. Backup current database (just in case)
cp data/flexai.db data/flexai.db.before-restore

# 3. Download backup from S3
aws s3 cp s3://your-backups/flexai/flexai_YYYYMMDD_HHMMSS.db.gz .
gunzip flexai_YYYYMMDD_HHMMSS.db.gz

# 4. Replace current database
mv flexai_YYYYMMDD_HHMMSS.db data/flexai.db

# 5. Verify integrity
sqlite3 data/flexai.db "PRAGMA integrity_check;"

# 6. Start bot
docker compose up -d

# 7. Verify functionality
curl http://localhost:3000/health
docker compose logs --tail=50 flexai
```

---

### View User Statistics

```bash
# Get total users
docker compose exec flexai sqlite3 /app/data/flexai.db \
  "SELECT COUNT(DISTINCT user_id) FROM users;"

# Get active users (last 7 days)
docker compose exec flexai sqlite3 /app/data/flexai.db \
  "SELECT COUNT(DISTINCT user_id) FROM plan_history WHERE created_at > datetime('now', '-7 days');"

# Get total tasks
docker compose exec flexai sqlite3 /app/data/flexai.db \
  "SELECT COUNT(*) FROM todos;"

# Get tasks by priority
docker compose exec flexai sqlite3 /app/data/flexai.db \
  "SELECT priority, COUNT(*) FROM todos GROUP BY priority;"
```

---

### Clear User Data (GDPR Request)

```bash
# Replace USER_ID with actual user ID
USER_ID=123456789

# Delete all user data
docker compose exec flexai sqlite3 /app/data/flexai.db <<EOF
DELETE FROM users WHERE user_id = $USER_ID;
DELETE FROM plans WHERE user_id = $USER_ID;
DELETE FROM plan_history WHERE user_id = $USER_ID;
DELETE FROM todos WHERE user_id = $USER_ID;
EOF

# Verify deletion
docker compose exec flexai sqlite3 /app/data/flexai.db \
  "SELECT COUNT(*) FROM users WHERE user_id = $USER_ID;"
# Should return: 0
```

---

## 📊 Monitoring Queries

### Check System Health

```bash
#!/bin/bash
# health-check.sh

echo "=== Docker Container Status ==="
docker compose ps

echo -e "\n=== Health Endpoint ==="
curl -s http://localhost:3000/health | jq .

echo -e "\n=== Memory Usage ==="
docker stats --no-stream flexai-bot

echo -e "\n=== Disk Usage ==="
df -h / /opt/flexai

echo -e "\n=== Database Size ==="
du -sh data/flexai.db*

echo -e "\n=== Recent Errors ==="
docker compose logs --since 1h flexai | grep -i error | tail -10

echo -e "\n=== Queue Status ==="
curl -s http://localhost:3000/metrics | grep queue
```

---

### Performance Metrics

```bash
# Response time test
for i in {1..10}; do
  curl -w "Response time: %{time_total}s\n" -o /dev/null -s http://localhost:3000/health
  sleep 1
done

# Error rate (last hour)
docker compose logs --since 1h flexai | grep -c "error" | \
  awk '{printf "Errors in last hour: %d\n", $1}'

# Request rate (approximate)
docker compose logs --since 5m flexai | grep -c "POST\|GET" | \
  awk '{printf "Requests per minute: %.1f\n", $1/5}'
```

---

## 🔍 Debugging Tools

### Enable Debug Logging

```bash
# Temporarily enable debug mode
docker compose exec flexai sh -c 'export LOG_LEVEL=debug && pkill -HUP node'

# Or restart with debug
docker compose down
echo "LOG_LEVEL=debug" >> .env
docker compose up -d

# Tail debug logs
docker compose logs -f flexai
```

---

### Interactive Database Query

```bash
# Open SQLite shell
docker compose exec flexai sqlite3 /app/data/flexai.db

# Useful queries:
sqlite> .tables
sqlite> .schema todos
sqlite> SELECT * FROM todos WHERE user_id = 123456 LIMIT 10;
sqlite> SELECT COUNT(*), priority FROM todos GROUP BY priority;
sqlite> .quit
```

---

### Memory Profiling

```bash
# Get heap snapshot
docker compose exec flexai node --expose-gc -e "require('v8').writeHeapSnapshot()"

# Copy snapshot to host
docker cp flexai-bot:/app/Heap.*.heapsnapshot ./

# Analyze with Chrome DevTools:
# 1. Open Chrome DevTools
# 2. Go to Memory tab
# 3. Load heap snapshot
```

---

## 📞 Escalation Procedures

### When to Escalate

**Immediate Escalation (within 5 minutes):**
- P0 incidents lasting >15 minutes
- Data loss or corruption
- Security breach suspected
- Multiple P1 incidents simultaneously

**Standard Escalation (within 30 minutes):**
- P1 incidents lasting >1 hour
- Unusual behavior not covered in runbook
- Need for architectural changes

**Scheduled Escalation:**
- P2/P3 incidents during business hours
- Feature requests
- Optimization needs

---

## 📝 Post-Incident Report Template

```markdown
# Incident Report: [Brief Description]

**Date:** YYYY-MM-DD
**Severity:** P0/P1/P2/P3
**Duration:** HH:MM
**Reporter:** Name

## Summary
Brief description of what happened

## Timeline
- HH:MM - Incident detected
- HH:MM - Investigation started
- HH:MM - Root cause identified
- HH:MM - Fix applied
- HH:MM - Service restored
- HH:MM - Incident closed

## Root Cause
Technical explanation of what caused the issue

## Resolution
How the issue was fixed

## Impact
- Users affected: X
- Downtime: X minutes
- Data loss: None/Partial/Complete

## Action Items
- [ ] Item 1 - Owner - Due Date
- [ ] Item 2 - Owner - Due Date

## Prevention
How to prevent this in the future
```

---

**Last Updated:** $(date +%Y-%m-%d)
**Maintained by:** DevOps Team
