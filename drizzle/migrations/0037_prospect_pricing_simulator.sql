-- Simulatore prezzi prospect rivenditori.
-- Append-only. Applicare manualmente nel Supabase SQL Editor DOPO revisione,
-- prima di pubblicare il codice che legge/scrive queste tabelle.
--
-- Il simulatore è separato da pricingPackages, tier_rules,
-- calculateOrderPricing, retailers e orders. Le fasce sono una configurazione
-- JSONB per company e non assegnano alcun tier al prospect.

BEGIN;

-- 1. Flag espliciti sul catalogo condiviso.
-- Nessun prodotto appare pubblicamente per default. La selezione iniziale
-- (prodotti del configuratore Excel) viene popolata manualmente dall'operatore.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS "showInSimulator" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "simulatorOrder" integer;

COMMENT ON COLUMN public.products."showInSimulator" IS
  'Se true, il prodotto è visibile nel simulatore pubblico prospect della company configurata.';

COMMENT ON COLUMN public.products."simulatorOrder" IS
  'Ordinamento facoltativo nel simulatore prospect; NULL viene dopo i valori numerici.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_simulator_order_nonnegative'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_simulator_order_nonnegative
      CHECK ("simulatorOrder" IS NULL OR "simulatorOrder" >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_simulator_visible_order
  ON public.products ("simulatorOrder", name)
  WHERE "showInSimulator" = true;

-- 2. Unica configurazione commerciale per company.
-- tiers deve essere un array esattamente di quattro oggetti nel formato:
-- [{"code":"starter","name":"Starter","discount_percent":38.50,"minimum_list_net":0.00}, ...]
-- Il servizio effettua anche la validazione semantica di code, soglie crescenti
-- e percentuali: il controllo SQL mantiene il contratto strutturale essenziale.
CREATE TABLE IF NOT EXISTS public.prospect_simulator_config (
  company_id                           uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  minimum_order_net                    numeric(10,2) NOT NULL DEFAULT 290.00,
  shipping_fee_net                     numeric(10,2) NOT NULL DEFAULT 18.00,
  free_shipping_threshold_net          numeric(10,2) NOT NULL DEFAULT 500.00,
  recommended_public_discount_percent  numeric(5,2) NOT NULL DEFAULT 10.00,
  display_stand_threshold              numeric(10,2) NOT NULL DEFAULT 790.00,
  privacy_policy_url                   text NOT NULL,
  tiers                                jsonb NOT NULL,
  updated_at                           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_simulator_config_minimum_order_nonnegative
    CHECK (minimum_order_net >= 0),
  CONSTRAINT prospect_simulator_config_shipping_fee_nonnegative
    CHECK (shipping_fee_net >= 0),
  CONSTRAINT prospect_simulator_config_free_shipping_nonnegative
    CHECK (free_shipping_threshold_net >= 0),
  CONSTRAINT prospect_simulator_config_recommended_discount_range
    CHECK (recommended_public_discount_percent >= 0 AND recommended_public_discount_percent <= 100),
  CONSTRAINT prospect_simulator_config_display_stand_nonnegative
    CHECK (display_stand_threshold >= 0),
  CONSTRAINT prospect_simulator_config_privacy_policy_url_nonblank
    CHECK (length(btrim(privacy_policy_url)) > 0),
  CONSTRAINT prospect_simulator_config_tiers_four_items
    CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) = 4)
);

COMMENT ON TABLE public.prospect_simulator_config IS
  'Configurazione per company del simulatore prospect pubblico. Nessuna riga viene creata automaticamente: assenza di configurazione blocca il simulatore (fail closed).';

COMMENT ON COLUMN public.prospect_simulator_config.tiers IS
  'Array JSONB di quattro fasce prospect: code, name, discount_percent, minimum_list_net. Le soglie sono sul totale listino netto.';

COMMENT ON COLUMN public.prospect_simulator_config.display_stand_threshold IS
  'Soglia espositore omaggio, calcolata sul totale listino netto.';

CREATE OR REPLACE FUNCTION public.update_prospect_simulator_config_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prospect_simulator_config_updated_at
  ON public.prospect_simulator_config;

CREATE TRIGGER trg_prospect_simulator_config_updated_at
  BEFORE UPDATE ON public.prospect_simulator_config
  FOR EACH ROW
  EXECUTE FUNCTION public.update_prospect_simulator_config_updated_at();

-- 3. Testata della richiesta ricevuta e snapshot autorevole del calcolo.
-- La richiesta non crea utenti, retailer o ordini. Il consenso marketing,
-- se verrà richiesto in futuro, dovrà essere una scelta separata.
CREATE TABLE IF NOT EXISTS public.prospect_simulations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES public.companies(id),
  legal_name                text NOT NULL,
  contact_name              text NOT NULL,
  email                     varchar(320) NOT NULL,
  phone                     varchar(50) NOT NULL,
  business_type             varchar(100) NOT NULL,
  city                      varchar(100) NOT NULL,
  vat_number                varchar(20) NOT NULL,
  privacy_accepted_at       timestamptz NOT NULL,
  privacy_policy_url        text NOT NULL,
  list_subtotal_net         numeric(10,2) NOT NULL,
  reached_tier_code         varchar(50) NOT NULL,
  calculation_snapshot      jsonb NOT NULL,
  status                    varchar(20) NOT NULL DEFAULT 'new',
  notification_status       varchar(20) NOT NULL DEFAULT 'pending',
  notification_sent_at      timestamptz,
  notification_error        text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_simulations_legal_name_nonblank
    CHECK (length(btrim(legal_name)) > 0),
  CONSTRAINT prospect_simulations_contact_name_nonblank
    CHECK (length(btrim(contact_name)) > 0),
  CONSTRAINT prospect_simulations_email_nonblank
    CHECK (length(btrim(email)) > 0),
  CONSTRAINT prospect_simulations_phone_nonblank
    CHECK (length(btrim(phone)) > 0),
  CONSTRAINT prospect_simulations_business_type_nonblank
    CHECK (length(btrim(business_type)) > 0),
  CONSTRAINT prospect_simulations_city_nonblank
    CHECK (length(btrim(city)) > 0),
  CONSTRAINT prospect_simulations_vat_number_nonblank
    CHECK (length(btrim(vat_number)) > 0),
  CONSTRAINT prospect_simulations_list_subtotal_nonnegative
    CHECK (list_subtotal_net >= 0),
  CONSTRAINT prospect_simulations_reached_tier_nonblank
    CHECK (length(btrim(reached_tier_code)) > 0),
  CONSTRAINT prospect_simulations_snapshot_object
    CHECK (jsonb_typeof(calculation_snapshot) = 'object'),
  CONSTRAINT prospect_simulations_status_check
    CHECK (status IN ('new', 'contacted', 'qualified', 'archived')),
  CONSTRAINT prospect_simulations_notification_status_check
    CHECK (notification_status IN ('pending', 'sent', 'failed')),
  CONSTRAINT prospect_simulations_notification_sent_consistency
    CHECK (
      (notification_status = 'sent' AND notification_sent_at IS NOT NULL)
      OR notification_status <> 'sent'
    )
);

COMMENT ON TABLE public.prospect_simulations IS
  'Richieste prospect pubbliche con dati di contatto, consenso e snapshot immutabile della simulazione.';

COMMENT ON COLUMN public.prospect_simulations.calculation_snapshot IS
  'Risultato server-side completo e immutabile: configurazione, fasce, prezzi netti/lordi, IVA, margini, spedizione ed espositore.';

COMMENT ON COLUMN public.prospect_simulations.privacy_policy_url IS
  'URL dell’informativa privacy mostrata e accettata dal prospect al momento dell’invio.';

CREATE INDEX IF NOT EXISTS idx_prospect_simulations_company_created
  ON public.prospect_simulations (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_simulations_status_created
  ON public.prospect_simulations (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_simulations_email_created
  ON public.prospect_simulations (email, created_at DESC);

CREATE OR REPLACE FUNCTION public.update_prospect_simulations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prospect_simulations_updated_at
  ON public.prospect_simulations;

CREATE TRIGGER trg_prospect_simulations_updated_at
  BEFORE UPDATE ON public.prospect_simulations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_prospect_simulations_updated_at();

-- 4. Righe del carrello conservate con snapshot di prodotto/prezzo.
CREATE TABLE IF NOT EXISTS public.prospect_simulation_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  simulation_id            uuid NOT NULL REFERENCES public.prospect_simulations(id) ON DELETE CASCADE,
  product_id               uuid REFERENCES public.products(id) ON DELETE SET NULL,
  product_sku_snapshot     varchar(100) NOT NULL,
  product_name_snapshot    text NOT NULL,
  quantity                 integer NOT NULL,
  pieces_per_unit_snapshot integer NOT NULL,
  unit_list_net_snapshot   numeric(10,2) NOT NULL,
  vat_rate_snapshot        numeric(5,2) NOT NULL,
  line_list_net            numeric(10,2) NOT NULL,
  sort_order               integer NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_simulation_items_sku_nonblank
    CHECK (length(btrim(product_sku_snapshot)) > 0),
  CONSTRAINT prospect_simulation_items_name_nonblank
    CHECK (length(btrim(product_name_snapshot)) > 0),
  CONSTRAINT prospect_simulation_items_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT prospect_simulation_items_pieces_per_unit_positive
    CHECK (pieces_per_unit_snapshot >= 1),
  CONSTRAINT prospect_simulation_items_unit_list_nonnegative
    CHECK (unit_list_net_snapshot >= 0),
  CONSTRAINT prospect_simulation_items_vat_rate_range
    CHECK (vat_rate_snapshot >= 0 AND vat_rate_snapshot <= 100),
  CONSTRAINT prospect_simulation_items_line_list_nonnegative
    CHECK (line_list_net >= 0),
  CONSTRAINT prospect_simulation_items_sort_order_nonnegative
    CHECK (sort_order >= 0),
  CONSTRAINT prospect_simulation_items_simulation_sort_unique
    UNIQUE (simulation_id, sort_order)
);

COMMENT ON TABLE public.prospect_simulation_items IS
  'Righe immutabili del carrello prospect. product_id è nullable per mantenere lo storico dopo rimozione del prodotto.';

CREATE INDEX IF NOT EXISTS idx_prospect_simulation_items_simulation
  ON public.prospect_simulation_items (simulation_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_prospect_simulation_items_product
  ON public.prospect_simulation_items (product_id)
  WHERE product_id IS NOT NULL;

-- 5. Tabelle server-only: nessuna policy permissiva PostgREST.
-- Il catalogo pubblico sarà esposto esclusivamente da publicProcedure server-side;
-- la richiesta viene ricalcolata e salvata lato server.
ALTER TABLE public.prospect_simulator_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_simulation_items ENABLE ROW LEVEL SECURITY;

COMMIT;
