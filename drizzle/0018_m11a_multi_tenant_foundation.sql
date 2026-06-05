-- ============================================================
-- M11.A — Multi-tenant Foundation (v2)
-- ============================================================
-- ISTRUZIONI:
-- Applicare manualmente in Supabase SQL Editor dentro una
-- transazione BEGIN ... COMMIT, con SELECT di verifica PRIMA
-- del COMMIT. NON usare pnpm db:push né drizzle-kit push in
-- nessuna circostanza.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. DDL: Nuove tabelle
-- ============================================================

CREATE TABLE IF NOT EXISTS "companies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "vatNumber" VARCHAR(20),
  "fiscalCode" VARCHAR(20),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "userCompanyAccess" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "companyId" UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "userCompanyAccess_user_company_unique" UNIQUE ("userId", "companyId")
);

CREATE INDEX IF NOT EXISTS "user_company_access_user_idx"
  ON "userCompanyAccess" ("userId");

-- ============================================================
-- 2. DDL: Aggiunta colonne companyId (nullable inizialmente)
-- ============================================================

ALTER TABLE "retailers"
  ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

ALTER TABLE "productBatches"
  ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

ALTER TABLE "inventoryByBatch"
  ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

ALTER TABLE "stockMovements"
  ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

-- ============================================================
-- 3. SEED: Creazione delle due company con UUID fissi
-- ============================================================

INSERT INTO "companies" ("id", "name", "vatNumber", "fiscalCode")
VALUES
  ('00000000-0000-0000-0000-000000000001', 'E-Keto Food Srls', 'IT04864130408', 'IT04864130408'),
  ('00000000-0000-0000-0000-000000000002', 'SoKeto Srl', NULL, NULL)
ON CONFLICT ("id") DO NOTHING;

-- ============================================================
-- 4. BACKFILL: Tutti i dati esistenti → E-Keto Food (company 1)
-- ============================================================

UPDATE "retailers"
  SET "companyId" = '00000000-0000-0000-0000-000000000001'
  WHERE "companyId" IS NULL;

UPDATE "orders"
  SET "companyId" = '00000000-0000-0000-0000-000000000001'
  WHERE "companyId" IS NULL;

UPDATE "productBatches"
  SET "companyId" = '00000000-0000-0000-0000-000000000001'
  WHERE "companyId" IS NULL;

UPDATE "locations"
  SET "companyId" = '00000000-0000-0000-0000-000000000001'
  WHERE "companyId" IS NULL;

UPDATE "inventoryByBatch"
  SET "companyId" = '00000000-0000-0000-0000-000000000001'
  WHERE "companyId" IS NULL;

UPDATE "stockMovements"
  SET "companyId" = '00000000-0000-0000-0000-000000000001'
  WHERE "companyId" IS NULL;

-- ============================================================
-- 5. DDL: SET NOT NULL dopo backfill
-- ============================================================

ALTER TABLE "retailers" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "productBatches" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "locations" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "inventoryByBatch" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "stockMovements" ALTER COLUMN "companyId" SET NOT NULL;

-- ============================================================
-- 6. INDEXES su companyId
-- ============================================================

CREATE INDEX IF NOT EXISTS "retailers_company_idx" ON "retailers" ("companyId");
CREATE INDEX IF NOT EXISTS "orders_company_idx" ON "orders" ("companyId");
CREATE INDEX IF NOT EXISTS "productBatches_company_idx" ON "productBatches" ("companyId");
CREATE INDEX IF NOT EXISTS "locations_company_idx" ON "locations" ("companyId");
CREATE INDEX IF NOT EXISTS "inventoryByBatch_company_idx" ON "inventoryByBatch" ("companyId");
CREATE INDEX IF NOT EXISTS "stockMovements_company_idx" ON "stockMovements" ("companyId");

-- ============================================================
-- 7. UNIQUE CONSTRAINTS: aggiornamento per multi-tenant
-- ============================================================

-- 7a. productBatches: (productId, batchNumber) → (companyId, productId, batchNumber)
ALTER TABLE "productBatches"
  DROP CONSTRAINT IF EXISTS "productBatches_product_batch_unique";
ALTER TABLE "productBatches"
  ADD CONSTRAINT "productBatches_product_batch_company_unique"
  UNIQUE ("companyId", "productId", "batchNumber");

-- 7b. locations: central_singleton → per-company
DROP INDEX IF EXISTS "locations_central_singleton";
CREATE UNIQUE INDEX "locations_central_singleton"
  ON "locations" ("companyId", "type")
  WHERE "type" = 'central_warehouse';

-- ============================================================
-- 8. SEED: userCompanyAccess (fonte: auth.users)
-- ============================================================

-- Alessandro e Ilira: accesso a entrambe le company, default su E-Keto Food
WITH alessandro AS (
  SELECT id FROM auth.users WHERE email = 'alessandro@soketo.it'
), ilira AS (
  SELECT id FROM auth.users WHERE email = 'ilira@soketo.it'
)
INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
SELECT alessandro.id, '00000000-0000-0000-0000-000000000001'::uuid, true FROM alessandro
UNION ALL
SELECT alessandro.id, '00000000-0000-0000-0000-000000000002'::uuid, false FROM alessandro
UNION ALL
SELECT ilira.id, '00000000-0000-0000-0000-000000000001'::uuid, true FROM ilira
UNION ALL
SELECT ilira.id, '00000000-0000-0000-0000-000000000002'::uuid, false FROM ilira
ON CONFLICT ("userId", "companyId") DO NOTHING;

-- Tutti gli altri utenti esistenti: accesso solo a E-Keto Food
INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
SELECT u.id, '00000000-0000-0000-0000-000000000001'::uuid, true
FROM auth.users u
WHERE u.email NOT IN ('alessandro@soketo.it', 'ilira@soketo.it')
  AND NOT EXISTS (
    SELECT 1 FROM "userCompanyAccess" uca
    WHERE uca."userId" = u.id
      AND uca."companyId" = '00000000-0000-0000-0000-000000000001'::uuid
  );

-- ============================================================
-- 9. RLS: Policy RESTRICTIVE per company isolation
-- ============================================================

-- Abilita RLS sulle 6 tabelle business (se non già attivo)
ALTER TABLE "retailers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "productBatches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventoryByBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stockMovements" ENABLE ROW LEVEL SECURITY;

-- Policy RESTRICTIVE: ogni utente vede solo le company a cui ha accesso
CREATE POLICY "retailers_company_isolation" ON "retailers"
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  )
  WITH CHECK (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  );

CREATE POLICY "orders_company_isolation" ON "orders"
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  )
  WITH CHECK (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  );

CREATE POLICY "productBatches_company_isolation" ON "productBatches"
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  )
  WITH CHECK (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  );

CREATE POLICY "locations_company_isolation" ON "locations"
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  )
  WITH CHECK (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  );

CREATE POLICY "inventoryByBatch_company_isolation" ON "inventoryByBatch"
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  )
  WITH CHECK (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  );

CREATE POLICY "stockMovements_company_isolation" ON "stockMovements"
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  )
  WITH CHECK (
    "companyId" IN (
      SELECT "companyId" FROM "userCompanyAccess"
      WHERE "userId" = auth.uid()
    )
  );

-- ============================================================
-- 10. VERIFICA PRE-COMMIT
-- ============================================================
-- Eseguire queste SELECT per verificare che tutto sia corretto
-- PRIMA di fare COMMIT:

SELECT 'companies' AS tbl, count(*) FROM "companies";
-- Atteso: 2

SELECT 'userCompanyAccess' AS tbl, count(*) FROM "userCompanyAccess";
-- Atteso: >= 4 (2 per Alessandro + 2 per Ilira + N per altri utenti)

SELECT 'retailers_null_check' AS tbl, count(*) FROM "retailers" WHERE "companyId" IS NULL;
-- Atteso: 0

SELECT 'orders_null_check' AS tbl, count(*) FROM "orders" WHERE "companyId" IS NULL;
-- Atteso: 0

SELECT 'productBatches_null_check' AS tbl, count(*) FROM "productBatches" WHERE "companyId" IS NULL;
-- Atteso: 0

SELECT 'locations_null_check' AS tbl, count(*) FROM "locations" WHERE "companyId" IS NULL;
-- Atteso: 0

SELECT 'inventoryByBatch_null_check' AS tbl, count(*) FROM "inventoryByBatch" WHERE "companyId" IS NULL;
-- Atteso: 0

SELECT 'stockMovements_null_check' AS tbl, count(*) FROM "stockMovements" WHERE "companyId" IS NULL;
-- Atteso: 0

-- Se tutto OK:
COMMIT;
-- Se qualcosa non torna:
-- ROLLBACK;
