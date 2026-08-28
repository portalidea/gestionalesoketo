#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${LOCAL_TEST_PG_DIR:-$ROOT_DIR/.local-test-postgres}"
DATA_DIR="$RUNTIME_DIR/data"
SOCKET_DIR="$RUNTIME_DIR/socket"
LOG_FILE="$RUNTIME_DIR/postgres.log"
PORT="${LOCAL_TEST_PG_PORT:-55432}"
DB_NAME="${LOCAL_TEST_PG_DB:-gestionalesoketo_test}"
PG_BIN="$(pg_config --bindir)"
DATABASE_URL="postgresql://postgres@127.0.0.1:${PORT}/${DB_NAME}?sslmode=disable"

mkdir -p "$RUNTIME_DIR" "$SOCKET_DIR"

is_running() {
  "$PG_BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1
}

init_cluster() {
  if [[ ! -f "$DATA_DIR/PG_VERSION" ]]; then
    mkdir -p "$DATA_DIR"
    "$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust --no-locale >/dev/null
  fi
}

start_cluster() {
  init_cluster
  if ! is_running; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" -o "-p ${PORT} -k ${SOCKET_DIR} -c listen_addresses=127.0.0.1" start >/dev/null
  fi
  for _ in $(seq 1 30); do
    if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -U postgres >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "PostgreSQL test locale non disponibile" >&2
  exit 1
}

prepare_auth_stubs() {
  "$PG_BIN/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb
);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL
}

reset_database() {
  start_cluster
  "$PG_BIN/dropdb" --if-exists -h 127.0.0.1 -p "$PORT" -U postgres "$DB_NAME"
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$DB_NAME"
  prepare_auth_stubs

  local files=(
    drizzle/0000_initial_postgres.sql
    drizzle/0001_auth_supabase.sql
    drizzle/0002_auth_supabase_integration.sql
    drizzle/0003_phase_b_m1_lots.sql
    drizzle/0004_phase_b_m2_transfer_writeoff.sql
    drizzle/0005_phase_b_m3_pricing_fic.sql
    drizzle/0006_phase_b_perf_indexes.sql
    drizzle/0007_phase_b_m5_ddt_imports.sql
    drizzle/0008_nullable_batch_expiry.sql
    drizzle/0009_product_supplier_codes.sql
    drizzle/0010_phase_b_m6_1_orders_auth.sql
    drizzle/0011_phase_b_m5_8_pieces_per_unit.sql
    drizzle/0012_m6_2b_payment_terms_order_state_machine.sql
    drizzle/0013_m7_affiliates.sql
    drizzle/0014_m7b_affiliate_users.sql
    drizzle/0015_m8_1_shopify_integration.sql
    drizzle/0016_m6_2d_event_orders.sql
    drizzle/0016_m8_1_1_bundle_support.sql
    drizzle/0017_m6_2e_warehouse_valuation.sql
    drizzle/0017_m8_4_backorder_support.sql
    drizzle/0018_m11a_multi_tenant_foundation.sql
    drizzle/migrations/0015_smart_merge_and_adjustments.sql
    drizzle/migrations/0019_retailer_pricing_model.sql
    drizzle/migrations/0020_fic_connections_per_company.sql
    drizzle/migrations/0021_fic_clients_cache.sql
    drizzle/migrations/0022_label_inventory.sql
    drizzle/migrations/0023_sales_stores_company_id.sql
    drizzle/migrations/0024_products_internal_code.sql
    drizzle/migrations/0025_tier_engine.sql
    drizzle/migrations/0026_promotions.sql
    drizzle/migrations/0027_tier_engine_retailer_opt_in.sql
    drizzle/migrations/0028_m13_expiry_alerts.sql
    drizzle/migrations/0029_m13_item_declaration_anomaly.sql
    drizzle/migrations/0030_m13_reorder_suppression.sql
    drizzle/migrations/0035_intercompany_transfer_report_indexes.sql
    drizzle/migrations/0036_shopify_import_cutoff.sql
    drizzle/migrations/0037_prospect_pricing_simulator.sql
    drizzle/migrations/0038_prospect_order_invitations_and_conversion.sql
    drizzle/migrations/0039_affiliate_manual_commissions.sql
  )

  for file in "${files[@]}"; do
    if [[ "$file" == "drizzle/0009_product_supplier_codes.sql" ]]; then
      "$PG_BIN/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'retailer_admin';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'retailer_user';
SQL
    fi
    if [[ "$file" == "drizzle/migrations/0020_fic_connections_per_company.sql" ]]; then
      "$PG_BIN/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
-- La definizione originale di ficConnections non è presente nel repository.
-- Questo stub riproduce lo schema corrente solo per permettere il replay locale.
CREATE TABLE IF NOT EXISTS "ficConnections" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  "ficCompanyId" varchar(100),
  "accessToken" text,
  "refreshToken" text,
  "tokenExpiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
SQL
    fi
    [[ -f "$ROOT_DIR/$file" ]] || { echo "Migration mancante: $file" >&2; exit 1; }
    echo "[test-db] applico $file"
    "$PG_BIN/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/$file" >/dev/null
  done
  cat > "$RUNTIME_DIR/env.sh" <<EOF
export DATABASE_URL='${DATABASE_URL}'
export LOCAL_TEST_DATABASE_URL='${DATABASE_URL}'
EOF
  echo "[test-db] reset completato"
  echo "DATABASE_URL=$DATABASE_URL"
}

case "${1:-}" in
  start) start_cluster; echo "DATABASE_URL=$DATABASE_URL" ;;
  reset) reset_database ;;
  stop) is_running && "$PG_BIN/pg_ctl" -D "$DATA_DIR" stop -m fast >/dev/null || true ;;
  url) echo "$DATABASE_URL" ;;
  *) echo "Uso: $0 {start|reset|stop|url}" >&2; exit 1 ;;
esac
