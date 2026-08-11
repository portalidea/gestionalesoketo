-- F16: Promotions table for retailer portal banners
-- Apply manually in Supabase SQL Editor

BEGIN;

CREATE TABLE IF NOT EXISTS promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL,
  description text NOT NULL DEFAULT '',
  discount_percent numeric,
  "productId" uuid REFERENCES products(id) ON DELETE SET NULL,
  valid_from timestamptz NOT NULL DEFAULT NOW(),
  valid_to timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  banner_color varchar(20) DEFAULT '#7AB648',
  "createdAt" timestamptz DEFAULT NOW(),
  "updatedAt" timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_company_active ON promotions(company_id, is_active, valid_from, valid_to);

COMMIT;
