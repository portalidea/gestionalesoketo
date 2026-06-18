-- M12: Gestione inventario etichette per prodotto
-- Pool unico cross-company (nessuna dimensione companyId)
-- Applicare manualmente in Supabase SQL Editor

BEGIN;

ALTER TABLE products 
  ADD COLUMN IF NOT EXISTS "labelStock" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "labelReorderThreshold" INTEGER NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS "labelMovements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  "type" VARCHAR(20) NOT NULL CHECK (type IN ('LOAD', 'CONSUMPTION', 'ADJUSTMENT')),
  "quantity" INTEGER NOT NULL,
  "previousStock" INTEGER NOT NULL,
  "newStock" INTEGER NOT NULL,
  "sourceOrderId" UUID REFERENCES orders(id),
  "notes" TEXT,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS label_movements_product_idx ON "labelMovements" ("productId");
CREATE INDEX IF NOT EXISTS label_movements_type_idx ON "labelMovements" ("type");
CREATE INDEX IF NOT EXISTS label_movements_created_at_idx ON "labelMovements" ("createdAt" DESC);

-- Verifica post-applicazione
SELECT 
  COUNT(*) AS products_total,
  SUM("labelStock") AS total_label_stock,
  COUNT(*) FILTER (WHERE "labelStock" < "labelReorderThreshold") AS under_threshold_count
FROM products;

COMMIT;
