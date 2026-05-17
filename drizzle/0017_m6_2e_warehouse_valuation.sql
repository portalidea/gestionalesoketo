-- M6.2.E — Valorizzazione Magazzino
-- Aggiunge colonna costPrice a products e productBatches

-- Costo standard prodotto (default per nuovi lotti)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS "costPrice" numeric(10,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN products."costPrice" IS
  'Costo unitario standard IVA esclusa: produzione + trasporto + oneri. Default per nuovi lotti. Solo admin visibility.';

-- Costo effettivo lotto (override del default prodotto)
ALTER TABLE "productBatches"
  ADD COLUMN IF NOT EXISTS "costPrice" numeric(10,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN "productBatches"."costPrice" IS
  'Costo effettivo unitario IVA esclusa per questo lotto specifico. Inizializzato da products.costPrice ma editabile. Usato per valorizzazione FEFO magazzino.';
