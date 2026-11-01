# =============================================================================
# Build Stage
# =============================================================================
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src

# Run esbuild postinstall only if needed on non-standard arch, then build SPA + server
RUN node node_modules/esbuild/install.js || true
RUN npm run build

# =============================================================================
# Production Runtime Stage (Zero C++ build dependencies — uses built-in node:sqlite)
# =============================================================================
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/apple-stock.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/data ./src/data

RUN mkdir -p /data && chown -R node:node /app /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server/server/index.js"]
