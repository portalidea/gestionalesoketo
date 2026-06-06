BEGIN;

-- 1) Migra il token SoKeto da systemIntegrations a ficConnections
INSERT INTO "ficConnections" (
  "companyId",
  "ficCompanyId",
  "accessToken",
  "refreshToken",
  "tokenExpiresAt",
  "createdAt",
  "updatedAt"
)
SELECT
  '00000000-0000-0000-0000-000000000002',  -- SoKeto Srl
  si."accountId",
  si."accessToken",
  si."refreshToken",
  si."expiresAt",
  si."createdAt",
  si."updatedAt"
FROM "systemIntegrations" si
WHERE si.type = 'fattureincloud'
ON CONFLICT ("companyId") DO NOTHING;

-- 2) Verifica migrazione
SELECT
  'ficConnections_count' AS check_name,
  COUNT(*)::text AS value
FROM "ficConnections"
UNION ALL
SELECT
  'ficConnections_soketo',
  COUNT(*)::text
FROM "ficConnections"
WHERE "companyId" = '00000000-0000-0000-0000-000000000002';

-- Atteso: ficConnections_count = 1, ficConnections_soketo = 1

-- 3) Drop tabella systemIntegrations (non più usata)
DROP TABLE IF EXISTS "systemIntegrations" CASCADE;

-- 4) Drop colonne morte da retailers
ALTER TABLE retailers
  DROP COLUMN IF EXISTS "fattureInCloudAccessToken",
  DROP COLUMN IF EXISTS "fattureInCloudRefreshToken",
  DROP COLUMN IF EXISTS "fattureInCloudCompanyId",
  DROP COLUMN IF EXISTS "fattureInCloudTokenExpiresAt";

-- 5) Nuova tabella retailerFicMapping (per-company)
CREATE TABLE "retailerFicMapping" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailerId" UUID NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  "companyId" UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "ficClientId" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("retailerId", "companyId")
);

CREATE INDEX retailer_fic_mapping_retailer_idx
  ON "retailerFicMapping" ("retailerId");
CREATE INDEX retailer_fic_mapping_company_idx
  ON "retailerFicMapping" ("companyId");

-- 6) Backfill: i ficClientId attuali sono del FiC SoKeto
INSERT INTO "retailerFicMapping" ("retailerId", "companyId", "ficClientId")
SELECT
  r.id,
  '00000000-0000-0000-0000-000000000002',  -- SoKeto Srl (stato attuale)
  r."ficClientId"
FROM retailers r
WHERE r."ficClientId" IS NOT NULL;

-- 7) Drop colonna ficClientId da retailers (sostituita da retailerFicMapping)
ALTER TABLE retailers DROP COLUMN IF EXISTS "ficClientId";

-- 8) Verifica finale
SELECT
  'ficConnections_total' AS check_name, COUNT(*)::text AS value FROM "ficConnections"
UNION ALL
SELECT 'retailerFicMapping_total', COUNT(*)::text FROM "retailerFicMapping"
UNION ALL
SELECT 'retailers_with_ficClientId_col',
  (SELECT COUNT(*)::text FROM information_schema.columns
   WHERE table_name='retailers' AND column_name='ficClientId');

-- Atteso:
-- ficConnections_total = 1
-- retailerFicMapping_total = 6 (i 6 retailer attuali)
-- retailers_with_ficClientId_col = 0 (colonna droppata)

COMMIT;
