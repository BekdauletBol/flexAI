# 🏢 Production Deployment Checklist for 30K Users

**CRITICAL:** This is a zero-error production deployment for enterprise use. Follow every step.

---

## ⚠️ Pre-Deployment Requirements

### Infrastructure Requirements

- [ ] **Minimum Server Specs:**
  - 4 vCPU cores (8 recommended)
  - 8GB RAM minimum (16GB recommended)
  - 100GB SSD storage
  - 1Gbps network
  - Ubuntu 22.04 LTS or similar

- [ ] **High Availability Setup:**
  - [ ] Load balancer configured (Nginx/HAProxy)
  - [ ] Multiple instances behind load balancer (2+ recommended)
  - [ ] Database replication enabled
  - [ ] Automated failover configured
  - [ ] CDN for static assets (if using Mini App)

- [ ] **Monitoring & Alerting:**
  - [ ] Application monitoring (Prometheus/Grafana)
  - [ ] Error tracking (Sentry/Rollbar)
  - [ ] Uptime monitoring (UptimeRobot/Pingdom)
  - [ ] Log aggregation (ELK/Loki/CloudWatch)
  - [ ] PagerDuty/OpsGenie for alerts
  - [ ] Slack/Discord webhook for notifications

- [ ] **Backup Strategy:**
  - [ ] Automated hourly backups
  - [ ] Daily full backups to S3/Cloud Storage
  - [ ] 30-day retention policy
  - [ ] Backup restoration tested monthly
  - [ ] Offsite backup location

- [ ] **Security:**
  - [ ] SSL/TLS certificates (Let's Encrypt/paid)
  - [ ] Firewall configured (UFW/iptables)
  - [ ] Fail2ban installed
  - [ ] SSH key-only access (no password)
  - [ ] Non-root deployment user
  - [ ] Secret management (Vault/AWS Secrets Manager)
  - [ ] Rate limiting at load balancer level
  - [ ] DDoS protection (Cloudflare)

---

## 🔐 Security Hardening

### 1. Environment Variables Security

**NEVER commit .env to git. Use secrets management:**

```bash
# Option 1: Docker Secrets (Swarm mode)
echo "your_token_here" | docker secret create telegram_bot_token -

# Option 2: AWS Systems Manager Parameter Store
aws ssm put-parameter --name "/flexai/telegram_token" --value "xxx" --type SecureString

# Option 3: HashiCorp Vault
vault kv put secret/flexai telegram_token="xxx"
```

### 2. Network Security

```bash
# Configure firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 80/tcp    # HTTP (redirect to HTTPS)
sudo ufw enable

# Fail2ban for brute force protection
sudo apt install fail2ban
sudo systemctl enable fail2ban
```

### 3. Docker Security

Update `docker-compose.yml` with security settings:

```yaml
security_opt:
  - no-new-privileges:true
read_only: true
tmpfs:
  - /tmp
cap_drop:
  - ALL
cap_add:
  - NET_BIND_SERVICE
```

---

## 📊 Monitoring Setup

### 1. Install Prometheus + Grafana

```bash
# Create monitoring stack
cat > docker-compose.monitoring.yml <<EOF
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
    ports:
      - "9090:9090"
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    volumes:
      - grafana_data:/var/lib/grafana
      - ./monitoring/grafana-dashboards:/etc/grafana/provisioning/dashboards
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=CHANGE_THIS_PASSWORD
      - GF_INSTALL_PLUGINS=grafana-clock-panel
    ports:
      - "3001:3000"
    restart: unless-stopped

  loki:
    image: grafana/loki:latest
    container_name: loki
    volumes:
      - ./monitoring/loki-config.yml:/etc/loki/local-config.yaml
      - loki_data:/loki
    ports:
      - "3100:3100"
    restart: unless-stopped

  promtail:
    image: grafana/promtail:latest
    container_name: promtail
    volumes:
      - /var/log:/var/log
      - ./logs:/app/logs
      - ./monitoring/promtail-config.yml:/etc/promtail/config.yml
    command: -config.file=/etc/promtail/config.yml
    restart: unless-stopped

volumes:
  prometheus_data:
  grafana_data:
  loki_data:
EOF

# Start monitoring stack
docker compose -f docker-compose.monitoring.yml up -d
```

### 2. Application Metrics Endpoint

Add to your application (already exists, verify it's working):

```bash
# Test metrics endpoint
curl http://localhost:3000/metrics

# Should return:
# - Active users count
# - Request rate
# - Error rate
# - Queue size
# - Database connections
# - Memory usage
```

---

## 🚨 Error Tracking

### 1. Sentry Integration

```bash
# Install Sentry
npm install @sentry/node @sentry/profiling-node

# Add to your .env
SENTRY_DSN=https://xxx@sentry.io/xxx
```

Add to `src/index.ts`:

```typescript
import * as Sentry from "@sentry/node";

if (process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: "production",
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
    beforeSend(event) {
      // Sanitize sensitive data
      if (event.request) {
        delete event.request.headers?.authorization;
        delete event.request.cookies;
      }
      return event;
    },
  });
}
```

---

## 🔄 High Availability Setup

### Load Balancer Configuration (Nginx)

```nginx
# /etc/nginx/sites-available/flexai
upstream flexai_backend {
    least_conn;
    server 127.0.0.1:3000 max_fails=3 fail_timeout=30s;
    server 127.0.0.1:3001 max_fails=3 fail_timeout=30s backup;
    # Add more instances as needed
}

# Rate limiting
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/m;
limit_conn_zone $binary_remote_addr zone=conn_limit:10m;

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Rate limiting
    limit_req zone=api_limit burst=50 nodelay;
    limit_conn conn_limit 10;

    # Logging
    access_log /var/log/nginx/flexai_access.log combined;
    error_log /var/log/nginx/flexai_error.log warn;

    location / {
        proxy_pass http://flexai_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Error handling
        proxy_next_upstream error timeout invalid_header http_500 http_502 http_503;
        proxy_next_upstream_tries 2;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://flexai_backend/health;
        access_log off;
    }
}

# HTTP to HTTPS redirect
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

---

## 💾 Database Optimization

### SQLite Production Tuning

Add to your application startup:

```typescript
// src/services/database.ts
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64MB cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 30000000000'); // 30GB memory map
db.pragma('page_size = 4096');
db.pragma('wal_autocheckpoint = 1000');
```

### Database Backup Script

```bash
#!/bin/bash
# /usr/local/bin/backup-flexai-db.sh

set -e

BACKUP_DIR="/backups/flexai"
DB_PATH="/app/data/flexai.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/flexai_$TIMESTAMP.db"
S3_BUCKET="s3://your-company-backups/flexai"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Create backup using SQLite backup command
sqlite3 "$DB_PATH" ".backup $BACKUP_FILE"

# Compress backup
gzip "$BACKUP_FILE"

# Upload to S3
aws s3 cp "$BACKUP_FILE.gz" "$S3_BUCKET/" --storage-class STANDARD_IA

# Keep only last 7 days locally
find "$BACKUP_DIR" -name "flexai_*.db.gz" -mtime +7 -delete

# Keep last 30 days in S3 (lifecycle policy)
# Set this in S3 bucket lifecycle rules

# Send success notification
curl -X POST https://hooks.slack.com/services/YOUR/WEBHOOK/URL \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"✅ FlexAI database backup completed: $TIMESTAMP\"}"

echo "Backup completed: $BACKUP_FILE.gz"
```

Make executable and add to crontab:

```bash
chmod +x /usr/local/bin/backup-flexai-db.sh

# Add to crontab (hourly backups)
crontab -e
0 * * * * /usr/local/bin/backup-flexai-db.sh >> /var/log/flexai-backup.log 2>&1
```

---

## 🧪 Load Testing

### Before Going Live, Test with Expected Load

```bash
# Install Apache Bench
sudo apt install apache2-utils

# Install k6 (modern load testing)
sudo snap install k6

# Create load test script
cat > load-test.js <<EOF
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 },   // Ramp up to 100 users
    { duration: '5m', target: 1000 },  // Ramp up to 1000 users
    { duration: '10m', target: 5000 }, // Ramp up to 5000 users
    { duration: '5m', target: 5000 },  // Stay at 5000 for 5 minutes
    { duration: '2m', target: 0 },     // Ramp down to 0 users
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
    http_req_failed: ['rate<0.01'],   // Error rate must be below 1%
  },
};

export default function () {
  let response = http.get('https://yourdomain.com/health');
  check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
  sleep(1);
}
EOF

# Run load test
k6 run load-test.js
```

---

## 📈 Performance Optimization

### 1. Docker Compose Production Config

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  flexai:
    container_name: flexai-bot
    build:
      context: .
      dockerfile: Dockerfile
      args:
        NODE_ENV: production
    image: flexai:production
    ports:
      - "127.0.0.1:3000:3000"  # Only bind to localhost (behind load balancer)
    env_file:
      - .env.production
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=warn  # Less verbose in production
      - PORT=3000
      - FLEXAI_DB_PATH=/app/data/flexai.db
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
      - ./logs:/app/logs:rw
    restart: always
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
    networks:
      - flexai-network
    deploy:
      resources:
        limits:
          cpus: '4.0'
          memory: 8G
        reservations:
          cpus: '2.0'
          memory: 4G
    logging:
      driver: "json-file"
      options:
        max-size: "100m"
        max-file: "10"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=1G

networks:
  flexai-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### 2. Node.js Performance Tuning

Update start command in `docker-compose.prod.yml`:

```yaml
command: ["node", "--max-old-space-size=6144", "--gc-interval=100", "dist/index.js"]
```

---

## 🔔 Alerting Setup

### Slack Webhook Integration

```bash
# Add to .env.production
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
ALERT_EMAIL=alerts@yourcompany.com
```

### Alert Script

```bash
#!/bin/bash
# /usr/local/bin/alert-on-error.sh

WEBHOOK_URL="$SLACK_WEBHOOK_URL"
LOG_FILE="/app/logs/error.log"

# Watch for errors in logs
tail -F "$LOG_FILE" | while read line; do
  if echo "$line" | grep -i "error\|fatal\|exception"; then
    # Send to Slack
    curl -X POST "$WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"🚨 FlexAI Error Detected:\n\`\`\`$line\`\`\`\"}"
    
    # Send email alert
    echo "$line" | mail -s "FlexAI Error Alert" "$ALERT_EMAIL"
  fi
done
```

---

## 📊 Metrics Dashboard

### Grafana Dashboard JSON

Create `/monitoring/grafana-dashboards/flexai.json`:

```json
{
  "dashboard": {
    "title": "FlexAI Production Metrics",
    "panels": [
      {
        "title": "Active Users",
        "targets": [{"expr": "flexai_active_users"}]
      },
      {
        "title": "Request Rate",
        "targets": [{"expr": "rate(flexai_requests_total[5m])"}]
      },
      {
        "title": "Error Rate",
        "targets": [{"expr": "rate(flexai_errors_total[5m])"}]
      },
      {
        "title": "Response Time (p95)",
        "targets": [{"expr": "histogram_quantile(0.95, flexai_request_duration_seconds_bucket)"}]
      },
      {
        "title": "Memory Usage",
        "targets": [{"expr": "process_resident_memory_bytes"}]
      },
      {
        "title": "Queue Size",
        "targets": [{"expr": "flexai_queue_size"}]
      }
    ]
  }
}
```

---

## 🚀 Deployment Procedure

### Zero-Downtime Deployment

```bash
#!/bin/bash
# /usr/local/bin/deploy-flexai.sh

set -e

echo "🚀 Starting FlexAI deployment..."

# 1. Pull latest code
cd /opt/flexai
git pull origin main

# 2. Backup current database
/usr/local/bin/backup-flexai-db.sh

# 3. Build new image
docker compose -f docker-compose.prod.yml build

# 4. Health check current instance
if ! curl -f http://localhost:3000/health; then
  echo "❌ Current instance unhealthy, aborting deployment"
  exit 1
fi

# 5. Start new instance on different port
docker compose -f docker-compose.prod.yml -p flexai-new up -d
sleep 30

# 6. Health check new instance
if ! curl -f http://localhost:3001/health; then
  echo "❌ New instance unhealthy, rolling back"
  docker compose -f docker-compose.prod.yml -p flexai-new down
  exit 1
fi

# 7. Switch load balancer to new instance
# (Update nginx config or use blue-green deployment)

# 8. Stop old instance
docker compose -f docker-compose.prod.yml down

# 9. Verify deployment
sleep 10
if curl -f http://localhost:3000/health; then
  echo "✅ Deployment successful!"
  curl -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d '{"text":"✅ FlexAI deployed successfully!"}'
else
  echo "❌ Deployment verification failed"
  exit 1
fi
```

---

## ✅ Pre-Launch Checklist

### Day Before Launch

- [ ] Load test completed successfully (5000+ concurrent users)
- [ ] All monitoring dashboards configured and tested
- [ ] Backup system tested and verified
- [ ] Disaster recovery plan documented and tested
- [ ] All team members have access to monitoring systems
- [ ] On-call rotation schedule created
- [ ] Runbook for common issues created
- [ ] SSL certificates valid for 90+ days
- [ ] Rate limiting tested and working
- [ ] Error tracking (Sentry) configured
- [ ] Log aggregation working
- [ ] Alerting tested (send test alerts)
- [ ] Database optimized and vacuumed
- [ ] All secrets in secure vault (not in .env)
- [ ] Firewall rules verified
- [ ] DDoS protection active
- [ ] CDN configured (if applicable)
- [ ] DNS configured with low TTL for quick changes
- [ ] Health check endpoints responding
- [ ] Documentation updated
- [ ] Team trained on deployment procedure

### Launch Day

- [ ] Final backup before cutover
- [ ] Monitoring dashboards open
- [ ] Team on standby
- [ ] Rollback plan ready
- [ ] Communication channels open (Slack/Teams)
- [ ] Gradual rollout (10% → 25% → 50% → 100%)
- [ ] Monitor for 1 hour after each phase
- [ ] Check error rates after each phase
- [ ] Verify all features working
- [ ] Customer support ready

### Post-Launch (First 24 Hours)

- [ ] Monitor error rates continuously
- [ ] Check response times
- [ ] Verify backup jobs running
- [ ] Review logs for anomalies
- [ ] Check database performance
- [ ] Monitor memory/CPU usage
- [ ] Verify all integrations working
- [ ] Collect user feedback
- [ ] Document any issues encountered
- [ ] Team debrief meeting

---

## 🆘 Incident Response Plan

### Severity Levels

| Level | Response Time | Description |
|-------|---------------|-------------|
| P0 - Critical | 5 minutes | Service down, data loss |
| P1 - High | 15 minutes | Major feature broken |
| P2 - Medium | 1 hour | Minor feature broken |
| P3 - Low | 1 day | Cosmetic issue |

### Incident Response Procedure

1. **Detect** - Monitoring alerts team
2. **Assess** - Determine severity
3. **Respond** - Follow runbook
4. **Communicate** - Update stakeholders
5. **Resolve** - Fix the issue
6. **Document** - Post-mortem report

---

## 📖 Runbook

See `RUNBOOK.md` for detailed troubleshooting procedures.

---

**This checklist must be completed before deploying to 30K users.**
