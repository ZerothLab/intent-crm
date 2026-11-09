#!/bin/sh
set -eu
# Every image entry point has the same production boundary; no dev-session fallback.
export NODE_ENV=production INTENT_AUTH_MODE=password INTENT_DEV_AUTH=false
case "${1:-api}" in
  api|worker) node scripts/production-config.mjs ;;
  migrate|bootstrap) node scripts/production-config.mjs database ;;
esac
case "${1:-api}" in
  api) exec node --import tsx apps/api/src/index.ts ;;
  worker) exec node --import tsx apps/worker/src/index.ts ;;
  migrate) exec node --import tsx packages/database/src/migrate.ts ;;
  bootstrap) shift; exec node --import tsx scripts/bootstrap-admin.ts "$@" ;;
  check) exec node scripts/production-config.mjs ;;
  *) echo 'Usage: api | worker | migrate | bootstrap [--password-stdin] | check' >&2; exit 64 ;;
esac
