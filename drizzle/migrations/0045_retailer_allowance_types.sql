-- 0045 — Tipi di plafond e origine economica
--
-- Tipi supportati:
-- - restaurant_package: plafond prodotti per pacchetto ristoratore, valorizzato
--   con lo sconto Premium congelato al momento dell'attivazione;
-- - investor_benefit: 5% di un investimento SoKeto incassato, valorizzato a
--   prezzo al pubblico (sconto di valorizzazione 0%).
--
-- Il tipo -> company e il calcolo del 5% restano regole di servizio, perché
-- dipendono dal contesto business e non da identificativi hardcoded nel DB.
BEGIN;

-- La tabella è stata introdotta dalla 0043 e, prima del primo backfill,
-- non deve ancora contenere plafond. Il controllo evita di attribuire
-- implicitamente un tipo/origine non verificati a dati già esistenti.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.retailer_allowances) THEN
    RAISE EXCEPTION
      'Migration 0045 interrotta: esistono già retailer_allowances; classificare esplicitamente i record prima di aggiungere colonne obbligatorie';
  END IF;
END $$;

ALTER TABLE public.retailer_allowances
  ADD COLUMN "allowanceType" varchar(32) NOT NULL,
  ADD COLUMN "sourceAmount" numeric(12,2) NOT NULL,
  ADD COLUMN "sourceReference" text NOT NULL,
  ADD COLUMN "sourceReceivedAt" timestamptz NOT NULL;

-- Il ledger storico può rappresentare una quota finanziaria parziale,
-- senza modificare la quantità intera della riga ordine originaria.
ALTER TABLE public.retailer_allowance_consumptions
  ALTER COLUMN "coveredQuantity"
  TYPE numeric(12,6)
  USING "coveredQuantity"::numeric(12,6);

ALTER TABLE public.retailer_allowances
  ADD CONSTRAINT retailer_allowances_type_check
    CHECK ("allowanceType" IN ('restaurant_package', 'investor_benefit')),
  ADD CONSTRAINT retailer_allowances_source_amount_positive
    CHECK ("sourceAmount" > 0),
  ADD CONSTRAINT retailer_allowances_source_reference_nonblank
    CHECK (length(btrim("sourceReference")) > 0),
  ADD CONSTRAINT retailer_allowances_investor_valuation_check
    CHECK (
      "allowanceType" <> 'investor_benefit'
      OR "valuationDiscountPercent" = 0
    );

CREATE INDEX idx_retailer_allowances_type_company_status
  ON public.retailer_allowances ("allowanceType", "billingCompanyId", status);

COMMENT ON COLUMN public.retailer_allowances."allowanceType" IS
  'Tipo economico del plafond: restaurant_package o investor_benefit.';
COMMENT ON COLUMN public.retailer_allowances."sourceAmount" IS
  'Importo pagato per il pacchetto o investimento incassato che origina il plafond.';
COMMENT ON COLUMN public.retailer_allowances."sourceReference" IS
  'Contratto, accordo o riferimento dell’investimento/pacchetto di origine.';
COMMENT ON COLUMN public.retailer_allowances."sourceReceivedAt" IS
  'Data di incasso/ricezione dell’importo origine; per investor_benefit il servizio richiede sempre un investimento incassato.';

COMMIT;
