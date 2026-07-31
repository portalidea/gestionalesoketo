-- M13.A: Tier Engine — automatic tier downgrade/promotion for retailers
-- Apply manually in Supabase SQL Editor with BEGIN/COMMIT

BEGIN;

-- 1. Configurazione soglie per tier (una riga per tier)
CREATE TABLE IF NOT EXISTS tier_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_name varchar NOT NULL UNIQUE,
  monthly_maintenance_threshold numeric NOT NULL DEFAULT 0,
  promotion_threshold numeric,
  consecutive_months_for_downgrade int NOT NULL DEFAULT 3,
  is_active boolean NOT NULL DEFAULT true,
  "updatedAt" timestamptz DEFAULT now()
);

-- Seed default values (placeholder)
INSERT INTO tier_rules (tier_name, monthly_maintenance_threshold, promotion_threshold, consecutive_months_for_downgrade)
VALUES
  ('Starter', 0, NULL, 3),
  ('Partner', 500, 600, 3),
  ('Premium', 1500, 1800, 3),
  ('Elite', 3000, 3600, 3)
ON CONFLICT (tier_name) DO NOTHING;

-- 2. Colonne aggiuntive su retailers per tracking
ALTER TABLE retailers
  ADD COLUMN IF NOT EXISTS tier_frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consecutive_months_below int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS at_risk boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_tier_evaluation date;

-- 3. Storico cambi tier (audit)
CREATE TABLE IF NOT EXISTS tier_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailerId" uuid NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  from_tier varchar,
  to_tier varchar,
  reason varchar,
  monthly_revenue_snapshot numeric,
  "createdAt" timestamptz DEFAULT now(),
  "createdBy" uuid
);

-- 4. Storico fatturato mensile per rivenditore
CREATE TABLE IF NOT EXISTS retailer_monthly_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailerId" uuid NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  year int NOT NULL,
  month int NOT NULL,
  revenue_net numeric NOT NULL DEFAULT 0,
  tier_at_time varchar,
  threshold_at_time numeric,
  met_threshold boolean,
  UNIQUE("retailerId", year, month)
);

-- 5. Tabella simulazione per modalità observation (dry-run)
CREATE TABLE IF NOT EXISTS tier_simulation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL,
  "retailerId" uuid NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  current_tier varchar,
  would_change_to varchar,
  action varchar,
  monthly_revenue_snapshot numeric,
  consecutive_months_below int,
  reason text,
  "createdAt" timestamptz DEFAULT now()
);

-- 6. Configurazione globale motore tier (modalità observation/active)
CREATE TABLE IF NOT EXISTS tier_engine_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar NOT NULL UNIQUE,
  value varchar NOT NULL,
  "updatedAt" timestamptz DEFAULT now()
);

-- Default: observation mode
INSERT INTO tier_engine_config (key, value)
VALUES ('tier_engine_mode', 'observation')
ON CONFLICT (key) DO NOTHING;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tier_changes_retailer ON tier_changes("retailerId");
CREATE INDEX IF NOT EXISTS idx_retailer_monthly_revenue_retailer ON retailer_monthly_revenue("retailerId", year, month);
CREATE INDEX IF NOT EXISTS idx_tier_simulation_log_date ON tier_simulation_log(run_date);

COMMIT;
