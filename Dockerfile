# Temporal's native bridge requires glibc. Build target-platform dependencies
# inside Linux; never copy host node_modules into the image.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN npm install --global pnpm@10.4.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/harness/package.json ./packages/harness/package.json
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm typecheck && pnpm build

FROM base AS runtime
LABEL org.opencontainers.image.title="Intent" \
    org.opencontainers.image.source="https://github.com/ZerothLab/intent-crm" \
    org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    INTENT_SERVE_WEB=true HOST=0.0.0.0 API_PORT=3100 TSX_DISABLE_CACHE=1
# tsx and the workflow bundler are runtime dependencies of this source-based
# workspace. Preserve the installed dependency graph instead of pruning it.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/worker ./apps/worker
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/scripts/bootstrap-admin.ts ./scripts/bootstrap-admin.ts
COPY --from=build /app/scripts/production-config.mjs ./scripts/production-config.mjs
COPY docker/smoke.mjs ./docker/smoke.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/intent-entrypoint
USER node
EXPOSE 3100
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.API_PORT+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["intent-entrypoint"]
CMD ["api"]
