-- M6.1 — orders + retailer auth multi-tenant
-- Pre-requisiti: enum user_role esteso (M5.5), 
-- funzione current_user_role() esiste

-- 1. Enum order_status
CREATE TYPE "public"."order_status" AS ENUM (
  'pending', 'paid', 'transferring', 'shipped', 
  'delivered', 'cancelled'
);

-- 2. Sequence orderNumber
CREATE SEQUENCE IF NOT EXISTS "public"."orders_number_seq"
  START WITH 1 INCREMENT BY 1 NO CYCLE;

-- 3. orders
CREATE TABLE "orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "orderNumber" varchar(50) UNIQUE NOT NULL DEFAULT (
    'ORD-' || EXTRACT(YEAR FROM CURRENT_DATE)::text || '-' ||
    LPAD(nextval('public.orders_number_seq')::text, 4, '0')
  ),
  "retailerId" uuid NOT NULL,
  "status" order_status DEFAULT 'pending' NOT NULL,
  "subtotalNet" numeric(10,2) DEFAULT 0 NOT NULL,
  "vatAmount"   numeric(10,2) DEFAULT 0 NOT NULL,
  "totalGross"  numeric(10,2) DEFAULT 0 NOT NULL,
  "discountPercent" numeric(5,2) DEFAULT 0 NOT NULL,
  "notes" text,
  "notesInternal" text,
  "ficProformaId" integer,
  "ficProformaNumber" varchar(50),
  "paidAt" timestamp with time zone,
  "transferringAt" timestamp with time zone,
  "shippedAt" timestamp with time zone,
  "deliveredAt" timestamp with time zone,
  "cancelledAt" timestamp with time zone,
  "createdBy" uuid NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "orders_retailerId_fkey"
    FOREIGN KEY ("retailerId") REFERENCES "retailers"("id") ON DELETE RESTRICT,
  CONSTRAINT "orders_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "orders_subtotal_nonneg" CHECK ("subtotalNet" >= 0),
  CONSTRAINT "orders_vat_nonneg" CHECK ("vatAmount" >= 0),
  CONSTRAINT "orders_total_nonneg" CHECK ("totalGross" >= 0),
  CONSTRAINT "orders_discount_range"
    CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100)
);

COMMENT ON TABLE "orders" IS
  'M6.1 ordini retailer. State machine: pending->paid->transferring->shipped->delivered ∪ cancelled.';

-- 4. orderItems
CREATE TABLE "orderItems" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "orderId" uuid NOT NULL,
  "productId" uuid NOT NULL,
  "batchId" uuid,
  "quantity" integer NOT NULL,
  "unitPriceBase"   numeric(10,2) NOT NULL,
  "discountPercent" numeric(5,2)  NOT NULL,
  "unitPriceFinal"  numeric(10,2) NOT NULL,
  "vatRate"         numeric(5,2)  NOT NULL,
  "lineTotalNet"    numeric(10,2) NOT NULL,
  "lineTotalGross"  numeric(10,2) NOT NULL,
  "productSku"  varchar(100) NOT NULL,
  "productName" varchar(255) NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "orderItems_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE,
  CONSTRAINT "orderItems_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT,
  CONSTRAINT "orderItems_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "productBatches"("id") ON DELETE SET NULL,
  CONSTRAINT "orderItems_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "orderItems_pricing_nonneg"
    CHECK ("unitPriceBase" >= 0 AND "unitPriceFinal" >= 0
       AND "lineTotalNet" >= 0 AND "lineTotalGross" >= 0),
  CONSTRAINT "orderItems_discount_range"
    CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100),
  CONSTRAINT "orderItems_vatRate_valid"
    CHECK ("vatRate" IN (4.00, 5.00, 10.00, 22.00))
);

-- 5. ALTER users
ALTER TABLE "users" ADD COLUMN "retailerId" uuid;
ALTER TABLE "users" ADD CONSTRAINT "users_retailerId_fkey"
  FOREIGN KEY ("retailerId") REFERENCES "retailers"("id") ON DELETE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_retailerId_role_coherence"
  CHECK (
    (role IN ('retailer_admin', 'retailer_user') AND "retailerId" IS NOT NULL)
    OR
    (role NOT IN ('retailer_admin', 'retailer_user') AND "retailerId" IS NULL)
  );

-- 6. Helper current_retailer_id() (NUOVA, NON conflitta con current_user_role esistente)
CREATE OR REPLACE FUNCTION public.current_retailer_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT "retailerId" FROM public.users WHERE id = auth.uid()
$$;

-- 7. Indici
CREATE INDEX "orders_retailerId_idx" ON "orders" ("retailerId");
CREATE INDEX "orders_status_idx" ON "orders" ("status")
  WHERE "status" IN ('pending', 'paid', 'transferring');
CREATE INDEX "orders_createdAt_desc_idx" ON "orders" ("createdAt" DESC);
CREATE INDEX "orders_status_createdAt_idx"
  ON "orders" ("status", "createdAt" DESC);
CREATE INDEX "orderItems_orderId_idx" ON "orderItems" ("orderId");
CREATE INDEX "orderItems_productId_idx" ON "orderItems" ("productId");
CREATE INDEX "orderItems_batchId_idx" ON "orderItems" ("batchId")
  WHERE "batchId" IS NOT NULL;
CREATE INDEX "users_retailerId_idx" ON "users" ("retailerId")
  WHERE "retailerId" IS NOT NULL;

-- 8. RLS orders
ALTER TABLE public."orders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orders_admin_all" ON public."orders"
  FOR ALL TO authenticated
  USING (public.current_user_role()::text IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role()::text IN ('admin', 'operator'));

CREATE POLICY "orders_retailer_select_own" ON public."orders"
  FOR SELECT TO authenticated
  USING (
    public.current_user_role()::text IN ('retailer_admin', 'retailer_user')
    AND "retailerId" = public.current_retailer_id()
  );

CREATE POLICY "orders_retailer_admin_insert" ON public."orders"
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role()::text = 'retailer_admin'
    AND "retailerId" = public.current_retailer_id()
  );

CREATE POLICY "orders_retailer_admin_update_pending" ON public."orders"
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role()::text = 'retailer_admin'
    AND "retailerId" = public.current_retailer_id()
    AND status = 'pending'
  )
  WITH CHECK (
    public.current_user_role()::text = 'retailer_admin'
    AND "retailerId" = public.current_retailer_id()
  );

-- 8.bis RLS orderItems
ALTER TABLE public."orderItems" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orderItems_admin_all" ON public."orderItems"
  FOR ALL TO authenticated
  USING (public.current_user_role()::text IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role()::text IN ('admin', 'operator'));

CREATE POLICY "orderItems_retailer_select_via_order" ON public."orderItems"
  FOR SELECT TO authenticated
  USING (
    public.current_user_role()::text IN ('retailer_admin', 'retailer_user')
    AND EXISTS (
      SELECT 1 FROM public."orders" o
      WHERE o.id = "orderId"
        AND o."retailerId" = public.current_retailer_id()
    )
  );

CREATE POLICY "orderItems_retailer_admin_insert" ON public."orderItems"
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role()::text = 'retailer_admin'
    AND EXISTS (
      SELECT 1 FROM public."orders" o
      WHERE o.id = "orderId"
        AND o."retailerId" = public.current_retailer_id()
        AND o.status = 'pending'
    )
  );

CREATE POLICY "orderItems_retailer_admin_update_pending" ON public."orderItems"
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role()::text = 'retailer_admin'
    AND EXISTS (
      SELECT 1 FROM public."orders" o
      WHERE o.id = "orderId"
        AND o."retailerId" = public.current_retailer_id()
        AND o.status = 'pending'
    )
  )
  WITH CHECK (
    public.current_user_role()::text = 'retailer_admin'
    AND EXISTS (
      SELECT 1 FROM public."orders" o
      WHERE o.id = "orderId"
        AND o."retailerId" = public.current_retailer_id()
    )
  );

CREATE POLICY "orderItems_retailer_admin_delete_pending" ON public."orderItems"
  FOR DELETE TO authenticated
  USING (
    public.current_user_role()::text = 'retailer_admin'
    AND EXISTS (
      SELECT 1 FROM public."orders" o
      WHERE o.id = "orderId"
        AND o."retailerId" = public.current_retailer_id()
        AND o.status = 'pending'
    )
  );
