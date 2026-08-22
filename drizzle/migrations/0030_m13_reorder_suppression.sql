BEGIN;

ALTER TABLE expiry_alert_settings
  ADD COLUMN IF NOT EXISTS reorder_tolerance_days integer NOT NULL DEFAULT 7;

ALTER TABLE expiry_alert_settings
  DROP CONSTRAINT IF EXISTS expiry_alert_settings_reorder_tolerance_check;

ALTER TABLE expiry_alert_settings
  ADD CONSTRAINT expiry_alert_settings_reorder_tolerance_check
  CHECK (reorder_tolerance_days BETWEEN 0 AND 90);

CREATE TABLE IF NOT EXISTS expiry_alert_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES expiry_alert_runs(id) ON DELETE CASCADE,
  retailer_id uuid REFERENCES retailers(id) ON DELETE SET NULL,
  retailer_name text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  old_batch_id uuid REFERENCES "productBatches"(id) ON DELETE SET NULL,
  old_batch_code text NOT NULL,
  old_delivery_at timestamptz NOT NULL,
  new_batch_id uuid REFERENCES "productBatches"(id) ON DELETE SET NULL,
  new_batch_code text NOT NULL,
  new_delivery_at timestamptz NOT NULL,
  tolerance_days integer NOT NULL,
  reason text NOT NULL DEFAULT 'reorder_suppression',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expiry_alert_suppressions_tolerance_check CHECK (tolerance_days BETWEEN 0 AND 90),
  CONSTRAINT expiry_alert_suppressions_reason_check CHECK (reason = 'reorder_suppression')
);

CREATE INDEX IF NOT EXISTS idx_expiry_alert_suppressions_run
  ON expiry_alert_suppressions(run_id);

CREATE INDEX IF NOT EXISTS idx_expiry_alert_suppressions_retailer_product
  ON expiry_alert_suppressions(retailer_id, product_id);

ALTER TABLE expiry_alert_suppressions ENABLE ROW LEVEL SECURITY;

COMMIT;
