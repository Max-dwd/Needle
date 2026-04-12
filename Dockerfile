# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS base

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    yt-dlp \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci

COPY next.config.ts tsconfig.json postcss.config.mjs next-env.d.ts ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY browser-runtime ./browser-runtime
COPY browser-bridge ./browser-bridge

RUN npm run browser:prepare \
  && npm run build:docker \
  && npm prune --omit=dev \
  && npm install --no-save --ignore-scripts typescript

FROM base AS runner

ENV NODE_ENV=production \
  PORT=3000 \
  DATA_ROOT=/app/data \
  DATABASE_PATH=/app/data/folo.db \
  SUBTITLE_ROOT=/app/data/subtitles \
  SUMMARY_ROOT=/app/data/summaries \
  SUMMARY_MD_ROOT=/app/data/summary-md

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/browser-runtime/package.json ./browser-runtime/package.json
COPY --from=build /app/browser-runtime/needle-browser-local ./browser-runtime/needle-browser-local
COPY --from=build /app/browser-runtime/folo-browser-local ./browser-runtime/folo-browser-local
COPY --from=build /app/browser-runtime/dist ./browser-runtime/dist
COPY --from=build /app/browser-bridge/extension ./browser-bridge/extension

RUN mkdir -p /app/data

EXPOSE 3000 19825

CMD ["./node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
