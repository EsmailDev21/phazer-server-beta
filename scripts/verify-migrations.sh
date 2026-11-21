#!/usr/bin/env bash
# Fails (exit 2) if prisma/migrations does not reproduce prisma/schema.prisma.
# Replaying every migration into a scratch "shadow" database also proves the
# whole history applies cleanly to an empty database. Use in CI and before merge.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d prisma/migrations ]; then
  echo "prisma/migrations does not exist yet - run: npm run db:baseline" >&2
  exit 1
fi

SHADOW_DATABASE_URL="${SHADOW_DATABASE_URL:-postgresql://user:password@localhost:5432/appdb_shadow?schema=public}"

# Local convenience: create the shadow DB inside the compose Postgres if it is running.
if command -v docker >/dev/null 2>&1 && docker compose ps --status running db 2>/dev/null | grep -q db; then
  docker compose exec -T db psql -U user -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='appdb_shadow'" | grep -q 1 \
    || docker compose exec -T db psql -U user -d postgres -c "CREATE DATABASE appdb_shadow" >/dev/null
fi

npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code

echo "OK: migrations and schema.prisma are in sync."
