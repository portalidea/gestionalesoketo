-- 0048 — Promozioni prospect "Pacchetto con servizio e bonus"
--
-- Append-only. Applicare manualmente su Supabase PRIMA del deploy del codice.
--
-- Estende le promozioni prospect senza alterare le campagne tier_upgrade
-- esistenti. Le righe servizio sono volutamente separate da orderItems:
-- non rappresentano merce, quindi non devono mai entrare in FEFO, lotti,
-- stock, trasferimenti o DDT.
--
-- Il bonus promo viene creato solo dal servizio server-side dopo la
-- registrazione del pagamento, confrontando orders.paidAt con la data
-- configurata. Questa migration prepara l'audit e l'idempotenza DB.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tipo della campagna prospect: le campagne esistenti restano tier_upgrade
-- ---------------------------------------------------------------------------
ALTER TABLE public.prospect_promotions
  ADD COLUMN IF NOT EXISTS rule_type varchar(32) NOT NULL DEFAULT 'tier_upgrade';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'prospect_promotions_rule_type_check'
      AND conrelid = 'public.prospect_promotions'::regclass
  ) THEN
    ALTER TABLE public.prospect_promotions
      ADD CONSTRAINT prospect_promotions_rule_type_check
      CHECK (rule_type IN ('tier_upgrade', 'service_package'));
  END IF;
END $$;

COMMENT ON COLUMN public.prospect_promotions.rule_type IS
  'Tipo regola della campagna: tier_upgrade (storico) o service_package (pacchetto con servizio e bonus facoltativo).';

-- Configurazione uno-a-uno usata soltanto per rule_type = service_package.
-- L'applicazione verifica server-side il tipo della campagna e risolve il
-- package esclusivamente fra Starter, Partner, Premium ed Elite; Special non
-- è una scelta valida.
CREATE TABLE IF NOT EXISTS public.prospect_promotion_service_packages (
  promotion_id                    uuid PRIMARY KEY,
  company_id                      uuid NOT NULL,
  assigned_tier_code              varchar(50) NOT NULL,
  service_code                    varchar(100) NOT NULL DEFAULT 'PROSPECT_SERVICE',
  service_name                    text NOT NULL,
  service_net                     numeric(12,2) NOT NULL,
  service_vat_rate                numeric(5,2) NOT NULL DEFAULT 22.00,
  minimum_merchandise_net         numeric(12,2) NOT NULL,
  bonus_amount                    numeric(12,2),
  bonus_payment_deadline          date,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_service_package_promotion_company_fkey
    FOREIGN KEY (promotion_id, company_id)
    REFERENCES public.prospect_promotions (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT prospect_service_package_tier_code_nonblank
    CHECK (length(btrim(assigned_tier_code)) > 0),
  CONSTRAINT prospect_service_package_code_nonblank
    CHECK (length(btrim(service_code)) > 0),
  CONSTRAINT prospect_service_package_name_nonblank
    CHECK (length(btrim(service_name)) > 0),
  CONSTRAINT prospect_service_package_service_net_positive
    CHECK (service_net > 0),
  CONSTRAINT prospect_service_package_service_vat_valid
    CHECK (service_vat_rate IN (4.00, 5.00, 10.00, 22.00)),
  CONSTRAINT prospect_service_package_minimum_nonnegative
    CHECK (minimum_merchandise_net >= 0),
  CONSTRAINT prospect_service_package_bonus_complete
    CHECK (
      (bonus_amount IS NULL AND bonus_payment_deadline IS NULL)
      OR (
        bonus_amount IS NOT NULL
        AND bonus_amount > 0
        AND bonus_payment_deadline IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_prospect_service_packages_company
  ON public.prospect_promotion_service_packages (company_id, promotion_id);

COMMENT ON TABLE public.prospect_promotion_service_packages IS
  'Configurazione della regola prospect service_package. Il servizio applicativo valida che appartenga a una campagna service_package e che assigned_tier_code risolva un package consentito.';

-- ---------------------------------------------------------------------------
-- 2. Contratto prospect congelato: servizio e bonus restano immutabili
-- ---------------------------------------------------------------------------
ALTER TABLE public.prospect_order_commercial_terms
  ADD COLUMN IF NOT EXISTS rule_type varchar(32) NOT NULL DEFAULT 'tier_upgrade',
  ADD COLUMN IF NOT EXISTS service_line_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS bonus_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS service_net numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_vat_rate numeric(5,2),
  ADD COLUMN IF NOT EXISTS service_vat_amount numeric(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'prospect_order_terms_rule_type_check'
      AND conrelid = 'public.prospect_order_commercial_terms'::regclass
  ) THEN
    ALTER TABLE public.prospect_order_commercial_terms
      ADD CONSTRAINT prospect_order_terms_rule_type_check
      CHECK (rule_type IN ('tier_upgrade', 'service_package'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'prospect_order_terms_service_snapshot_valid'
      AND conrelid = 'public.prospect_order_commercial_terms'::regclass
  ) THEN
    ALTER TABLE public.prospect_order_commercial_terms
      ADD CONSTRAINT prospect_order_terms_service_snapshot_valid
      CHECK (
        (
          rule_type = 'tier_upgrade'
          AND service_net = 0
          AND service_vat_rate IS NULL
          AND service_vat_amount = 0
          AND service_line_snapshot IS NULL
          AND bonus_snapshot IS NULL
        )
        OR
        (
          rule_type = 'service_package'
          AND service_net > 0
          AND service_vat_rate IN (4.00, 5.00, 10.00, 22.00)
          AND service_vat_amount >= 0
          AND jsonb_typeof(service_line_snapshot) = 'object'
          AND (bonus_snapshot IS NULL OR jsonb_typeof(bonus_snapshot) = 'object')
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.prospect_order_commercial_terms.service_line_snapshot IS
  'Snapshot immutabile della riga servizio del pacchetto prospect; non è una riga prodotto né di magazzino.';
COMMENT ON COLUMN public.prospect_order_commercial_terms.bonus_snapshot IS
  'Snapshot del bonus condizionato al pagamento, inclusa scadenza e valorizzazione 0%; nullo quando il pacchetto non prevede bonus.';

-- ---------------------------------------------------------------------------
-- 3. Righe servizio ordine: isolate dalla merce, da FEFO e dal magazzino
-- ---------------------------------------------------------------------------
-- La FK composta impedisce che una riga servizio sia associata a una company
-- diversa da quella dell'ordine. La coppia (id, companyId) è tecnicamente
-- unica perché id è già PK; viene aggiunta per poterla referenziare.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_id_company_unique'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_id_company_unique UNIQUE (id, "companyId");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.order_service_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderId"           uuid NOT NULL,
  "companyId"         uuid NOT NULL,
  "sourcePromotionId" uuid,
  service_code        varchar(100) NOT NULL,
  service_name        text NOT NULL,
  quantity            numeric(12,3) NOT NULL DEFAULT 1,
  unit_price_net      numeric(12,2) NOT NULL,
  vat_rate            numeric(5,2) NOT NULL,
  line_total_net      numeric(12,2) NOT NULL,
  line_total_gross    numeric(12,2) NOT NULL,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_service_lines_order_company_fkey
    FOREIGN KEY ("orderId", "companyId")
    REFERENCES public.orders (id, "companyId")
    ON DELETE CASCADE,
  CONSTRAINT order_service_lines_promotion_company_fkey
    FOREIGN KEY ("sourcePromotionId", "companyId")
    REFERENCES public.prospect_promotions (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT order_service_lines_code_nonblank
    CHECK (length(btrim(service_code)) > 0),
  CONSTRAINT order_service_lines_name_nonblank
    CHECK (length(btrim(service_name)) > 0),
  CONSTRAINT order_service_lines_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT order_service_lines_unit_net_nonnegative
    CHECK (unit_price_net >= 0),
  CONSTRAINT order_service_lines_vat_valid
    CHECK (vat_rate IN (4.00, 5.00, 10.00, 22.00)),
  CONSTRAINT order_service_lines_totals_nonnegative
    CHECK (line_total_net >= 0 AND line_total_gross >= 0)
);

CREATE INDEX IF NOT EXISTS idx_order_service_lines_order
  ON public.order_service_lines ("orderId");
CREATE INDEX IF NOT EXISTS idx_order_service_lines_company
  ON public.order_service_lines ("companyId", "createdAt" DESC);

COMMENT ON TABLE public.order_service_lines IS
  'Righe di servizio non inventariate. Non devono essere incluse in FEFO, lotti, inventoryByBatch, stockMovements, trasferimenti o DDT; sono invece incluse nei totali ordine e nei documenti FiC.';

-- ---------------------------------------------------------------------------
-- 4. Bonus promo dopo pagamento: audit e idempotenza per ordine
-- ---------------------------------------------------------------------------
-- Estensione del CHECK introdotto dalla 0045. I plafond promo_bonus sono
-- valorizzati sempre a listino (sconto di valorizzazione 0%).
ALTER TABLE public.retailer_allowances
  DROP CONSTRAINT IF EXISTS retailer_allowances_type_check,
  DROP CONSTRAINT IF EXISTS retailer_allowances_investor_valuation_check,
  DROP CONSTRAINT IF EXISTS retailer_allowances_zero_valuation_types_check;

ALTER TABLE public.retailer_allowances
  ADD CONSTRAINT retailer_allowances_type_check
    CHECK ("allowanceType" IN ('restaurant_package', 'investor_benefit', 'promo_bonus')),
  ADD CONSTRAINT retailer_allowances_zero_valuation_types_check
    CHECK (
      "allowanceType" NOT IN ('investor_benefit', 'promo_bonus')
      OR "valuationDiscountPercent" = 0
    );

-- Un bonus promo può convivere con un plafond base attivo dello stesso retailer.
-- Conserviamo l'unicità per i soli plafond base, senza imporre una falsa
-- esclusività sui bonus creati da ordini promo differenti.
DROP INDEX IF EXISTS public.uq_retailer_allowances_one_active;
CREATE UNIQUE INDEX uq_retailer_allowances_one_active
  ON public.retailer_allowances ("retailerId")
  WHERE status = 'active'
    AND "allowanceType" <> 'promo_bonus';

CREATE TABLE IF NOT EXISTS public.order_promotion_bonuses (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderId"                     uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  "retailerId"                  uuid NOT NULL,
  "companyId"                   uuid NOT NULL,
  "promotionId"                 uuid NOT NULL,
  "allowanceId"                 uuid UNIQUE REFERENCES public.retailer_allowances(id) ON DELETE RESTRICT,
  bonus_amount                  numeric(12,2) NOT NULL,
  valuation_discount_percent    numeric(5,2) NOT NULL DEFAULT 0,
  payment_deadline               date NOT NULL,
  "paymentPaidAt"               timestamptz,
  status                        varchar(32) NOT NULL DEFAULT 'pending',
  "evaluatedAt"                 timestamptz,
  "grantedAt"                   timestamptz,
  "revokedAt"                   timestamptz,
  "reviewRequiredAt"            timestamptz,
  "createdBy"                   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  "updatedBy"                   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  "createdAt"                   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_promotion_bonuses_retailer_company_fkey
    FOREIGN KEY ("retailerId", "companyId")
    REFERENCES public.retailers (id, "companyId")
    ON DELETE RESTRICT,
  CONSTRAINT order_promotion_bonuses_promotion_company_fkey
    FOREIGN KEY ("promotionId", "companyId")
    REFERENCES public.prospect_promotions (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT order_promotion_bonuses_amount_positive
    CHECK (bonus_amount > 0),
  CONSTRAINT order_promotion_bonuses_valuation_zero
    CHECK (valuation_discount_percent = 0),
  CONSTRAINT order_promotion_bonuses_status_check
    CHECK (status IN ('pending', 'granted', 'expired', 'revoked', 'review_required')),
  CONSTRAINT order_promotion_bonuses_status_audit_valid
    CHECK (
      (
        status IN ('pending', 'expired')
        AND "allowanceId" IS NULL
        AND "grantedAt" IS NULL
        AND "revokedAt" IS NULL
        AND "reviewRequiredAt" IS NULL
      )
      OR (
        status = 'granted'
        AND "allowanceId" IS NOT NULL
        AND "paymentPaidAt" IS NOT NULL
        AND ("paymentPaidAt" AT TIME ZONE 'Europe/Rome')::date <= payment_deadline
        AND "grantedAt" IS NOT NULL
        AND "revokedAt" IS NULL
        AND "reviewRequiredAt" IS NULL
      )
      OR (
        status = 'revoked'
        AND "allowanceId" IS NOT NULL
        AND "paymentPaidAt" IS NOT NULL
        AND "grantedAt" IS NOT NULL
        AND "revokedAt" IS NOT NULL
        AND "reviewRequiredAt" IS NULL
      )
      OR (
        status = 'review_required'
        AND "allowanceId" IS NOT NULL
        AND "paymentPaidAt" IS NOT NULL
        AND "grantedAt" IS NOT NULL
        AND "reviewRequiredAt" IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_order_promotion_bonuses_company_status
  ON public.order_promotion_bonuses ("companyId", status, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_order_promotion_bonuses_retailer
  ON public.order_promotion_bonuses ("retailerId", "createdAt" DESC);

COMMENT ON TABLE public.order_promotion_bonuses IS
  'Audit/idempotenza del bonus promo condizionato al pagamento. Il servizio confronta orders.paidAt, non il timestamp di registrazione, con payment_deadline; un solo record e un solo plafond bonus sono consentiti per ordine.';
COMMENT ON COLUMN public.order_promotion_bonuses."allowanceId" IS
  'Plafond promo_bonus creato dopo pagamento entro la scadenza; nullo se pagamento tardivo o non ancora valutato.';

-- ---------------------------------------------------------------------------
-- 5. RLS server-only: nessuna policy PostgREST permissiva
-- ---------------------------------------------------------------------------
ALTER TABLE public.prospect_promotion_service_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_service_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_promotion_bonuses ENABLE ROW LEVEL SECURITY;

COMMIT;
