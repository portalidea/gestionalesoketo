-- 0044 — Plafond prodotti: riferimento fattura opzionale
--
-- Necessaria per crediti/pacchetti concordati senza fattura emessa.
-- Da applicare manualmente su Supabase DOPO la 0043 e prima del codice
-- che crea un plafond con packageInvoiceReference NULL.

BEGIN;

ALTER TABLE public.retailer_allowances
  ALTER COLUMN "packageInvoiceReference" DROP NOT NULL;

ALTER TABLE public.retailer_allowances
  DROP CONSTRAINT IF EXISTS retailer_allowances_invoice_reference_nonblank;

ALTER TABLE public.retailer_allowances
  ADD CONSTRAINT retailer_allowances_invoice_reference_if_present_nonblank
  CHECK (
    "packageInvoiceReference" IS NULL
    OR length(btrim("packageInvoiceReference")) > 0
  );

COMMENT ON COLUMN public.retailer_allowances."packageInvoiceReference" IS
  'Riferimento della fattura del pacchetto; NULL solo per credito concordato senza fattura emessa.';

COMMIT;
