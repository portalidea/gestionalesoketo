-- M12.B: Add companyId to sales_stores to link channels to companies
-- This allows stock consumption to use the correct company warehouse

BEGIN;

ALTER TABLE "sales_stores"
  ADD COLUMN IF NOT EXISTS "companyId" uuid REFERENCES "companies"("id");

-- Assign existing Shopify channel to SoKeto Srl
UPDATE "sales_stores"
SET "companyId" = '00000000-0000-0000-0000-000000000002'
WHERE "channel" = 'shopify';

-- Verify
SELECT "id", "channel", "storeIdentifier", "companyId"
FROM "sales_stores";

COMMIT;
