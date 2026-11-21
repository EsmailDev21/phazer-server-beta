#!/usr/bin/env bash
# Type-check WITHOUT downloading Prisma engine binaries (restricted networks,
# sandboxes, some CI). Generates the client types with --no-engine using
# placeholder engine files, then runs tsc. Types only - no DB access, no runtime.
set -euo pipefail
cd "$(dirname "$0")/.."

FAKE="$(mktemp -d)"
touch "$FAKE/libquery_engine.so.node" "$FAKE/schema-engine"
chmod +x "$FAKE/schema-engine"

export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
export PRISMA_QUERY_ENGINE_LIBRARY="$FAKE/libquery_engine.so.node"
export PRISMA_SCHEMA_ENGINE_BINARY="$FAKE/schema-engine"
export DATABASE_URL="${DATABASE_URL:-postgresql://u:p@localhost:5432/db}"

npx prisma validate
npx prisma generate --no-engine
npx tsc --noEmit -p tsconfig.json
echo "OK: schema valid, client types generated, tsc clean."
