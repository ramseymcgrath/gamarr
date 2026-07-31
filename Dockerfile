FROM node:24-trixie-slim AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
RUN pnpm build \
  && mkdir -p /runtime-migrator/node_modules \
  && cp -LR node_modules/better-sqlite3 \
    /runtime-migrator/node_modules/better-sqlite3 \
  && cp -LR node_modules/drizzle-orm \
    /runtime-migrator/node_modules/drizzle-orm

FROM node:24-trixie-slim AS runner
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8989
ENV GAMARR_DATABASE_PATH=/config/gamarr.db
ENV GAMARR_MIGRATIONS_PATH=/app/drizzle
WORKDIR /app
RUN groupadd --system --gid 1001 gamarr \
  && useradd --system --uid 1001 --gid gamarr --home-dir /app gamarr \
  && mkdir -p /config \
  && chown gamarr:gamarr /config
COPY --from=builder --chown=gamarr:gamarr /build/.next/standalone ./
COPY --from=builder --chown=gamarr:gamarr /build/.next/static ./.next/static
COPY --from=builder --chown=gamarr:gamarr /build/drizzle ./drizzle
COPY --from=builder --chown=gamarr:gamarr \
  /runtime-migrator/node_modules ./node_modules
COPY --from=builder --chown=gamarr:gamarr /build/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=builder --chown=gamarr:gamarr /build/scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod 0555 /app/scripts/entrypoint.sh
USER gamarr
EXPOSE 8989
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8989/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["node", "server.js"]
