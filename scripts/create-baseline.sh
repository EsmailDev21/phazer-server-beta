#!/usr/bin/env bash
# Regenerates prisma/migrations/ from scratch using Prisma's own schema-engine
# (i.e. the normal `prisma migrate dev` path). NOT needed for day-to-day work.
#
# A baseline migration already exists at
# prisma/migrations/20260101000000_baseline/ (hand-authored + verified against
# a real Postgres — see its README-BASELINE.md). This script exists only in
# case that history ever needs to be thrown away and regenerated for real,
# e.g. to double check the hand-authored one, once you have normal network
# access (Prisma downloads its engines from binaries.prisma.sh).
#
# Requires Docker and normal network access.
# Refuses to run while prisma/migrations/ is non-empty, to avoid accidentally
# discarding history - delete it first if you really mean to regenerate.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "prisma/migrations already exists (see 20260101000000_baseline/README-BASELINE.md)." >&2
  echo "Delete it first if you intend to regenerate the whole history from scratch." >&2
  exit 1
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://user:password@localhost:5432/appdb?schema=public}"

echo "==> Starting local Postgres"
docker compose up -d --wait db

echo "==> Validating schema"
npx prisma validate

echo "==> Creating baseline migration"
npx prisma migrate dev --name baseline --skip-seed

echo "==> Verifying migrations reproduce the schema exactly"
bash scripts/verify-migrations.sh

cat <<'MSG'

Baseline created. Next:
  1. git add prisma/migrations && git commit -m "db: baseline migration"
  2. From now on, change schema.prisma and run:  npm run db:migrate:dev -- --name <what_changed>
  3. Never edit a migration that has been merged - add a new one instead.
MSG
