-- ═══════════════════════════════════════════════════════════════
-- M6.2.D — Ordini Evento (fiere, omaggi, uso interno)
-- ═══════════════════════════════════════════════════════════════

-- 1. Drop NOT NULL su retailerId per permettere ordini senza retailer
ALTER TABLE orders ALTER COLUMN "retailerId" DROP NOT NULL;

-- 2. Enum per tipo evento
CREATE TYPE event_type_enum AS ENUM ('fair', 'event', 'gift', 'internal', 'other');

-- 3. Nuove colonne evento sulla tabella orders
ALTER TABLE orders
  ADD COLUMN "eventType" event_type_enum,
  ADD COLUMN "eventName" varchar(255),
  ADD COLUMN "eventDate" date,
  ADD COLUMN "fiscalReceiptRef" varchar(50);

-- 4. CHECK constraint: o retailer o evento, mai entrambi, mai nessuno
ALTER TABLE orders
  ADD CONSTRAINT "orders_retailer_or_event_check"
  CHECK (
    ("retailerId" IS NOT NULL AND "eventType" IS NULL) OR
    ("retailerId" IS NULL AND "eventType" IS NOT NULL)
  );

-- 5. Indice per filtro ordini evento
CREATE INDEX "orders_event_type_idx" ON orders("eventType")
  WHERE "eventType" IS NOT NULL;
