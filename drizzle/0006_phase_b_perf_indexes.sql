-- ============================================================
-- Phase B — Performance indexes su stockMovements (M3.0.7)
-- ============================================================
-- Migration scritta a mano (drizzle-kit non gestisce partial index
-- con WHERE NOT NULL).
--
-- Razionale: oggi `stockMovements` ha pochissime righe (1 in produzione
-- post-cleanup M2.5), quindi le query in /movements sono già <100ms.
-- Quando i transfer + receipt + write-off cresceranno (1k+ righe attese
-- entro fine 2026 a regime), i filtri di /movements iniziano a fare
-- Seq Scan: questa migration future-proof anticipa il problema.
--
-- Query coperte (`getStockMovementsAll` in server/db.ts):
--   - WHERE type = ?               → idx type
--   - WHERE fromLocationId = ? OR
--           toLocationId   = ?     → 2 partial idx
--   - WHERE batchId = ?            → partial idx (per ricerca lotto)
--   - ORDER BY timestamp DESC      → idx DESC (anche per altre query
--                                     listByLocation/listByRetailer)
--
-- Tutti i partial index escludono righe con valore NULL: la maggior parte
-- dei legacy stockMovements ha inventoryId/retailerId set ma batchId NULL,
-- viceversa per gli M1+ records. Partial = meno spazio + index più utile.
--
-- IF NOT EXISTS perché Postgres non li riapplicherebbe dato che il pattern
-- "drizzle-kit migrate" non è usato per queste migration manuali.

CREATE INDEX IF NOT EXISTS "stockMovements_type_idx"
  ON "stockMovements" ("type");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "stockMovements_timestamp_desc_idx"
  ON "stockMovements" ("timestamp" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "stockMovements_batchId_idx"
  ON "stockMovements" ("batchId")
  WHERE "batchId" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "stockMovements_fromLocationId_idx"
  ON "stockMovements" ("fromLocationId")
  WHERE "fromLocationId" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "stockMovements_toLocationId_idx"
  ON "stockMovements" ("toLocationId")
  WHERE "toLocationId" IS NOT NULL;
--> statement-breakpoint

-- Indice composito: la query di /movements più frequente è "lista per tipo
-- ordinata per data DESC" (es. tutti i TRANSFER recenti). Composite copre
-- entrambi senza richiedere bitmap merge dei due indici singoli.
CREATE INDEX IF NOT EXISTS "stockMovements_type_timestamp_idx"
  ON "stockMovements" ("type", "timestamp" DESC);
--> statement-breakpoint
