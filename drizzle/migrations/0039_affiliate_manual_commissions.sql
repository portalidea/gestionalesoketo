-- 0039 — Provvigioni affiliate manuali
-- Append-only. Non applicare automaticamente: la migration va revisionata e
-- applicata manualmente su Supabase prima del rilascio del relativo codice.

BEGIN;

-- Origine della riga: le righe storiche e quelle create da commissionService
-- restano automatic_order; le righe manuali non derivano da un ordine.
ALTER TABLE affiliate_commissions
  ADD COLUMN IF NOT EXISTS origin varchar(20);

UPDATE affiliate_commissions
SET origin = 'automatic_order'
WHERE origin IS NULL;

ALTER TABLE affiliate_commissions
  ALTER COLUMN origin SET DEFAULT 'automatic_order',
  ALTER COLUMN origin SET NOT NULL;

ALTER TABLE affiliate_commissions
  ADD COLUMN IF NOT EXISTS "activityName" text,
  ADD COLUMN IF NOT EXISTS "commissionDate" date,
  ADD COLUMN IF NOT EXISTS "baseAmount" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "commissionType" varchar(50),
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS "companyId" uuid REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS "createdBy" uuid REFERENCES users(id);

-- Una riga manuale non ha obbligo di un ordine o retailer; le colonne diventano
-- quindi nullable, ma il vincolo sotto conserva l’obbligo per l’origine automatica.
ALTER TABLE affiliate_commissions
  ALTER COLUMN "orderId" DROP NOT NULL,
  ALTER COLUMN "retailerId" DROP NOT NULL;

ALTER TABLE affiliate_commissions
  DROP CONSTRAINT IF EXISTS affiliate_commissions_origin_contract_check;

ALTER TABLE affiliate_commissions
  ADD CONSTRAINT affiliate_commissions_origin_contract_check
  CHECK (
    (
      origin = 'automatic_order'
      AND "orderId" IS NOT NULL
      AND "retailerId" IS NOT NULL
    )
    OR
    (
      origin = 'manual'
      AND "activityName" IS NOT NULL
      AND "commissionDate" IS NOT NULL
      AND "baseAmount" IS NOT NULL
      AND "commissionRate" IS NOT NULL
      AND "companyId" IS NOT NULL
    )
  );

ALTER TABLE affiliate_commissions
  DROP CONSTRAINT IF EXISTS affiliate_commissions_origin_check;

ALTER TABLE affiliate_commissions
  ADD CONSTRAINT affiliate_commissions_origin_check
  CHECK (origin IN ('automatic_order', 'manual'));

CREATE INDEX IF NOT EXISTS idx_commissions_company
  ON affiliate_commissions ("companyId")
  WHERE "companyId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commissions_origin
  ON affiliate_commissions (origin, "commissionDate");

COMMIT;
