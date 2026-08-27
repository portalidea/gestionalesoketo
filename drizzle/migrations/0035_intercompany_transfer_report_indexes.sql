-- Travaso inter-company SoKeto → E-Keto.
-- REVIEW / MANUAL APPLY ONLY. Non introduce dati, tabelle o nuovi vincoli business.
-- Gli indici supportano il riepilogo mensile e la ricerca dei due TRANSFER
-- collegati da sourceDocumentType = 'intercompany_transfer'.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_stock_movements_intercompany_transfer_report
  ON public."stockMovements" ("timestamp" DESC, "companyId", "sourceDocument")
  WHERE "type" = 'TRANSFER'
    AND "sourceDocumentType" = 'intercompany_transfer';

CREATE INDEX IF NOT EXISTS idx_stock_movements_intercompany_transfer_item
  ON public."stockMovements" ("companyId", "sourceDocument", "batchId")
  WHERE "type" = 'TRANSFER'
    AND "sourceDocumentType" = 'intercompany_transfer';

COMMIT;
