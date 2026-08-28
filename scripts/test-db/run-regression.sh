#!/usr/bin/env bash
set -euo pipefail

# Regressione end-to-end esclusivamente locale: resetta il database isolato
# sulla porta 55432, carica i placeholder necessari al bootstrap e avvia
# serialmente Vitest e tutti gli script testdb, inclusi i due FEFO selettivi.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${LOCAL_TEST_PG_DIR:-$ROOT_DIR/.local-test-postgres}"
cd "$ROOT_DIR"

bash scripts/test-db/local-postgres.sh reset
# shellcheck disable=SC1091
source "$RUNTIME_DIR/env.sh"

export SUPABASE_URL="https://example.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="local-placeholder"
export SUPABASE_ANON_KEY="local-placeholder"
export PROSPECT_NOTIFICATION_TO="test@example.invalid"

pnpm exec vitest run --pool=forks --poolOptions.forks.singleFork=true
pnpm run testdb:reversal
pnpm run testdb:m13-recovery
pnpm run testdb:m13-idempotency
pnpm run testdb:fefo
pnpm run testdb:intercompany
pnpm run testdb:intercompany:eketo-to-soketo
pnpm run testdb:intercompany:report
pnpm run testdb:intercompany:manual
pnpm run testdb:shopify
pnpm run testdb:prospect-simulator

echo "TESTDB_REGRESSION=PASS"
