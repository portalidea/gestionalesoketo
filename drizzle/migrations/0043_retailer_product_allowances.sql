-- 0043 — Plafond prodotti inclusi per singola anagrafica retailer
--
-- Append-only. NON applicare automaticamente: la migration deve essere
-- revisionata e applicata manualmente su Supabase prima del push/deploy
-- del codice che la utilizza.
--
-- Modello deliberatamente per-retailer:
-- - un plafond appartiene a una sola anagrafica retailers;
-- - billingCompanyId deve coincidere con companyId del retailer;
-- - il ledger salva orderId e snapshot economici, non un collegamento
--   inter-company tra anagrafiche retailer.

BEGIN;

-- 1. Flag amministrativo sui pacchetti: Special resta leggibile sulle
-- anagrafiche già esistenti, ma non potrà essere assegnato a nuovi retailer
-- dal servizio/UI che applicheranno questo flag.
ALTER TABLE public."pricingPackages"
  ADD COLUMN IF NOT EXISTS "isAssignableToNewRetailers" boolean NOT NULL DEFAULT true;

UPDATE public."pricingPackages"
SET "isAssignableToNewRetailers" = false,
    "updatedAt" = now()
WHERE name = 'Special'
  AND "isAssignableToNewRetailers" IS DISTINCT FROM false;

COMMENT ON COLUMN public."pricingPackages"."isAssignableToNewRetailers" IS
  'Se false, il pacchetto non può essere assegnato a nuovi retailer: il servizio deve comunque mostrare quello già associato a un retailer esistente.';

-- 2. Backfill anagrafico confermato: la P. IVA proviene dal mapping/cache FiC
-- delle due company. Il blocco fail-closed non sovrascrive eventuali valori
-- diversi inseriti nel frattempo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.retailers
    WHERE id IN (
      '2631dd61-19b5-4eda-9c03-7a2eade5cc6b'::uuid,
      'a93a1255-520e-40ca-84b3-ae002d2ce1ab'::uuid
    )
      AND "vatNumber" IS NOT NULL
      AND "vatNumber" <> '01338920224'
  ) THEN
    RAISE EXCEPTION 'Backfill P. IVA ARIKI interrotto: una delle anagrafiche possiede già un valore diverso';
  END IF;

  UPDATE public.retailers
  SET "vatNumber" = '01338920224',
      "updatedAt" = now()
  WHERE id IN (
    '2631dd61-19b5-4eda-9c03-7a2eade5cc6b'::uuid,
    'a93a1255-520e-40ca-84b3-ae002d2ce1ab'::uuid
  )
    AND "vatNumber" IS DISTINCT FROM '01338920224';
END $$;

-- 3. Rende referenziabile la coppia (retailer, company) per far rispettare
-- via FK che la società fatturante del plafond coincida con quella del retailer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'retailers_id_company_unique'
      AND conrelid = 'public.retailers'::regclass
  ) THEN
    ALTER TABLE public.retailers
      ADD CONSTRAINT retailers_id_company_unique UNIQUE (id, "companyId");
  END IF;
END $$;

-- 4. Una attivazione/rinnovo del plafond per una singola anagrafica retailer.
CREATE TABLE IF NOT EXISTS public.retailer_allowances (
  id                                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailerId"                          uuid NOT NULL,
  "billingCompanyId"                    uuid NOT NULL,
  "initialAmount"                       numeric(12,2) NOT NULL,
  "valuationDiscountPercent"            numeric(5,2) NOT NULL,
  "activatedAt"                         timestamptz NOT NULL,
  "packageInvoiceReference"             text NOT NULL,
  "postExhaustionPricingPackageId"      uuid NOT NULL REFERENCES public."pricingPackages"(id) ON DELETE RESTRICT,
  status                                varchar(20) NOT NULL DEFAULT 'active',
  "predecessorAllowanceId"              uuid REFERENCES public.retailer_allowances(id) ON DELETE RESTRICT,
  notes                                 text,
  "createdBy"                           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  "createdAt"                           timestamptz NOT NULL DEFAULT now(),
  "updatedAt"                           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT retailer_allowances_retailer_company_fk
    FOREIGN KEY ("retailerId", "billingCompanyId")
    REFERENCES public.retailers (id, "companyId")
    ON DELETE RESTRICT,
  CONSTRAINT retailer_allowances_initial_amount_positive
    CHECK ("initialAmount" > 0),
  CONSTRAINT retailer_allowances_valuation_discount_range
    CHECK ("valuationDiscountPercent" >= 0 AND "valuationDiscountPercent" <= 100),
  CONSTRAINT retailer_allowances_invoice_reference_nonblank
    CHECK (length(btrim("packageInvoiceReference")) > 0),
  CONSTRAINT retailer_allowances_status_check
    CHECK (status IN ('active', 'exhausted', 'superseded', 'cancelled')),
  CONSTRAINT retailer_allowances_predecessor_not_self
    CHECK ("predecessorAllowanceId" IS NULL OR "predecessorAllowanceId" <> id)
);

COMMENT ON TABLE public.retailer_allowances IS
  'Attivazioni e rinnovi di plafond prodotti inclusi. Il plafond appartiene a una sola anagrafica retailer e la percentuale di valorizzazione resta congelata sulla riga.';

COMMENT ON COLUMN public.retailer_allowances."valuationDiscountPercent" IS
  'Sconto di valorizzazione congelato all’attivazione. Il servizio lo inizializza con lo sconto Premium vigente, salvo scelta amministrativa esplicita.';

COMMENT ON COLUMN public.retailer_allowances."billingCompanyId" IS
  'Società che ha fatturato il pacchetto; la FK composta impone che coincida con companyId del retailer titolare del plafond.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_retailer_allowances_one_active
  ON public.retailer_allowances ("retailerId")
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_retailer_allowances_retailer_activated
  ON public.retailer_allowances ("retailerId", "activatedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_retailer_allowances_billing_company_status
  ON public.retailer_allowances ("billingCompanyId", status);

-- 5. Ledger immutabile del consumo di una quota coperta dell’ordine.
-- orderId è obbligatorio: un backfill può quindi attribuire il consumo anche
-- a un ordine storico di una company differente da quella del retailer titolare.
-- orderItemId è opzionale e ON DELETE SET NULL perché il flusso di modifica
-- ordine può ricreare le righe; gli snapshot restano sempre disponibili.
CREATE TABLE IF NOT EXISTS public.retailer_allowance_consumptions (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "allowanceId"                     uuid NOT NULL REFERENCES public.retailer_allowances(id) ON DELETE RESTRICT,
  "orderId"                         uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  "orderItemId"                     uuid REFERENCES public."orderItems"(id) ON DELETE SET NULL,
  "entryType"                       varchar(20) NOT NULL DEFAULT 'consumption',
  "reversesConsumptionId"           uuid REFERENCES public.retailer_allowance_consumptions(id) ON DELETE RESTRICT,
  "coveredQuantity"                 integer NOT NULL,
  "listUnitPriceSnapshot"           numeric(12,2) NOT NULL,
  "valuationDiscountPercentSnapshot" numeric(5,2) NOT NULL,
  "consumptionAmount"               numeric(12,2) NOT NULL,
  "createdBy"                       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  "createdAt"                       timestamptz NOT NULL DEFAULT now(),
  "reversalReason"                  text,

  CONSTRAINT retailer_allowance_consumptions_list_price_nonnegative
    CHECK ("listUnitPriceSnapshot" >= 0),
  CONSTRAINT retailer_allowance_consumptions_discount_range
    CHECK ("valuationDiscountPercentSnapshot" >= 0 AND "valuationDiscountPercentSnapshot" <= 100),
  CONSTRAINT retailer_allowance_consumptions_entry_contract
    CHECK (
      (
        "entryType" = 'consumption'
        AND "reversesConsumptionId" IS NULL
        AND "coveredQuantity" > 0
        AND "consumptionAmount" > 0
        AND "reversalReason" IS NULL
      )
      OR
      (
        "entryType" = 'reversal'
        AND "reversesConsumptionId" IS NOT NULL
        AND "coveredQuantity" < 0
        AND "consumptionAmount" < 0
        AND "reversalReason" IS NOT NULL
        AND length(btrim("reversalReason")) > 0
      )
    )
);

COMMENT ON TABLE public.retailer_allowance_consumptions IS
  'Ledger append-only delle quote ordine coperte dal plafond. Un annullamento o una modifica inserisce una riga reversal negativa, senza sovrascrivere il consumo originale.';

CREATE INDEX IF NOT EXISTS idx_retailer_allowance_consumptions_allowance_active
  ON public.retailer_allowance_consumptions ("allowanceId", "createdAt");

CREATE INDEX IF NOT EXISTS idx_retailer_allowance_consumptions_order
  ON public.retailer_allowance_consumptions ("orderId");

CREATE INDEX IF NOT EXISTS idx_retailer_allowance_consumptions_order_item
  ON public.retailer_allowance_consumptions ("orderItemId")
  WHERE "orderItemId" IS NOT NULL;

-- Nessun INSERT su retailer_allowances o retailer_allowance_consumptions qui:
-- i valori dell'attivazione ARIKI (importo, data e fattura) saranno forniti e
-- il backfill sarà mostrato e confermato separatamente prima di ogni salvataggio.

COMMIT;
