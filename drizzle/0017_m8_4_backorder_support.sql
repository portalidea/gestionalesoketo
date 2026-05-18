-- M8.4: Backorder support
-- Add isBackorderable flag to products (default true = all products backorderable)

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "isBackorderable" BOOLEAN NOT NULL DEFAULT true;

-- Index on orderItems where batchId IS NULL for fast backorder queries
CREATE INDEX IF NOT EXISTS idx_order_items_unassigned_batch
  ON "orderItems"("orderId") WHERE "batchId" IS NULL;
