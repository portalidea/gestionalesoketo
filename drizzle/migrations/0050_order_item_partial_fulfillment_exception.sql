-- 0050 — Evasione parziale con scarico del disponibile (opzione C)
-- Applicazione manuale su Supabase prima del deploy. Nessun backfill e nessuna
-- modifica a ordini, righe, giacenze o audit già registrati.
-- A/B restano compatibili con il codice precedente e con l'audit append-only.

BEGIN;

ALTER TABLE public.order_item_fulfillment_exceptions
  ADD COLUMN "stockMovementQuantityPieces" integer,
  ADD COLUMN "noStockMovementQuantityPieces" integer;

ALTER TABLE public.order_item_fulfillment_exceptions
  ADD CONSTRAINT order_item_fulfillment_exceptions_movement_quantities_valid
  CHECK (
    (
      "stockMovementQuantityPieces" IS NULL
      AND "noStockMovementQuantityPieces" IS NULL
      AND "exceptionType" IN ('reallocated', 'no_stock_movement')
    )
    OR
    (
      "stockMovementQuantityPieces" IS NOT NULL
      AND "noStockMovementQuantityPieces" IS NOT NULL
      AND "stockMovementQuantityPieces" >= 0
      AND "noStockMovementQuantityPieces" >= 0
      AND "stockMovementQuantityPieces" + "noStockMovementQuantityPieces" = "quantityPieces"
      AND (
        ("exceptionType" = 'reallocated' AND "stockMovementQuantityPieces" = "quantityPieces" AND "noStockMovementQuantityPieces" = 0)
        OR
        ("exceptionType" = 'no_stock_movement' AND "stockMovementQuantityPieces" = 0 AND "noStockMovementQuantityPieces" = "quantityPieces")
        OR
        ("exceptionType" = 'partial_no_stock_movement' AND "stockMovementQuantityPieces" > 0 AND "noStockMovementQuantityPieces" > 0)
      )
    )
  );

ALTER TABLE public.order_item_fulfillment_exceptions
  DROP CONSTRAINT order_item_fulfillment_exceptions_type_contract;

ALTER TABLE public.order_item_fulfillment_exceptions
  ADD CONSTRAINT order_item_fulfillment_exceptions_type_contract
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
      OR
      (
        "exceptionType" = 'partial_no_stock_movement'
        AND "originalBatchQuantityAtAction" >= 0
        AND "originalBatchQuantityAtAction" < "quantityPieces"
        AND "productCentralQuantityAtAction" > 0
        AND "productCentralQuantityAtAction" < "quantityPieces"
        AND "stockMovementQuantityPieces" IS NOT NULL
        AND "stockMovementQuantityPieces" > 0
        AND "stockMovementQuantityPieces" <= "productCentralQuantityAtAction"
        AND "noStockMovementQuantityPieces" IS NOT NULL
        AND "noStockMovementQuantityPieces" > 0
        AND jsonb_array_length("replacementAllocations") > 0
      )
    )
  );

COMMENT ON COLUMN public.order_item_fulfillment_exceptions."stockMovementQuantityPieces" IS
  'Pezzi effettivamente scaricati dal centrale e trasferiti: tutti per A, zero per B, solo disponibili per C. NULL esclusivamente per audit A/B anteriori alla 0050.';
COMMENT ON COLUMN public.order_item_fulfillment_exceptions."noStockMovementQuantityPieces" IS
  'Pezzi evasi senza alcun movimento o carico rivenditore: zero per A, tutti per B, parte mancante per C. La somma con i pezzi scaricati deve coincidere con quantityPieces.';
COMMENT ON COLUMN public.order_item_fulfillment_exceptions."exceptionType" IS
  'Scelta amministrativa: reallocated (A), no_stock_movement (B), partial_no_stock_movement (C).';
COMMENT ON COLUMN public.order_item_fulfillment_exceptions."replacementAllocations" IS
  'Snapshot delle allocazioni FEFO reali per A/C ({batchId, batchNumber, expirationDate, quantityPackages, quantityPieces}). Per B sempre []. Le quantità in pezzi sono autorevoli per C, senza modificare le quantità finanziarie della riga ordine.';
COMMENT ON TABLE public.order_item_fulfillment_exceptions IS
  'Audit append-only delle eccezioni A/B/C di evasione. Le quantità senza scarico non generano movimenti o giacenze fittizie. Nessun aggiornamento retroattivo dell''audit.';

-- Il trigger append-only, la UNIQUE per orderItemId e gli indici esistenti
-- restano invariati. Nessuna nuova policy permissiva.
ALTER TABLE public.order_item_fulfillment_exceptions ENABLE ROW LEVEL SECURITY;

COMMIT;
