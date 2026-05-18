-- M8.1.1: Bundle support for channel variants
-- Allows a single Shopify variant (e.g. "BOX-COLAZIONE") to map to multiple internal products.

-- Flag isBundle on channel_variants
ALTER TABLE channel_variants 
  ADD COLUMN IF NOT EXISTS "isBundle" BOOLEAN NOT NULL DEFAULT false;

-- Tabella components per bundle
CREATE TABLE IF NOT EXISTS channel_variant_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "channelVariantId" UUID NOT NULL REFERENCES channel_variants(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  "quantity" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CHECK ("quantity" > 0)
);

CREATE INDEX IF NOT EXISTS idx_channel_variant_components_variant 
  ON channel_variant_components("channelVariantId");
CREATE INDEX IF NOT EXISTS idx_channel_variant_components_product 
  ON channel_variant_components("productId");
