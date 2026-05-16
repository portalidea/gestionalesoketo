-- Migration 0014: M7-B Affiliate Portal — user role extension + affiliateId
-- NOTA: ALTER TYPE ADD VALUE richiede esecuzione fuori transazione.
-- Su Supabase SQL Editor, eseguire ogni blocco DO $$ separatamente.

-- 1. Estendi enum user_role con affiliate_user
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'affiliate_user';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
COMMIT;

-- 2. Estendi enum user_role con affiliate_admin
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'affiliate_admin';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
COMMIT;

-- 3. Aggiungi colonna affiliateId su users
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS "affiliateId" UUID REFERENCES affiliates(id) ON DELETE CASCADE;

-- 4. Constraint: un user può avere SOLO retailerId OPPURE affiliateId, non entrambi
ALTER TABLE users 
  ADD CONSTRAINT users_retailer_or_affiliate_check 
  CHECK (
    ("retailerId" IS NULL AND "affiliateId" IS NULL) OR
    ("retailerId" IS NOT NULL AND "affiliateId" IS NULL) OR
    ("retailerId" IS NULL AND "affiliateId" IS NOT NULL)
  );

-- 5. Indice per lookup users by affiliateId
CREATE INDEX IF NOT EXISTS idx_users_affiliate ON users("affiliateId") 
  WHERE "affiliateId" IS NOT NULL;
