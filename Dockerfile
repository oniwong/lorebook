# syntax=docker/dockerfile:1
# Builds the Lorebook app image. Build on a connected machine; the result runs fully offline.

FROM node:22.23.5-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && node scripts/check-offline.mjs web/dist

FROM node:22.23.5-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false && npm cache clean --force

FROM node:22.23.5-bookworm-slim
ENV NODE_ENV=production \
    WEB_DIST=/app/web/dist \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/server/drizzle ./server/drizzle
COPY --from=build /src/web/dist ./web/dist
RUN printf '#!/bin/sh\nexec node /app/server/dist/cli.js "$@"\n' > /usr/local/bin/lorebook \
    && chmod +x /usr/local/bin/lorebook \
    && mkdir -p /data/attachments /data/backups /data/export \
    && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
