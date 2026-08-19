-- M13.B: opt-in manuale del motore tier per singolo rivenditore.
-- Default sicuro: nessun rivenditore viene valutato automaticamente finché un admin non lo abilita.

ALTER TABLE retailers
  ADD COLUMN IF NOT EXISTS tier_engine_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_retailers_tier_engine_enabled
  ON retailers ("companyId", tier_engine_enabled)
  WHERE tier_engine_enabled = true;
