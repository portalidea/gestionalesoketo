-- Migration 0008: Make batchNumber and expirationDate nullable in ddt_import_items
-- Allows Claude Vision to return null for these fields when not present in the DDT.
-- Users can fill them manually in the review UI before confirming.

ALTER TABLE "ddt_import_items" ALTER COLUMN "batchNumber" DROP NOT NULL;
ALTER TABLE "ddt_import_items" ALTER COLUMN "expirationDate" DROP NOT NULL;
