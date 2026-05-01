-- ============================================================
-- Phase B — Milestone 3: Pricing Packages + FiC single-tenant
-- ============================================================
-- Migration scritta a mano (drizzle-kit non gestisce CHECK
-- complessi, RLS, partial unique index, seed data).
--
-- Introduce:
--   1. Enum proforma_queue_status
--   2. Tabella pricingPackages (4 pacchetti commerciali) + seed
--   3. ALTER products: aggiunge vatRate (default 10, CHECK in 4/5/10/22)
--   4. ALTER retailers: aggiunge pricingPackageId, ficClientId
--   5. Tabella systemIntegrations (singleton per type, FiC OAuth tokens)
--   6. Tabella proformaQueue (retry MANUALE chiamate FiC fallite)
--   7. ALTER stockMovements: ficProformaId, ficProformaNumber
--   8. RLS policies coerenti con pattern esistente
--   9. Indici performance
--
-- NOTE M3:
-- - Retry proforma e' MANUALE (pulsante in /movements), no cron Vercel.
-- - Legacy retailers.fattureInCloud* NON droppato qui (rollback safety),
--   sara' rimosso in 0006 dopo prod-stable.
-- - stockMovements.inventoryId/retailerId dead-column NON droppati qui,
--   cleanup completo legacy rinviato a 0006.

-- ============================================================
-- 1. ENUM proforma_queue_status
-- ============================================================
CREATE TYPE "public"."proforma_queue_status" AS ENUM (
  'pending', 'processing', 'success', 'failed'
);
--> statement-breakpoint

-- ============================================================
-- 2. pricingPackages + seed
-- ============================================================
CREATE TABLE "pricingPackages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(100) NOT NULL UNIQUE,
  "discountPercent" numeric(5,2) NOT NULL,
  "description" text,
  "sortOrder" integer DEFAULT 0 NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pricingPackages_discount_range"
    CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100)
);
--> statement-breakpoint

INSERT INTO "pricingPackages" ("name", "discountPercent", "sortOrder", "description")
VALUES
  ('Starter', 30.00, 1, 'Pacchetto introduttivo per nuovi rivenditori'),
  ('Partner', 35.00, 2, 'Pacchetto standard per rivenditori attivi'),
  ('Premium', 40.00, 3, 'Pacchetto avanzato con maggiori volumi'),
  ('Elite',   45.00, 4, 'Pacchetto top tier per partner strategici')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

-- ============================================================
-- 3. ALTER products — aggiunge vatRate
-- ============================================================
ALTER TABLE "products"
  ADD COLUMN "vatRate" numeric(5,2) NOT NULL DEFAULT 10.00;
--> statement-breakpoint

ALTER TABLE "products"
  ADD CONSTRAINT "products_vatRate_valid"
  CHECK ("vatRate" IN (4.00, 5.00, 10.00, 22.00));
--> statement-breakpoint

COMMENT ON COLUMN "products"."vatRate" IS
  'Aliquota IVA italiana applicata al prodotto. Default 10% (alimentari). 22% per birre/bevande.';
--> statement-breakpoint

-- ============================================================
-- 4. ALTER retailers — pricingPackageId + ficClientId
-- ============================================================
ALTER TABLE "retailers"
  ADD COLUMN "pricingPackageId" uuid;
--> statement-breakpoint
ALTER TABLE "retailers"
  ADD COLUMN "ficClientId" integer;
--> statement-breakpoint

ALTER TABLE "retailers"
  ADD CONSTRAINT "retailers_pricingPackageId_fkey"
  FOREIGN KEY ("pricingPackageId")
  REFERENCES "pricingPackages"("id") ON DELETE SET NULL;
--> statement-breakpoint

COMMENT ON COLUMN "retailers"."pricingPackageId" IS
  'Pacchetto commerciale assegnato. NULL = non assegnato → blocca generazione proforma.';
--> statement-breakpoint
COMMENT ON COLUMN "retailers"."ficClientId" IS
  'ID cliente in anagrafica Fatture in Cloud (single-tenant SoKeto). NULL = non mappato → blocca generazione proforma.';
--> statement-breakpoint

CREATE INDEX "retailers_pricingPackageId_idx"
  ON "retailers" ("pricingPackageId")
  WHERE "pricingPackageId" IS NOT NULL;
--> statement-breakpoint

-- ============================================================
-- 5. systemIntegrations — singleton per type
-- ============================================================
CREATE TABLE "systemIntegrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" varchar(50) NOT NULL UNIQUE,
  "accessToken" text,
  "refreshToken" text,
  "expiresAt" timestamp with time zone,
  "accountId" varchar(100),
  "scopes" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

COMMENT ON TABLE "systemIntegrations" IS
  'Integrazioni a livello sistema (singleton per type). Es: FiC OAuth tokens single-tenant SoKeto.';
--> statement-breakpoint

-- ============================================================
-- 6. proformaQueue — retry MANUALE per chiamate FiC fallite
-- ============================================================
CREATE TABLE "proformaQueue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transferMovementId" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "status" proforma_queue_status DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "maxAttempts" integer DEFAULT 5 NOT NULL,
  "lastError" text,
  "lastAttemptAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "proformaQueue_transferMovementId_fkey"
    FOREIGN KEY ("transferMovementId")
    REFERENCES "stockMovements"("id") ON DELETE CASCADE,
  CONSTRAINT "proformaQueue_attempts_nonneg"
    CHECK ("attempts" >= 0 AND "attempts" <= "maxAttempts")
);
--> statement-breakpoint

CREATE INDEX "proformaQueue_status_idx"
  ON "proformaQueue" ("status")
  WHERE "status" IN ('pending', 'failed');
--> statement-breakpoint

COMMENT ON TABLE "proformaQueue" IS
  'Coda retry per generazione proforma FiC. Retry MANUALE da /movements (pulsante "Riprova proforma in coda"). M3: no cron Vercel.';
--> statement-breakpoint

-- ============================================================
-- 7. ALTER stockMovements — riferimento proforma generata
-- ============================================================
ALTER TABLE "stockMovements"
  ADD COLUMN "ficProformaId" integer;
--> statement-breakpoint
ALTER TABLE "stockMovements"
  ADD COLUMN "ficProformaNumber" varchar(50);
--> statement-breakpoint

COMMENT ON COLUMN "stockMovements"."ficProformaId" IS
  'ID proforma generata su Fatture in Cloud (numerico FiC). NULL = nessuna proforma associata o ancora in coda.';
--> statement-breakpoint
COMMENT ON COLUMN "stockMovements"."ficProformaNumber" IS
  'Numero proforma assegnato da FiC (string user-facing, es. "PRO/2026/123").';
--> statement-breakpoint

-- ============================================================
-- 8. RLS — replica pattern da 0002 / 0003
-- ============================================================

-- pricingPackages: SELECT a tutti, MODIFY admin-only (leva commerciale)
ALTER TABLE public."pricingPackages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pricingPackages_select_authenticated" ON public."pricingPackages"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "pricingPackages_modify_admin" ON public."pricingPackages"
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');
--> statement-breakpoint

-- systemIntegrations: admin-only (contiene token OAuth)
ALTER TABLE public."systemIntegrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "systemIntegrations_admin_only" ON public."systemIntegrations"
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');
--> statement-breakpoint

-- proformaQueue: SELECT a tutti, MODIFY admin/operator
ALTER TABLE public."proformaQueue" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "proformaQueue_select_authenticated" ON public."proformaQueue"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "proformaQueue_modify_admin_operator" ON public."proformaQueue"
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint
