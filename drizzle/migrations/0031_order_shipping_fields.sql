-- Campi spedizione ordine già applicati in produzione.
-- Ripristino versionato basato sul catalogo Supabase: non applicare di nuovo
-- in produzione; serve al replay locale e all’allineamento storico dello schema.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS "shippingNet" numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "shippingVatRate" numeric(5,2),
  ADD COLUMN IF NOT EXISTS "shippingVatAmount" numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "freeShippingApplied" boolean NOT NULL DEFAULT false;

COMMIT;
