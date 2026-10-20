-- 0047 — Storico append-only delle transizioni di evasione ordine
--
-- Applicare manualmente su Supabase PRIMA del deploy del codice che usa
-- `order_status_events`. Nessun backfill: gli stati già raggiunti restano
-- visibili tramite i timestamp su orders; da questa migration ogni nuova
-- transizione registra anche utente e origine.

BEGIN;

CREATE TABLE IF NOT EXISTS public.order_status_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderId"       uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  "companyId"     uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  "fromStatus"    varchar(20) NOT NULL,
  "toStatus"      varchar(20) NOT NULL,
  source          varchar(32) NOT NULL,
  "actorUserId"   uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_status_events_status_values_check
    CHECK (
      "fromStatus" IN ('pending', 'transferring', 'shipped', 'delivered', 'cancelled')
      AND "toStatus" IN ('pending', 'transferring', 'shipped', 'delivered', 'cancelled')
      AND "fromStatus" <> "toStatus"
    ),
  CONSTRAINT order_status_events_source_check
    CHECK (source IN ('manual_step', 'delivery_confirm'))
);

COMMENT ON TABLE public.order_status_events IS
  'Storico append-only delle transizioni di evasione ordine. Le transizioni manuali usano source=manual_step; il percorso composto usa source=delivery_confirm.';

CREATE INDEX IF NOT EXISTS order_status_events_order_created_idx
  ON public.order_status_events ("orderId", "createdAt" ASC);

CREATE INDEX IF NOT EXISTS order_status_events_company_created_idx
  ON public.order_status_events ("companyId", "createdAt" DESC);

-- Server-only: nessuna policy PostgREST permissiva. Il runtime applicativo,
-- come per orders e retailer_allowances, usa il ruolo backend che bypassa RLS.
ALTER TABLE public.order_status_events ENABLE ROW LEVEL SECURITY;

COMMIT;
