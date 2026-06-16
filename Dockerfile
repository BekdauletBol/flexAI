# ============================================
# FlexAI - Telegram Voice Assistant Docker Image
# Multi-stage build for optimal size and security
# ============================================

# ---------------------------------------------
# Stage 1: Builder - Compile TypeScript
# ---------------------------------------------
FROM node:20-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY assets ./assets

# Build TypeScript to JavaScript
RUN npm run build

# Remove dev dependencies to reduce size
RUN npm prune --production

# ---------------------------------------------
# Stage 2: Production - Minimal runtime image
# ---------------------------------------------
FROM node:20-alpine

# Add labels for metadata
LABEL maintainer="FlexAI Team"
LABEL description="Telegram Voice Assistant for Task Management"
LABEL version="1.0.0"

# Install wget for healthcheck
RUN apk add --no-cache wget

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only production dependencies and built artifacts
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/public ./public
COPY --from=builder --chown=appuser:appgroup /app/assets ./assets
COPY --from=builder --chown=appuser:appgroup /app/package.json ./

# Create necessary directories with proper permissions
RUN mkdir -p /app/temp /app/data /app/logs && \
    chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose application port
EXPOSE 3000

# Health check - ensures container is responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
