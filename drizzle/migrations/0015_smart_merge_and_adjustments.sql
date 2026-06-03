-- M6.2.F: Smart merge arrivi stesso lotto + rettifica quantità admin
-- ADJUSTMENT already exists in stock_movement_type enum, reuse it.

-- 1) Enum motivi rettifica
DO $$ BEGIN
  CREATE TYPE adjustment_reason_enum AS ENUM (
    'typo','recount','damage','loss','found','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) Aggiungi colonne
ALTER TABLE "stockMovements"
  ADD COLUMN IF NOT EXISTS "adjustmentReason" adjustment_reason_enum,
  ADD COLUMN IF NOT EXISTS "adjustmentNote" text;

-- 3) Backfill righe ADJUSTMENT esistenti (pre-migration)
UPDATE "stockMovements"
SET "adjustmentReason" = 'recount'
WHERE "type" = 'ADJUSTMENT' AND "adjustmentReason" IS NULL;

-- 4) Constraint: se è una rettifica, reason obbligatoria
ALTER TABLE "stockMovements" DROP CONSTRAINT IF EXISTS "movement_adjustment_reason_required";
ALTER TABLE "stockMovements"
  ADD CONSTRAINT "movement_adjustment_reason_required"
  CHECK (
    ("type" != 'ADJUSTMENT') OR
    ("adjustmentReason" IS NOT NULL)
  );

-- 5) Constraint: se reason = 'other', nota obbligatoria
ALTER TABLE "stockMovements" DROP CONSTRAINT IF EXISTS "movement_adjustment_other_requires_note";
ALTER TABLE "stockMovements"
  ADD CONSTRAINT "movement_adjustment_other_requires_note"
  CHECK (
    ("adjustmentReason" IS NULL) OR
    ("adjustmentReason" != 'other') OR
    ("adjustmentReason" = 'other' AND "adjustmentNote" IS NOT NULL
     AND length(trim("adjustmentNote")) > 0)
  );
