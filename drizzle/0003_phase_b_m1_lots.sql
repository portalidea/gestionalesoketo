-- ============================================================
-- Phase B — Milestone 1: lotti FEFO + magazzino centrale
-- ============================================================
-- Migration scritta a mano (drizzle-kit non gestisce RLS,
-- partial unique index con WHERE, e DO block per data backfill).
--
-- Introduce:
--   1. Enum location_type ('central_warehouse' | 'retailer')
--   2. Estensione enum stock_movement_type con RECEIPT_FROM_PRODUCER
--   3. Tabella producers (anagrafica produttori)
--   4. Tabella productBatches (lotti per prodotto, con scadenza)
--   5. Tabella locations (magazzino centrale singleton + 1 per retailer)
--   6. Tabella inventoryByBatch (sostituisce inventory; chiave
--      location+batch)
--   7. Estensione stockMovements: nullability inventoryId/retailerId
--      e nuovi FK batchId / fromLocationId / toLocationId
--   8. RLS policies coerenti con pattern esistente (SELECT a tutti
--      authenticated; INSERT/UPDATE/DELETE a admin|operator)
--   9. Indici performance
--  10. Data backfill: locations + lotti placeholder per inventory legacy
--
-- NOTA: la tabella inventory legacy resta in place; verrà droppata
-- in M2 dopo che nessuna procedure tRPC la legge più.

-- ============================================================
-- 1. NEW ENUM: location_type
-- ============================================================
CREATE TYPE "public"."location_type" AS ENUM ('central_warehouse', 'retailer');
--> statement-breakpoint

-- ============================================================
-- 2. EXTEND stock_movement_type
-- ============================================================
-- Postgres 12+: ADD VALUE è permesso in transaction, ma il valore
-- non può essere usato nello stesso file. Nel data backfill non
-- creiamo movimenti, quindi nessun problema.
ALTER TYPE "public"."stock_movement_type" ADD VALUE IF NOT EXISTS 'RECEIPT_FROM_PRODUCER';
--> statement-breakpoint

-- ============================================================
-- 3. producers
-- ============================================================
CREATE TABLE "producers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "contactName" text,
  "email" varchar(320),
  "phone" varchar(50),
  "address" text,
  "vatNumber" varchar(50),
  "notes" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ============================================================
-- 4. productBatches
-- ============================================================
CREATE TABLE "productBatches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "productId" uuid NOT NULL,
  "producerId" uuid,
  "batchNumber" text NOT NULL,
  "expirationDate" date NOT NULL,
  "productionDate" date,
  "initialQuantity" integer NOT NULL,
  "notes" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "productBatches_product_batch_unique" UNIQUE ("productId", "batchNumber"),
  CONSTRAINT "productBatches_initial_qty_positive" CHECK ("initialQuantity" > 0),
  CONSTRAINT "productBatches_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT,
  CONSTRAINT "productBatches_producerId_fkey"
    FOREIGN KEY ("producerId") REFERENCES "producers"("id") ON DELETE SET NULL
);
--> statement-breakpoint

CREATE INDEX "productBatches_product_expiration_idx"
  ON "productBatches" ("productId", "expirationDate");
--> statement-breakpoint

-- ============================================================
-- 5. locations
-- ============================================================
-- Vincoli:
-- - central_warehouse → retailerId NULL (e singleton via partial UNIQUE)
-- - retailer          → retailerId NOT NULL
CREATE TABLE "locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" location_type NOT NULL,
  "name" text NOT NULL,
  "retailerId" uuid,
  "isActive" boolean DEFAULT true NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "locations_type_retailer_coherence" CHECK (
    (type = 'central_warehouse' AND "retailerId" IS NULL)
    OR
    (type = 'retailer' AND "retailerId" IS NOT NULL)
  ),
  CONSTRAINT "locations_retailerId_fkey"
    FOREIGN KEY ("retailerId") REFERENCES "retailers"("id") ON DELETE CASCADE
);
--> statement-breakpoint

-- Singleton: solo una riga di type='central_warehouse'
CREATE UNIQUE INDEX "locations_central_singleton"
  ON "locations" ("type")
  WHERE "type" = 'central_warehouse';
--> statement-breakpoint

-- Lookup veloce per retailer (escluso warehouse centrale)
CREATE INDEX "locations_retailerId_idx"
  ON "locations" ("retailerId")
  WHERE "retailerId" IS NOT NULL;
--> statement-breakpoint

-- ============================================================
-- 6. inventoryByBatch
-- ============================================================
CREATE TABLE "inventoryByBatch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "locationId" uuid NOT NULL,
  "batchId" uuid NOT NULL,
  "quantity" integer DEFAULT 0 NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventoryByBatch_location_batch_unique" UNIQUE ("locationId", "batchId"),
  CONSTRAINT "inventoryByBatch_quantity_nonneg" CHECK ("quantity" >= 0),
  CONSTRAINT "inventoryByBatch_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE,
  CONSTRAINT "inventoryByBatch_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "productBatches"("id") ON DELETE RESTRICT
);
--> statement-breakpoint

-- ============================================================
-- 7. EXTEND stockMovements
-- ============================================================
-- Per RECEIPT_FROM_PRODUCER (produttore → warehouse) non esistono
-- inventoryId legacy né retailerId, quindi rendiamoli nullable.
ALTER TABLE "stockMovements" ALTER COLUMN "inventoryId" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "stockMovements" ALTER COLUMN "retailerId" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "stockMovements" ADD COLUMN "batchId" uuid;
--> statement-breakpoint
ALTER TABLE "stockMovements" ADD COLUMN "fromLocationId" uuid;
--> statement-breakpoint
ALTER TABLE "stockMovements" ADD COLUMN "toLocationId" uuid;
--> statement-breakpoint

ALTER TABLE "stockMovements"
  ADD CONSTRAINT "stockMovements_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "productBatches"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "stockMovements"
  ADD CONSTRAINT "stockMovements_fromLocationId_fkey"
  FOREIGN KEY ("fromLocationId") REFERENCES "locations"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "stockMovements"
  ADD CONSTRAINT "stockMovements_toLocationId_fkey"
  FOREIGN KEY ("toLocationId") REFERENCES "locations"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ============================================================
-- 8. RLS — replicate pattern from migration 0002
-- ============================================================

-- producers
ALTER TABLE public.producers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "producers_select_authenticated" ON public.producers
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "producers_modify_admin_operator" ON public.producers
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- productBatches
ALTER TABLE public."productBatches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "productBatches_select_authenticated" ON public."productBatches"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "productBatches_modify_admin_operator" ON public."productBatches"
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- locations
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "locations_select_authenticated" ON public.locations
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "locations_modify_admin_operator" ON public.locations
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- inventoryByBatch
ALTER TABLE public."inventoryByBatch" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inventoryByBatch_select_authenticated" ON public."inventoryByBatch"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "inventoryByBatch_modify_admin_operator" ON public."inventoryByBatch"
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- ============================================================
-- 9. DATA BACKFILL
-- ============================================================
-- Idempotente (skippa se central_warehouse già esiste).
-- Strategia:
--   1. crea 1 location central_warehouse
--   2. crea 1 location retailer per ogni retailers row
--   3. per ogni inventory legacy con quantity > 0:
--      - crea productBatches (placeholder se batchNumber/expirationDate
--        legacy mancanti)
--      - crea inventoryByBatch sulla location del retailer
DO $$
DECLARE
  v_existing integer;
  v_warehouse_id uuid;
  v_inv RECORD;
  v_location_id uuid;
  v_batch_id uuid;
  v_batch_number text;
  v_expiration date;
  v_processed integer := 0;
BEGIN
  SELECT count(*) INTO v_existing
    FROM public.locations
    WHERE "type" = 'central_warehouse';

  IF v_existing > 0 THEN
    RAISE NOTICE '[backfill] central_warehouse già esistente, skip.';
    RETURN;
  END IF;

  -- 1. central warehouse singleton
  INSERT INTO public.locations ("type", "name", "retailerId")
    VALUES ('central_warehouse', 'Magazzino SoKeto E-Keto Food', NULL)
    RETURNING "id" INTO v_warehouse_id;

  RAISE NOTICE '[backfill] creato central warehouse %', v_warehouse_id;

  -- 2. una location per ogni retailer
  INSERT INTO public.locations ("type", "name", "retailerId")
    SELECT 'retailer', r."name", r."id"
    FROM public.retailers r;

  RAISE NOTICE '[backfill] create % retailer locations',
    (SELECT count(*) FROM public.locations WHERE "type" = 'retailer');

  -- 3. per ogni inventory legacy con quantità > 0
  FOR v_inv IN
    SELECT i."id" AS inv_id, i."retailerId", i."productId", i."quantity",
           i."batchNumber", i."expirationDate"
    FROM public.inventory i
    WHERE i."quantity" > 0
  LOOP
    v_batch_number := COALESCE(NULLIF(v_inv."batchNumber", ''),
                               'LEGACY-' || gen_random_uuid()::text);
    v_expiration := COALESCE(v_inv."expirationDate"::date,
                             '2099-12-31'::date);

    -- Crea batch (o riusa se conflitto sull'unique product+batchNumber)
    INSERT INTO public."productBatches"
      ("productId", "producerId", "batchNumber", "expirationDate",
       "productionDate", "initialQuantity", "notes")
    VALUES (v_inv."productId", NULL, v_batch_number, v_expiration,
            NULL, v_inv."quantity",
            'Migrato da inventory legacy (Phase B M1)')
    ON CONFLICT ("productId", "batchNumber") DO UPDATE
      SET "initialQuantity" = public."productBatches"."initialQuantity"
                              + EXCLUDED."initialQuantity"
    RETURNING "id" INTO v_batch_id;

    -- Trova la location del retailer
    SELECT "id" INTO v_location_id
      FROM public.locations
      WHERE "type" = 'retailer' AND "retailerId" = v_inv."retailerId"
      LIMIT 1;

    -- Crea inventoryByBatch (o somma se duplicato)
    INSERT INTO public."inventoryByBatch" ("locationId", "batchId", "quantity")
    VALUES (v_location_id, v_batch_id, v_inv."quantity")
    ON CONFLICT ("locationId", "batchId") DO UPDATE
      SET "quantity" = public."inventoryByBatch"."quantity"
                       + EXCLUDED."quantity",
          "updatedAt" = now();

    v_processed := v_processed + 1;
  END LOOP;

  RAISE NOTICE '[backfill] migrate % inventory legacy rows', v_processed;
END $$;
