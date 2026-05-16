-- M6.2.B (Parte A) — Payment terms + order state machine extensions
-- Prerequisite: 0010_phase_b_m6_1_orders_auth.sql already applied

-- 1. Create payment_terms_enum
DO $$ BEGIN
  CREATE TYPE payment_terms_enum AS ENUM (
    'advance_transfer',
    'on_delivery',
    'credit_card',
    'manual'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add payment_terms to retailers
ALTER TABLE retailers 
  ADD COLUMN IF NOT EXISTS "paymentTerms" payment_terms_enum NOT NULL DEFAULT 'advance_transfer';

-- 3. Extend order_status enum with new values
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in some PG versions.
-- If this fails, run each ADD VALUE in a separate statement outside a transaction.
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'approved_for_shipping';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'paid_on_delivery';
-- 'cancelled' already exists from 0010

-- 4. Add new columns to orders
ALTER TABLE orders 
  ADD COLUMN IF NOT EXISTS "paymentTerms" payment_terms_enum NOT NULL DEFAULT 'advance_transfer',
  ADD COLUMN IF NOT EXISTS "ficInvoiceId" INTEGER,
  ADD COLUMN IF NOT EXISTS "ficInvoiceNumber" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "cancelledReason" TEXT,
  ADD COLUMN IF NOT EXISTS "approvedForShippingAt" TIMESTAMP WITH TIME ZONE;

-- 5. Indexes for FiC document tracking
CREATE INDEX IF NOT EXISTS idx_orders_fic_proforma ON orders("ficProformaId") WHERE "ficProformaId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_fic_invoice ON orders("ficInvoiceId") WHERE "ficInvoiceId" IS NOT NULL;

-- 6. Update status index to include new statuses
DROP INDEX IF EXISTS orders_status_idx;
CREATE INDEX orders_status_idx ON orders(status)
  WHERE status IN ('pending', 'paid', 'approved_for_shipping', 'transferring');
