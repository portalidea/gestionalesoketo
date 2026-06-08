BEGIN;

-- 1) Tabella cache clienti FiC per company
CREATE TABLE "ficClientsCache" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "ficClientId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "vatNumber" VARCHAR(20),
  "fiscalCode" VARCHAR(20),
  "email" VARCHAR(255),
  "addressCity" VARCHAR(100),
  "addressProvince" VARCHAR(10),
  "country" VARCHAR(50),
  "rawData" JSONB,
  "refreshedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("companyId", "ficClientId")
);

CREATE INDEX fic_clients_cache_company_idx
  ON "ficClientsCache" ("companyId");

-- 2) Verifica
SELECT
  'ficClientsCache_exists' AS check_name,
  (SELECT COUNT(*)::text FROM information_schema.tables
   WHERE table_name = 'ficClientsCache') AS value;

-- Atteso: ficClientsCache_exists = 1

COMMIT;
