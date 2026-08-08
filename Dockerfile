FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY app ./app
COPY server ./server
COPY nuxt.config.ts tsconfig.json biome.json ./
RUN bun run build

FROM oven/bun:1.3.14-alpine

WORKDIR /app

ENV CODEX_ROUTER_DATA_DIR=/data \
    CODEX_ROUTER_LISTEN_HOST=0.0.0.0 \
    NITRO_PORT=38127 \
    CODEX_ROUTER_START_ROUTER_ON_LAUNCH=true

EXPOSE 38127 38128

COPY --from=build /app/.output ./.output

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD bun -e "fetch('http://127.0.0.1:38127/healthz').then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", ".output/server/index.mjs"]
