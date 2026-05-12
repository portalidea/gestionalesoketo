-- Migration 0007: Phase B M5 — DDT Auto-Import tables
-- Adds ddt_imports and ddt_import_items tables for Claude Vision PDF extraction workflow.

-- Enum: DDT import status
CREATE TYPE "ddt_import_status" AS ENUM (
  'uploaded',
  'extracting',
  'review',
  'confirmed',
  'failed'
);

-- Enum: DDT import item status
CREATE TYPE "ddt_item_status" AS ENUM (
  'pending',
  'matched',
  'unmatched',
  'confirmed',
  'merged'
);

-- Table: ddt_imports
CREATE TABLE "ddt_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "producerId" uuid REFERENCES "producers"("id") ON DELETE SET NULL,
  "ddtNumber" varchar(100),
  "ddtDate" date,
  "status" "ddt_import_status" NOT NULL DEFAULT 'uploaded',
  "pdfStoragePath" text NOT NULL,
  "pdfFileName" text NOT NULL,
  "pdfFileSize" integer NOT NULL,
  "extractedData" jsonb,
  "confirmedAt" timestamptz,
  "confirmedBy" uuid REFERENCES "users"("id"),
  "errorMessage" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Table: ddt_import_items
CREATE TABLE "ddt_import_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ddtImportId" uuid NOT NULL REFERENCES "ddt_imports"("id") ON DELETE CASCADE,
  "productMatchedId" uuid REFERENCES "products"("id"),
  "productNameExtracted" text NOT NULL,
  "productCodeExtracted" text,
  "batchNumber" varchar(100) NOT NULL,
  "expirationDate" date NOT NULL,
  "quantityPieces" integer NOT NULL CHECK ("quantityPieces" > 0),
  "unitOfMeasure" varchar(10) NOT NULL DEFAULT 'PZ',
  "createdBatchId" uuid REFERENCES "productBatches"("id"),
  "mergedIntoBatchId" uuid REFERENCES "productBatches"("id"),
  "status" "ddt_item_status" NOT NULL DEFAULT 'pending',
  "notes" text
);

-- Performance indexes
CREATE INDEX "idx_ddt_imports_status" ON "ddt_imports" ("status");
CREATE INDEX "idx_ddt_imports_producerId" ON "ddt_imports" ("producerId");
CREATE INDEX "idx_ddt_imports_createdAt" ON "ddt_imports" ("createdAt" DESC);
CREATE INDEX "idx_ddt_import_items_ddtImportId" ON "ddt_import_items" ("ddtImportId");
CREATE INDEX "idx_ddt_import_items_productMatchedId" ON "ddt_import_items" ("productMatchedId")
  WHERE "productMatchedId" IS NOT NULL;

-- RLS policies (admin/operator only)
ALTER TABLE "ddt_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ddt_import_items" ENABLE ROW LEVEL SECURITY;

-- Policy: admin and operator can do everything on ddt_imports
CREATE POLICY "ddt_imports_admin_operator_all" ON "ddt_imports"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "users"
      WHERE "users"."id" = auth.uid()
      AND "users"."role" IN ('admin', 'operator')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "users"
      WHERE "users"."id" = auth.uid()
      AND "users"."role" IN ('admin', 'operator')
    )
  );

-- Policy: admin and operator can do everything on ddt_import_items
CREATE POLICY "ddt_import_items_admin_operator_all" ON "ddt_import_items"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "users"
      WHERE "users"."id" = auth.uid()
      AND "users"."role" IN ('admin', 'operator')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "users"
      WHERE "users"."id" = auth.uid()
      AND "users"."role" IN ('admin', 'operator')
    )
  );
