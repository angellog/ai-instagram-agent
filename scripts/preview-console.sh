#!/usr/bin/env bash
# Local, offline preview of the console: mock LLM + mock images, a throwaway
# copy of the dev database, its own Redis db and queue prefix, no Instagram
# token (nothing can be sent). Usage: scripts/preview-console.sh [--fresh]
set -euo pipefail
cd "$(dirname "$0")/.."
DB=aia_preview
if [[ "${1:-}" == "--fresh" ]] || ! psql -lqt | cut -d '|' -f1 | grep -qw "$DB"; then
  dropdb --if-exists "$DB"
  if psql -lqt | cut -d '|' -f1 | grep -qw aia_dev; then createdb -T aia_dev "$DB"; else createdb "$DB"; fi
fi
export NODE_ENV=development ROLE=all PORT=3999 PUBLIC_BASE_URL=http://localhost:3999 \
  DATABASE_URL="postgresql://localhost:5432/$DB" REDIS_URL=redis://localhost:6379/8 QUEUE_PREFIX=aiapreview \
  LLM_PROVIDER=mock MOCK_IMAGES=true LOCAL_MEDIA_DIR=output/preview-media ENCRYPTION_KEY="$(printf '0e%.0s' {1..32})" \
  CONTENT_PLAN_CRON="0 3 1 1 *" LOG_LEVEL=warn
unset INSTAGRAM_ACCESS_TOKEN INSTAGRAM_ACCOUNT_ID ADMIN_TOKEN
exec npx tsx src/main.ts
