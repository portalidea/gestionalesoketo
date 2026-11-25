-- 0053 — Programma Partner SoKeto: borsellino promo app (FoodApps4All → gestionale).
--
-- FoodApps4All resta la fonte delle convalide in negozio (coupon, acquisti Card,
-- buoni Card). Il gestionale ne tiene una copia (partner_program_events), chiude
-- ogni mese un estratto per rivenditore (partner_program_statements) e lo applica
-- agli ordini E-Keto del mese successivo (partner_program_applications) come due
-- righe di servizio: abbuono (negativo) e contributo 2,5% (positivo).
--
-- Applicazione manuale in Supabase SQL Editor. Nessun backfill, nessun effetto
-- su ordini, prezzi o magazzino esistenti.
BEGIN;

-- 1) Abbinamento negozio app ↔ rivenditore (tbl_store_location.id di FoodApps4All)
ALTER TABLE public.retailers ADD COLUMN IF NOT EXISTS foodapps_store_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS retailers_foodapps_store_id_key
  ON public.retailers (foodapps_store_id) WHERE foodapps_store_id IS NOT NULL;

-- 2) Impostazioni (riga unica)
CREATE TABLE public.partner_program_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  billing_company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  credit_vat_rate numeric(5,2) NOT NULL DEFAULT 10.00
    CHECK (credit_vat_rate IN (4.00, 5.00, 10.00, 22.00)),
  contribution_vat_rate numeric(5,2) NOT NULL DEFAULT 10.00
    CHECK (contribution_vat_rate IN (4.00, 5.00, 10.00, 22.00)),
  import_start_date date NOT NULL DEFAULT DATE '2026-11-20',
  last_sync_at timestamptz,
  last_sync_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.partner_program_settings (id, billing_company_id)
VALUES (1, '00000000-0000-0000-0000-000000000001');  -- E-Keto Food Srls

-- 3) Estratti mensili per rivenditore (creati alla chiusura del mese)
CREATE TABLE public.partner_program_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id uuid NOT NULL REFERENCES public.retailers(id) ON DELETE RESTRICT,
  billing_company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  credit_gross numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit_gross >= 0),
  contribution_gross numeric(12,2) NOT NULL DEFAULT 0 CHECK (contribution_gross >= 0),
  -- Rettifiche per annullamenti arrivati dopo la chiusura di un mese precedente
  -- (negative = riducono il credito). Mostrate a parte nella pagina partner.
  adjustment_gross numeric(12,2) NOT NULL DEFAULT 0 CHECK (adjustment_gross <= 0),
  credit_vat_rate numeric(5,2) NOT NULL CHECK (credit_vat_rate IN (4.00, 5.00, 10.00, 22.00)),
  contribution_vat_rate numeric(5,2) NOT NULL CHECK (contribution_vat_rate IN (4.00, 5.00, 10.00, 22.00)),
  credit_net numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit_net >= 0),
  contribution_net numeric(12,2) NOT NULL DEFAULT 0 CHECK (contribution_net >= 0),
  valid_until date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'expired')),
  closed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  expired_at timestamptz,
  -- Contributo non assorbito da un ordine entro la scadenza: fattura separata
  contribution_fic_document_id text,
  CONSTRAINT partner_program_statements_period_unique UNIQUE (retailer_id, period_month),
  CONSTRAINT partner_program_statements_validity CHECK (valid_until > period_month)
);
CREATE INDEX idx_partner_program_statements_retailer_status
  ON public.partner_program_statements (retailer_id, status, valid_until);

-- 4) Copia delle convalide FoodApps4All (upsert idempotente a ogni sincronizzazione)
CREATE TABLE public.partner_program_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('coupon', 'card_purchase', 'card_voucher')),
  source_id bigint NOT NULL CHECK (source_id > 0),
  foodapps_store_id integer NOT NULL,
  store_name text,
  occurred_at timestamptz NOT NULL,
  label text,
  campaign_key text,
  purchase_gross numeric(12,2) NOT NULL DEFAULT 0 CHECK (purchase_gross >= 0),
  discount_gross numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_gross >= 0),
  credit_gross numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit_gross >= 0),
  contribution_gross numeric(12,2) NOT NULL DEFAULT 0 CHECK (contribution_gross >= 0),
  cancelled_at timestamptz,
  statement_id uuid REFERENCES public.partner_program_statements(id) ON DELETE RESTRICT,
  -- Annullamento arrivato dopo la chiusura: in quale estratto è stato rettificato
  adjusted_in_statement_id uuid REFERENCES public.partner_program_statements(id) ON DELETE RESTRICT,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_program_events_source_unique UNIQUE (source, source_id)
);
CREATE INDEX idx_partner_program_events_store_time
  ON public.partner_program_events (foodapps_store_id, occurred_at);
CREATE INDEX idx_partner_program_events_statement
  ON public.partner_program_events (statement_id);

-- 5) Utilizzi del borsellino sugli ordini (append-only; storno = riga reversal)
CREATE TABLE public.partner_program_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES public.partner_program_statements(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  entry_type text NOT NULL DEFAULT 'apply' CHECK (entry_type IN ('apply', 'reversal')),
  reverses_application_id uuid REFERENCES public.partner_program_applications(id) ON DELETE RESTRICT,
  credit_net_applied numeric(12,2) NOT NULL DEFAULT 0,
  contribution_net_charged numeric(12,2) NOT NULL DEFAULT 0,
  reversal_reason text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_program_applications_sign CHECK (
    (entry_type = 'apply' AND reverses_application_id IS NULL
       AND credit_net_applied >= 0 AND contribution_net_charged >= 0)
    OR
    (entry_type = 'reversal' AND reverses_application_id IS NOT NULL
       AND credit_net_applied <= 0 AND contribution_net_charged <= 0)
  )
);
CREATE INDEX idx_partner_program_applications_statement
  ON public.partner_program_applications (statement_id, created_at);
CREATE INDEX idx_partner_program_applications_order
  ON public.partner_program_applications (order_id);
CREATE UNIQUE INDEX partner_program_applications_one_reversal
  ON public.partner_program_applications (reverses_application_id)
  WHERE reverses_application_id IS NOT NULL;

-- 6) Righe di servizio: collegamento all'estratto e abbuono negativo ammesso
--    solo per la riga "abbuono promo app".
ALTER TABLE public.order_service_lines
  ADD COLUMN IF NOT EXISTS partner_program_statement_id uuid
    REFERENCES public.partner_program_statements(id) ON DELETE RESTRICT;

ALTER TABLE public.order_service_lines
  DROP CONSTRAINT IF EXISTS order_service_lines_unit_net_nonnegative,
  DROP CONSTRAINT IF EXISTS order_service_lines_totals_nonnegative;

ALTER TABLE public.order_service_lines
  ADD CONSTRAINT order_service_lines_unit_net_nonnegative CHECK (
    unit_price_net >= 0
    OR (service_code = 'PARTNER_PROMO_CREDIT' AND partner_program_statement_id IS NOT NULL)
  ),
  ADD CONSTRAINT order_service_lines_totals_nonnegative CHECK (
    (line_total_net >= 0 AND line_total_gross >= 0)
    OR (service_code = 'PARTNER_PROMO_CREDIT' AND partner_program_statement_id IS NOT NULL
        AND line_total_net <= 0 AND line_total_gross <= 0)
  );

-- 7) RLS: tabelle solo backend (il server usa la connessione diretta)
ALTER TABLE public.partner_program_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_program_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_program_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_program_applications ENABLE ROW LEVEL SECURITY;

COMMIT;
