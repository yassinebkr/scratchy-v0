# ============================================
# Scratchy — Production Docker Image
# ============================================
# Minimal, secure, single-purpose container.
# No dev dependencies, no source code leaks.
#
# Build:  docker build -t scratchy .
# Run:    docker run -p 3001:3001 -e SCRATCHY_TOKEN=your-token scratchy
# ============================================

FROM node:22-alpine AS production

# Labels
LABEL maintainer="yassinebkr"
LABEL version="0.1.0"
LABEL description="Scratchy — Generative UI client for OpenClaw agents"

# Security: create non-root user
RUN addgroup -g 1001 -S scratchy && \
    adduser -u 1001 -S scratchy -G scratchy

# Working directory
WORKDIR /app

# Copy dependency files first (cache layer)
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev && \
    npm cache clean --force

# Copy application files (no src-tauri, no .git, no node_modules)
COPY serve.js ./
COPY web/ ./web/

# Own everything by scratchy user
RUN chown -R scratchy:scratchy /app

# Switch to non-root user
USER scratchy

# Expose port
EXPOSE 3001

# Healthcheck: 401 = server is running (auth required)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/ 2>&1 | grep -q "401\|200" || exit 1

# Start
CMD ["node", "serve.js"]
