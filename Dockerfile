# ---------------------------------------------
# Stage 1: Builder - Compile TypeScript
# ---------------------------------------------
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci
RUN npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY assets ./assets

RUN npm run build
RUN npm prune --production

# ---------------------------------------------
# Stage 2: Production - Minimal runtime image
# ---------------------------------------------
FROM node:20-alpine

LABEL maintainer="FlexAI Team"
LABEL description="Telegram Voice Assistant for Task Management"
LABEL version="1.0.0"

RUN apk add --no-cache wget python3 make g++

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/public ./public
COPY --from=builder --chown=appuser:appgroup /app/assets ./assets
COPY --from=builder --chown=appuser:appgroup /app/package.json ./

RUN npm rebuild better-sqlite3

RUN mkdir -p /app/temp /app/data /app/logs && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]