-- Promozioni temporanee del modulo ordine prospect.
-- Append-only. Da applicare manualmente nel Supabase SQL Editor SOLO dopo revisione.
-- Questa migration non aggiunge né modifica i campi spedizione degli ordini:
-- shippingNet, shippingVatRate, shippingVatAmount e freeShippingApplied
-- sono già stati aggiunti dalla migration 0031 applicata in produzione.
--
-- Il primo rilascio applicativo utilizzerà soltanto benefit_type = 'tier_upgrade'.
-- Gli altri due tipi sono modellati e vincolati qui, ma non verranno selezionati
-- dal calcolo, mostrati nel modulo o materializzati in ordini finché non approvati.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.prospect_promotions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  title               varchar(255) NOT NULL,
  public_description  text NOT NULL DEFAULT '',
  internal_notes      text,
  valid_from          timestamptz NOT NULL,
  valid_to            timestamptz NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  created_by          uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_promotions_title_nonblank
    CHECK (length(btrim(title)) > 0),
  CONSTRAINT prospect_promotions_window_valid
    CHECK (valid_to > valid_from),
  CONSTRAINT prospect_promotions_id_company_unique
    UNIQUE (id, company_id)
);

COMMENT ON TABLE public.prospect_promotions IS
  'Campagne temporanee applicate a tutti gli inviti prospect attivi della company. Ogni campagna vale solo sul primo ordine inviato durante la sua validità.';

COMMENT ON COLUMN public.prospect_promotions.public_description IS
  'Testo esposto nel modulo prospect per spiegare la condizione commerciale; non deve contenere claim sanitari.';

-- Una sola campagna live per company nello stesso intervallo. Il range è
-- semiaperto [inizio, fine): una campagna può iniziare nell’istante in cui
-- termina la precedente senza essere considerata sovrapposta.
ALTER TABLE public.prospect_promotions
  ADD CONSTRAINT prospect_promotions_no_active_overlap
  EXCLUDE USING gist (
    company_id WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  )
  WHERE (is_active);

CREATE TABLE IF NOT EXISTS public.prospect_promotion_benefits (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id            uuid NOT NULL REFERENCES public.prospect_promotions(id) ON DELETE CASCADE,
  benefit_type            varchar(30) NOT NULL,
  sort_order              integer NOT NULL DEFAULT 0,

  -- tier_upgrade
  qualifying_tier_code    varchar(50),
  granted_tier_code       varchar(50),

  -- gift_product (modellato, non implementato nel primo rilascio)
  gift_threshold_net      numeric(10,2),
  gift_product_id         uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  gift_quantity           integer,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_promotion_benefits_type_valid
    CHECK (benefit_type IN ('tier_upgrade', 'free_shipping', 'gift_product')),
  CONSTRAINT prospect_promotion_benefits_sort_order_nonnegative
    CHECK (sort_order >= 0),
  CONSTRAINT prospect_promotion_benefits_one_type_per_campaign
    UNIQUE (promotion_id, benefit_type),
  CONSTRAINT prospect_promotion_benefits_configuration_valid
    CHECK (
      (
        benefit_type = 'tier_upgrade'
        AND qualifying_tier_code IS NOT NULL
        AND length(btrim(qualifying_tier_code)) > 0
        AND granted_tier_code IS NOT NULL
        AND length(btrim(granted_tier_code)) > 0
        AND qualifying_tier_code <> granted_tier_code
        AND gift_threshold_net IS NULL
        AND gift_product_id IS NULL
        AND gift_quantity IS NULL
      )
      OR (
        benefit_type = 'free_shipping'
        AND qualifying_tier_code IS NULL
        AND granted_tier_code IS NULL
        AND gift_threshold_net IS NULL
        AND gift_product_id IS NULL
        AND gift_quantity IS NULL
      )
      OR (
        benefit_type = 'gift_product'
        AND qualifying_tier_code IS NULL
        AND granted_tier_code IS NULL
        AND gift_threshold_net IS NOT NULL
        AND gift_threshold_net >= 0
        AND gift_product_id IS NOT NULL
        AND gift_quantity IS NOT NULL
        AND gift_quantity > 0
      )
    )
);

COMMENT ON TABLE public.prospect_promotion_benefits IS
  'Benefici di una campagna prospect. V1 abilita soltanto tier_upgrade; free_shipping e gift_product sono volutamente inerti finché non avranno un flusso applicativo approvato.';

CREATE INDEX IF NOT EXISTS idx_prospect_promotion_benefits_promotion_sort
  ON public.prospect_promotion_benefits (promotion_id, sort_order, id);

-- Necessaria alle FK composte che assicurano l’isolamento company anche per
-- i termini congelati di un ordine prospect.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'prospect_simulations_id_company_unique'
      AND conrelid = 'public.prospect_simulations'::regclass
  ) THEN
    ALTER TABLE public.prospect_simulations
      ADD CONSTRAINT prospect_simulations_id_company_unique
      UNIQUE (id, company_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.prospect_order_commercial_terms (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL,
  simulation_id                 uuid NOT NULL,
  invitation_id                 uuid NOT NULL,
  promotion_id                  uuid NOT NULL,
  real_tier_code                varchar(50) NOT NULL,
  pricing_tier_code             varchar(50) NOT NULL,
  applied_benefits_snapshot     jsonb NOT NULL DEFAULT '[]'::jsonb,
  priced_items_snapshot         jsonb NOT NULL DEFAULT '[]'::jsonb,
  merchandise_net               numeric(10,2) NOT NULL,
  shipping_net                  numeric(10,2) NOT NULL DEFAULT 0,
  shipping_vat_rate             numeric(5,2),
  shipping_vat_amount           numeric(10,2) NOT NULL DEFAULT 0,
  free_shipping_applied         boolean NOT NULL DEFAULT false,
  vat_amount                    numeric(10,2) NOT NULL,
  total_gross                   numeric(10,2) NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_order_terms_simulation_unique UNIQUE (simulation_id),
  CONSTRAINT prospect_order_terms_invitation_unique UNIQUE (invitation_id),
  CONSTRAINT prospect_order_terms_real_tier_nonblank
    CHECK (length(btrim(real_tier_code)) > 0),
  CONSTRAINT prospect_order_terms_pricing_tier_nonblank
    CHECK (length(btrim(pricing_tier_code)) > 0),
  CONSTRAINT prospect_order_terms_benefits_array
    CHECK (jsonb_typeof(applied_benefits_snapshot) = 'array'),
  CONSTRAINT prospect_order_terms_items_array
    CHECK (jsonb_typeof(priced_items_snapshot) = 'array'),
  CONSTRAINT prospect_order_terms_merchandise_nonnegative
    CHECK (merchandise_net >= 0),
  CONSTRAINT prospect_order_terms_shipping_nonnegative
    CHECK (shipping_net >= 0 AND shipping_vat_amount >= 0),
  CONSTRAINT prospect_order_terms_vat_nonnegative
    CHECK (vat_amount >= 0),
  CONSTRAINT prospect_order_terms_total_nonnegative
    CHECK (total_gross >= 0),
  CONSTRAINT prospect_order_terms_simulation_company_fkey
    FOREIGN KEY (simulation_id, company_id)
    REFERENCES public.prospect_simulations (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT prospect_order_terms_invitation_company_fkey
    FOREIGN KEY (invitation_id, company_id)
    REFERENCES public.prospect_invitations (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT prospect_order_terms_promotion_company_fkey
    FOREIGN KEY (promotion_id, company_id)
    REFERENCES public.prospect_promotions (id, company_id)
    ON DELETE RESTRICT
);

COMMENT ON TABLE public.prospect_order_commercial_terms IS
  'Contratto commerciale immutabile del primo ordine prospect con promozione. Conserva tier reale, tier prezzo, righe e totali congelati al submit; non ricalcola dai listini alla conversione.';

CREATE INDEX IF NOT EXISTS idx_prospect_order_terms_company_created
  ON public.prospect_order_commercial_terms (company_id, created_at DESC);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS "prospectCommercialTermsId" uuid,
  ADD COLUMN IF NOT EXISTS "prospectCommercialTermsReleasedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "prospectCommercialTermsReleasedBy" uuid,
  ADD COLUMN IF NOT EXISTS "prospectCommercialTermsReleaseReason" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_prospect_commercial_terms_fkey'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_prospect_commercial_terms_fkey
      FOREIGN KEY ("prospectCommercialTermsId")
      REFERENCES public.prospect_order_commercial_terms(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_prospect_terms_released_by_fkey'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_prospect_terms_released_by_fkey
      FOREIGN KEY ("prospectCommercialTermsReleasedBy")
      REFERENCES public.users(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_prospect_terms_release_audit_valid'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_prospect_terms_release_audit_valid
      CHECK (
        (
          "prospectCommercialTermsId" IS NULL
          AND "prospectCommercialTermsReleasedAt" IS NULL
          AND "prospectCommercialTermsReleasedBy" IS NULL
          AND "prospectCommercialTermsReleaseReason" IS NULL
        )
        OR (
          "prospectCommercialTermsReleasedAt" IS NULL
          AND "prospectCommercialTermsReleasedBy" IS NULL
          AND "prospectCommercialTermsReleaseReason" IS NULL
        )
        OR (
          "prospectCommercialTermsId" IS NOT NULL
          AND
          "prospectCommercialTermsReleasedAt" IS NOT NULL
          AND "prospectCommercialTermsReleasedBy" IS NOT NULL
          AND length(btrim("prospectCommercialTermsReleaseReason")) > 0
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_prospect_commercial_terms_unique
  ON public.orders ("prospectCommercialTermsId")
  WHERE "prospectCommercialTermsId" IS NOT NULL;

-- Il lock è attivo quando l’ordine punta ai termini e la rinuncia non è stata
-- auditata. Il codice di modifica ordine dovrà bloccare il ricalcolo in tal caso.
CREATE INDEX IF NOT EXISTS idx_orders_prospect_terms_locked
  ON public.orders ("prospectCommercialTermsId")
  WHERE "prospectCommercialTermsId" IS NOT NULL
    AND "prospectCommercialTermsReleasedAt" IS NULL;

ALTER TABLE public.prospect_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_promotion_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_order_commercial_terms ENABLE ROW LEVEL SECURITY;

COMMIT;
