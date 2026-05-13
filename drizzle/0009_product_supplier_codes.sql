-- Migration 0009: M5.5 — product_supplier_codes mapping
-- Maps product IDs to producer-specific codes for DDT auto-matching.

CREATE TABLE "product_supplier_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "producerId" uuid NOT NULL REFERENCES "producers"("id") ON DELETE CASCADE,
  "supplierCode" varchar(100) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "product_supplier_codes_producer_code_unique" UNIQUE ("producerId", "supplierCode"),
  CONSTRAINT "product_supplier_codes_product_producer_unique" UNIQUE ("productId", "producerId")
);

-- Indices for lookup
CREATE INDEX "idx_product_supplier_codes_productId" ON "product_supplier_codes" ("productId");
CREATE INDEX "idx_product_supplier_codes_supplierCode" ON "product_supplier_codes" ("supplierCode");

-- RLS: admin/operator full access, viewer SELECT only
ALTER TABLE "product_supplier_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_supplier_codes_admin_operator_all" ON "product_supplier_codes"
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

CREATE POLICY "product_supplier_codes_viewer_select" ON "product_supplier_codes"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "users"
      WHERE "users"."id" = auth.uid()
      AND "users"."role" = 'viewer'
    )
  );
