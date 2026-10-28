-- 0049 — Eccezioni di evasione per riga ordine
--
-- Applicare manualmente su Supabase PRIMA del deploy del codice che usa
-- `order_item_fulfillment_exceptions`. Nessun backfill: le eccezioni sono
-- create esclusivamente dall'azione amministrativa esplicita al momento della
-- consegna. Nessun INSERT/UPDATE/DELETE dati applicativi in questa migration.
--
-- Contratto:
-- - reallocated: il lotto storico era assente/insufficiente, ma il prodotto era
--   disponibile nel centrale; la riga viene riallocata FEFO e trasferita normalmente.
-- - no_stock_movement: il lotto storico era a zero e il prodotto non aveva quantità
--   sufficiente nel centrale; la riga viene chiusa senza movimento/giacenza fittizi.

BEGIN;

-- 1. Espande lo storico delle transizioni: quando almeno una riga usa una
--    delle due eccezioni, la transizione di evasione è attribuita a questa origine.
ALTER TABLE public.order_status_events
  DROP CONSTRAINT IF EXISTS order_status_events_source_check;

ALTER TABLE public.order_status_events
  ADD CONSTRAINT order_status_events_source_check
  CHECK (source IN ('manual_step', 'delivery_confirm', 'delivery_exception'));

COMMENT ON COLUMN public.order_status_events.source IS
  'Origine della transizione: manual_step, delivery_confirm oppure delivery_exception quando l''evasione include una o più eccezioni per riga.';

-- 2. Audit append-only di riga. `orderItemId` e `originalBatchId` sono UUID
--    di riferimento intenzionalmente senza FK: una riallocazione FEFO può
--    sostituire/spezzare la riga originale e i FK di orderItems.batchId usano
--    ON DELETE SET NULL. Gli snapshot mantengono perciò l'evidenza storica.
CREATE TABLE public.order_item_fulfillment_exceptions (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId"                         uuid NOT NULL,
  "orderId"                           uuid NOT NULL,
  "orderItemId"                       uuid NOT NULL,
  "productId"                         uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  "originalBatchId"                   uuid NOT NULL,
  "originalBatchNumberSnapshot"       text NOT NULL,
  "originalBatchExpirationSnapshot"   date NOT NULL,
  "productSkuSnapshot"                varchar(100) NOT NULL,
  "productNameSnapshot"               varchar(255) NOT NULL,
  "piecesPerUnitSnapshot"             integer NOT NULL,
  "quantityPackages"                  integer NOT NULL,
  "quantityPieces"                    integer NOT NULL,
  "originalBatchQuantityAtAction"     integer NOT NULL,
  "productCentralQuantityAtAction"    integer NOT NULL,
  "exceptionType"                     varchar(32) NOT NULL,
  "replacementAllocations"            jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason                               text NOT NULL,
  "actorUserId"                       uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "createdAt"                         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_item_fulfillment_exceptions_order_company_fkey
    FOREIGN KEY ("orderId", "companyId")
    REFERENCES public.orders (id, "companyId")
    ON DELETE RESTRICT,
  CONSTRAINT order_item_fulfillment_exceptions_order_item_unique
    UNIQUE ("orderItemId"),
  CONSTRAINT order_item_fulfillment_exceptions_batch_number_nonblank
    CHECK (length(btrim("originalBatchNumberSnapshot")) > 0),
  CONSTRAINT order_item_fulfillment_exceptions_sku_nonblank
    CHECK (length(btrim("productSkuSnapshot")) > 0),
  CONSTRAINT order_item_fulfillment_exceptions_name_nonblank
    CHECK (length(btrim("productNameSnapshot")) > 0),
  CONSTRAINT order_item_fulfillment_exceptions_quantities_valid
    CHECK (
      "piecesPerUnitSnapshot" > 0
      AND "quantityPackages" > 0
      AND "quantityPieces" = "quantityPackages" * "piecesPerUnitSnapshot"
      AND "originalBatchQuantityAtAction" >= 0
      AND "productCentralQuantityAtAction" >= 0
    ),
  CONSTRAINT order_item_fulfillment_exceptions_reason_nonblank
    CHECK (length(btrim(reason)) > 0),
  CONSTRAINT order_item_fulfillment_exceptions_type_contract
    CHECK (
      jsonb_typeof("replacementAllocations") = 'array'
      AND (
        (
          "exceptionType" = 'reallocated'
          AND "originalBatchQuantityAtAction" < "quantityPieces"
          AND "productCentralQuantityAtAction" >= "quantityPieces"
          AND jsonb_array_length("replacementAllocations") > 0
        )
        OR
        (
          "exceptionType" = 'no_stock_movement'
          AND "originalBatchQuantityAtAction" = 0
          AND "productCentralQuantityAtAction" < "quantityPieces"
          AND jsonb_array_length("replacementAllocations") = 0
        )
      )
    )
);

COMMENT ON TABLE public.order_item_fulfillment_exceptions IS
  'Audit append-only delle righe ordine evase con riallocazione FEFO o senza movimento di magazzino. Non sostituisce né crea stockMovements fittizi.';
COMMENT ON COLUMN public.order_item_fulfillment_exceptions."replacementAllocations" IS
  'Solo per exceptionType=reallocated: array snapshot delle allocazioni FEFO effettive ({batchId, batchNumber, expirationDate, quantityPackages, quantityPieces}). Per no_stock_movement è sempre [].';
COMMENT ON COLUMN public.order_item_fulfillment_exceptions."originalBatchQuantityAtAction" IS
  'Giacenza in pezzi del lotto storico nel centrale della company, bloccata al momento dell''azione.';
COMMENT ON COLUMN public.order_item_fulfillment_exceptions."productCentralQuantityAtAction" IS
  'Giacenza complessiva in pezzi del prodotto nel centrale della company, bloccata al momento dell''azione.';

-- Il primo indice serve il report per company + periodo; il secondo quando è
-- richiesto anche il filtro per tipo. L'indice per ordine serve dettaglio/timeline.
CREATE INDEX idx_order_item_fulfillment_exceptions_company_created
  ON public.order_item_fulfillment_exceptions ("companyId", "createdAt" DESC);
CREATE INDEX idx_order_item_fulfillment_exceptions_company_type_created
  ON public.order_item_fulfillment_exceptions ("companyId", "exceptionType", "createdAt" DESC);
CREATE INDEX idx_order_item_fulfillment_exceptions_order_created
  ON public.order_item_fulfillment_exceptions ("orderId", "createdAt" ASC);

-- L'audit non può essere corretto tramite UPDATE/DELETE silenziosi: una
-- correzione operativa richiede una nuova riga/evidenza, non la riscrittura
-- della scelta originaria dell'amministratore.
CREATE OR REPLACE FUNCTION public.prevent_order_item_fulfillment_exception_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'order_item_fulfillment_exceptions è append-only: UPDATE e DELETE non sono consentiti';
END;
$$;

CREATE TRIGGER trg_order_item_fulfillment_exceptions_append_only
  BEFORE UPDATE OR DELETE ON public.order_item_fulfillment_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_order_item_fulfillment_exception_mutation();

-- Server-only: come orders, order_status_events e retailer_allowances, il ruolo
-- runtime backend bypassa RLS; non esistono policy PostgREST permissive.
ALTER TABLE public.order_item_fulfillment_exceptions ENABLE ROW LEVEL SECURITY;

COMMIT;
