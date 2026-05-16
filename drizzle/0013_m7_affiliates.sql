-- M7-A: Affiliates module
-- Enum status affiliato
DO $$ BEGIN
  CREATE TYPE affiliate_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enum status commissione
DO $$ BEGIN
  CREATE TYPE commission_status AS ENUM ('pending', 'paid', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tabella affiliates
CREATE TABLE IF NOT EXISTS affiliates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  "taxCode" VARCHAR(20),
  "vatNumber" VARCHAR(20),
  iban VARCHAR(34),
  "referralCode" VARCHAR(50) NOT NULL UNIQUE,
  "firstOrderRate" DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  "recurringRate" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  status affiliate_status NOT NULL DEFAULT 'active',
  notes TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_affiliates_email ON affiliates(email);
CREATE INDEX IF NOT EXISTS idx_affiliates_referral ON affiliates("referralCode");
CREATE INDEX IF NOT EXISTS idx_affiliates_status ON affiliates(status);

-- Tabella affiliate_commissions
CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "affiliateId" UUID NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  "orderId" UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  "retailerId" UUID NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  "orderTotal" DECIMAL(10,2) NOT NULL,
  "commissionRate" DECIMAL(5,2) NOT NULL,
  "commissionAmount" DECIMAL(10,2) NOT NULL,
  "isFirstOrder" BOOLEAN NOT NULL DEFAULT false,
  status commission_status NOT NULL DEFAULT 'pending',
  "pendingAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "paidAt" TIMESTAMP WITH TIME ZONE,
  "paymentReference" TEXT,
  "voidedAt" TIMESTAMP WITH TIME ZONE,
  "voidedReason" TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commissions_affiliate ON affiliate_commissions("affiliateId");
CREATE INDEX IF NOT EXISTS idx_commissions_order ON affiliate_commissions("orderId");
CREATE INDEX IF NOT EXISTS idx_commissions_retailer ON affiliate_commissions("retailerId");
CREATE INDEX IF NOT EXISTS idx_commissions_status ON affiliate_commissions(status);
CREATE INDEX IF NOT EXISTS idx_commissions_pending 
  ON affiliate_commissions("pendingAt", status) 
  WHERE status = 'pending';

-- Modifica retailers
ALTER TABLE retailers 
  ADD COLUMN IF NOT EXISTS "affiliateId" UUID REFERENCES affiliates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "affiliateAssignedAt" TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_retailers_affiliate ON retailers("affiliateId") WHERE "affiliateId" IS NOT NULL;
