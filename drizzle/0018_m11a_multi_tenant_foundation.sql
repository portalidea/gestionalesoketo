-- M11.A — Multi-tenant Foundation
-- Adds companies, userCompanyAccess tables and companyId columns to business tables.
-- IMPORTANT: Run the data migration script AFTER this DDL migration.

-- 1. Create companies table
CREATE TABLE IF NOT EXISTS "companies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Create userCompanyAccess table
CREATE TABLE IF NOT EXISTS "userCompanyAccess" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id"),
  "companyId" UUID NOT NULL REFERENCES "companies"("id"),
  "role" TEXT NOT NULL DEFAULT 'member',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "userCompanyAccess_user_company_unique" UNIQUE ("userId", "companyId")
);

-- 3. Add companyId to retailers (nullable first, then backfill, then NOT NULL)
ALTER TABLE "retailers" ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

-- 4. Add companyId to orders
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");
CREATE INDEX IF NOT EXISTS "orders_company_idx" ON "orders" ("companyId");

-- 5. Add companyId to productBatches
ALTER TABLE "productBatches" ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

-- 6. Add companyId to locations
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

-- 7. Add companyId to inventoryByBatch
ALTER TABLE "inventoryByBatch" ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

-- 8. Add companyId to stockMovements
ALTER TABLE "stockMovements" ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES "companies"("id");

-- 9. Add paymentStatus and paymentMethod to orders (M6.2.G — if not already present)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='paymentStatus') THEN
    CREATE TYPE "paymentStatusEnum" AS ENUM ('unpaid', 'paid', 'refunded');
    ALTER TABLE "orders" ADD COLUMN "paymentStatus" "paymentStatusEnum" NOT NULL DEFAULT 'unpaid';
    ALTER TABLE "orders" ADD COLUMN "paymentMethod" TEXT;
  END IF;
END $$;

-- ============================================================
-- DATA MIGRATION (run manually or via script after DDL above)
-- ============================================================
-- Step A: Create the default company
-- INSERT INTO "companies" ("id", "name", "slug") VALUES ('YOUR-UUID', 'SoKeto', 'soketo');
--
-- Step B: Backfill companyId on all existing rows
-- UPDATE "retailers" SET "companyId" = 'YOUR-UUID' WHERE "companyId" IS NULL;
-- UPDATE "orders" SET "companyId" = 'YOUR-UUID' WHERE "companyId" IS NULL;
-- UPDATE "productBatches" SET "companyId" = 'YOUR-UUID' WHERE "companyId" IS NULL;
-- UPDATE "locations" SET "companyId" = 'YOUR-UUID' WHERE "companyId" IS NULL;
-- UPDATE "inventoryByBatch" SET "companyId" = 'YOUR-UUID' WHERE "companyId" IS NULL;
-- UPDATE "stockMovements" SET "companyId" = 'YOUR-UUID' WHERE "companyId" IS NULL;
--
-- Step C: Make companyId NOT NULL (after backfill)
-- ALTER TABLE "retailers" ALTER COLUMN "companyId" SET NOT NULL;
-- ALTER TABLE "orders" ALTER COLUMN "companyId" SET NOT NULL;
-- ALTER TABLE "productBatches" ALTER COLUMN "companyId" SET NOT NULL;
-- ALTER TABLE "locations" ALTER COLUMN "companyId" SET NOT NULL;
-- ALTER TABLE "inventoryByBatch" ALTER COLUMN "companyId" SET NOT NULL;
-- ALTER TABLE "stockMovements" ALTER COLUMN "companyId" SET NOT NULL;
--
-- Step D: Grant all existing staff users access to the default company
-- INSERT INTO "userCompanyAccess" ("userId", "companyId", "role", "isDefault")
-- SELECT "id", 'YOUR-UUID', 'member', true FROM "users"
-- WHERE "role" IN ('admin', 'operator', 'viewer');
--
-- Step E: Update unique constraints (optional, for multi-tenant uniqueness)
-- DROP INDEX IF EXISTS "locations_central_singleton";
-- CREATE UNIQUE INDEX "locations_central_singleton" ON "locations" ("companyId", "type")
--   WHERE "type" = 'central_warehouse';
