-- M8.1 — Shopify Integration: multi-channel schema
-- NOTE: ALTER TYPE ... ADD VALUE must run outside transaction.
-- In Supabase SQL Editor, run each DO $$ block separately if needed.

-- Enum canale
DO $$ BEGIN
  CREATE TYPE sales_channel AS ENUM ('shopify', 'amazon', 'temu', 'aliexpress', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Extend stock_movement type enum
DO $$ BEGIN
  ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'SHOPIFY_EXIT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'AMAZON_EXIT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'MARKETPLACE_RETURN';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tabella stores (per scalabilità multi-store futuro)
CREATE TABLE IF NOT EXISTS sales_stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel sales_channel NOT NULL,
  name VARCHAR(255) NOT NULL,
  "storeIdentifier" VARCHAR(255) NOT NULL,
  "apiCredentials" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastSyncAt" TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(channel, "storeIdentifier")
);

CREATE INDEX IF NOT EXISTS idx_stores_channel_active ON sales_stores(channel) WHERE "isActive" = true;

-- Tabella channel_variants
CREATE TABLE IF NOT EXISTS channel_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL REFERENCES sales_stores(id) ON DELETE CASCADE,
  "productId" UUID REFERENCES products(id) ON DELETE RESTRICT,
  "channelSku" VARCHAR(255) NOT NULL,
  "channelProductId" VARCHAR(255),
  "channelVariantId" VARCHAR(255),
  "displayName" VARCHAR(255),
  "multiplier" INTEGER NOT NULL DEFAULT 1,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE("storeId", "channelSku")
);

CREATE INDEX IF NOT EXISTS idx_channel_variants_product ON channel_variants("productId");
CREATE INDEX IF NOT EXISTS idx_channel_variants_active ON channel_variants("storeId") WHERE "isActive" = true;

-- Tabella marketplace_orders (audit + reporting, separata da orders retailer)
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL REFERENCES sales_stores(id) ON DELETE RESTRICT,
  "channelOrderId" VARCHAR(255) NOT NULL,
  "channelOrderNumber" VARCHAR(255),
  "customerEmail" VARCHAR(255),
  "customerName" VARCHAR(255),
  "orderDate" TIMESTAMP WITH TIME ZONE NOT NULL,
  "totalGross" DECIMAL(10,2),
  currency VARCHAR(3) DEFAULT 'EUR',
  "shippingCountry" VARCHAR(2),
  "rawPayload" JSONB,
  "syncedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "stockProcessedAt" TIMESTAMP WITH TIME ZONE,
  "stockProcessingStatus" VARCHAR(50) DEFAULT 'pending',
  "stockProcessingError" TEXT,
  "stockProcessingAttempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE("storeId", "channelOrderId")
);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status ON marketplace_orders("stockProcessingStatus");
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_date ON marketplace_orders("orderDate" DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_store ON marketplace_orders("storeId");

-- Tabella marketplace_order_items (snapshot ordini)
CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "marketplaceOrderId" UUID NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  "channelSku" VARCHAR(255) NOT NULL,
  "productId" UUID REFERENCES products(id) ON DELETE SET NULL,
  "channelVariantId" UUID REFERENCES channel_variants(id) ON DELETE SET NULL,
  "channelQuantity" INTEGER NOT NULL,
  "piecesQuantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(10,2),
  "lineTotal" DECIMAL(10,2),
  "displayName" VARCHAR(255),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_order_items_order ON marketplace_order_items("marketplaceOrderId");
CREATE INDEX IF NOT EXISTS idx_marketplace_order_items_product ON marketplace_order_items("productId");

-- Estendere stock_movements con riferimento marketplace
ALTER TABLE stock_movements 
  ADD COLUMN IF NOT EXISTS "marketplaceOrderId" UUID REFERENCES marketplace_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_marketplace ON stock_movements("marketplaceOrderId") WHERE "marketplaceOrderId" IS NOT NULL;
