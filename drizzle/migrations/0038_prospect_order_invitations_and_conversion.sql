-- Inviti prospect al modulo ordine e conversione idempotente in retailer/ordine.
-- Append-only. Applicare manualmente nel Supabase SQL Editor DOPO 0037 e revisione.
-- Nessun dato esistente viene convertito o modificato da questa migration.
--
-- Le tabelle inviti restano server-only: il token è risolto dal backend e la
-- rotta pubblica non accede a PostgREST. Il confronto timing-safe è nel servizio.

BEGIN;

-- 1. P.IVA del retailer: nullable per non imporre backfill agli esistenti.
--    Il servizio deve normalizzare il valore a sole cifre, rimuovendo prefisso
--    IT, spazi e punteggiatura, sia prima del lookup sia prima del salvataggio.
ALTER TABLE public.retailers
  ADD COLUMN IF NOT EXISTS "vatNumber" varchar(20);

COMMENT ON COLUMN public.retailers."vatNumber" IS
  'P.IVA normalizzata dal servizio in sole cifre; chiave anti-duplicazione per company durante conversione prospect.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'retailers_vat_number_digits_only'
      AND conrelid = 'public.retailers'::regclass
  ) THEN
    ALTER TABLE public.retailers
      ADD CONSTRAINT retailers_vat_number_digits_only
      CHECK ("vatNumber" IS NULL OR "vatNumber" ~ '^[0-9]+$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_retailers_company_vat_number
  ON public.retailers ("companyId", "vatNumber")
  WHERE "vatNumber" IS NOT NULL;

-- 2. Invito individuale con NanoID di 32 caratteri e validità di 15 giorni.
CREATE TABLE IF NOT EXISTS public.prospect_invitations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  legal_name            text NOT NULL,
  contact_name          text NOT NULL,
  email                 varchar(320) NOT NULL,
  phone                 varchar(50) NOT NULL,
  token                 varchar(32) NOT NULL,
  status                varchar(20) NOT NULL DEFAULT 'pending',
  token_expires_at      timestamptz NOT NULL DEFAULT (now() + interval '15 days'),
  created_by            uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_opened_at        timestamptz,
  notification_status   varchar(20) NOT NULL DEFAULT 'pending',
  notification_sent_at  timestamptz,
  notification_error    text,
  revoked_at            timestamptz,
  revoked_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT prospect_invitations_legal_name_nonblank
    CHECK (length(btrim(legal_name)) > 0),
  CONSTRAINT prospect_invitations_contact_name_nonblank
    CHECK (length(btrim(contact_name)) > 0),
  CONSTRAINT prospect_invitations_email_nonblank
    CHECK (length(btrim(email)) > 0),
  CONSTRAINT prospect_invitations_phone_nonblank
    CHECK (length(btrim(phone)) > 0),
  CONSTRAINT prospect_invitations_token_nanoid_32
    CHECK (length(token) = 32),
  CONSTRAINT prospect_invitations_token_expires_after_created
    CHECK (token_expires_at > created_at),
  CONSTRAINT prospect_invitations_status_check
    CHECK (status IN ('pending', 'opened', 'submitted', 'expired', 'revoked')),
  CONSTRAINT prospect_invitations_notification_status_check
    CHECK (notification_status IN ('pending', 'sent', 'failed')),
  CONSTRAINT prospect_invitations_notification_sent_consistency
    CHECK (
      (notification_status = 'sent' AND notification_sent_at IS NOT NULL)
      OR notification_status <> 'sent'
    ),
  CONSTRAINT prospect_invitations_revoked_consistency
    CHECK (
      (status = 'revoked' AND revoked_at IS NOT NULL)
      OR status <> 'revoked'
    ),
  CONSTRAINT prospect_invitations_token_unique UNIQUE (token)
);

COMMENT ON TABLE public.prospect_invitations IS
  'Inviti individuali al modulo ordine prospect. Un token vale per una richiesta e resta valido 15 giorni dalla creazione, indipendentemente dalle aperture.';

COMMENT ON COLUMN public.prospect_invitations.last_opened_at IS
  'Ultima apertura valida del link; aggiornata a ogni accesso e non modifica token_expires_at.';

CREATE INDEX IF NOT EXISTS idx_prospect_invitations_company_status_created
  ON public.prospect_invitations (company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_invitations_company_email_created
  ON public.prospect_invitations (company_id, email, created_at DESC);

-- 3. Dati consegna, invito e conversione della richiesta.
--    I campi restano nullable per non richiedere backfill delle simulazioni 0037;
--    il servizio richiederà tutti i dati per i nuovi submit effettuati da invito.
ALTER TABLE public.prospect_simulations
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS "postalCode" varchar(10),
  ADD COLUMN IF NOT EXISTS province varchar(2),
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS invitation_id uuid REFERENCES public.prospect_invitations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "convertedRetailerId" uuid REFERENCES public.retailers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "convertedOrderId" uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "convertedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "convertedBy" uuid REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.prospect_simulations.address IS
  'Indirizzo completo di consegna: via e numero civico.';

COMMENT ON COLUMN public.prospect_simulations."postalCode" IS
  'CAP dell’indirizzo di consegna.';

COMMENT ON COLUMN public.prospect_simulations.province IS
  'Provincia dell’indirizzo di consegna.';

COMMENT ON COLUMN public.prospect_simulations.notes IS
  'Note libere del prospect da riportare sull’ordine pending creato dopo approvazione.';

COMMENT ON COLUMN public.prospect_simulations.invitation_id IS
  'Invito che ha autorizzato il submit. Un invito può produrre una sola richiesta.';

COMMENT ON COLUMN public.prospect_simulations."convertedOrderId" IS
  'Ordine pending creato dalla conversione amministrativa idempotente.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prospect_simulations_invited_delivery_required'
      AND conrelid = 'public.prospect_simulations'::regclass
  ) THEN
    ALTER TABLE public.prospect_simulations
      ADD CONSTRAINT prospect_simulations_invited_delivery_required
      CHECK (
        invitation_id IS NULL
        OR (
          address IS NOT NULL AND length(btrim(address)) > 0
          AND "postalCode" IS NOT NULL AND length(btrim("postalCode")) > 0
          AND city IS NOT NULL AND length(btrim(city)) > 0
          AND province IS NOT NULL AND length(btrim(province)) > 0
        )
      );
  END IF;
END $$;

-- Extend the 0037 state machine without editing the already reviewed migration.
ALTER TABLE public.prospect_simulations
  DROP CONSTRAINT IF EXISTS prospect_simulations_status_check;

ALTER TABLE public.prospect_simulations
  ADD CONSTRAINT prospect_simulations_status_check
  CHECK (status IN ('new', 'contacted', 'qualified', 'archived', 'converted'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_simulations_invitation
  ON public.prospect_simulations (invitation_id)
  WHERE invitation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_simulations_converted_order
  ON public.prospect_simulations ("convertedOrderId")
  WHERE "convertedOrderId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prospect_simulations_converted_retailer
  ON public.prospect_simulations ("convertedRetailerId")
  WHERE "convertedRetailerId" IS NOT NULL;

-- 4. Server-only persistence. La procedura pubblica passa esclusivamente dal backend.
ALTER TABLE public.prospect_invitations ENABLE ROW LEVEL SECURITY;

COMMIT;
