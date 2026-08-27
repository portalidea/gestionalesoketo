-- Shopify: cutoff di import per-store.
-- Append-only. Applicare manualmente nel Supabase SQL Editor prima del deploy
-- del codice che legge la nuova colonna.
BEGIN;

ALTER TABLE public.sales_stores
  ADD COLUMN IF NOT EXISTS "orderImportStartDate" date;

COMMENT ON COLUMN public.sales_stores."orderImportStartDate" IS
  'Prima data nel calendario Europe/Rome ammessa per l''import automatico del canale. NULL blocca il servizio (fail closed).';

-- Il pregresso Shopify SoKeto è stato scaricato manualmente: impedire qualunque
-- importazione e conseguente scarico precedente al 1 settembre 2026.
UPDATE public.sales_stores
SET "orderImportStartDate" = DATE '2026-09-01',
    "updatedAt" = now()
WHERE channel = 'shopify'
  AND "companyId" = '00000000-0000-0000-0000-000000000002'
  AND "orderImportStartDate" IS NULL;

DO $$
DECLARE
  missing_cutoff_count integer;
BEGIN
  SELECT count(*)::int
    INTO missing_cutoff_count
  FROM public.sales_stores
  WHERE channel = 'shopify'
    AND "isActive" = true
    AND "orderImportStartDate" IS NULL;

  IF missing_cutoff_count > 0 THEN
    RAISE EXCEPTION
      'Configurazione Shopify incompleta: % store attivo/i senza orderImportStartDate',
      missing_cutoff_count;
  END IF;
END $$;

COMMIT;
