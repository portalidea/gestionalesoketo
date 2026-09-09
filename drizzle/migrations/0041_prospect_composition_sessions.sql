-- Storico delle sessioni di composizione nel modulo ordine prospect.
-- Append-only. Applicare manualmente nel Supabase SQL Editor SOLO dopo
-- revisione. La 0040 della deroga tracciata al minimo ordine è stata applicata.
-- Non modifica inviti, richieste o ordini esistenti.
--
-- La persistenza resta server-only: invitation_id e company_id sono sempre
-- risolti dal token nel backend, mai accettati dal browser. Il JSONB conserva
-- esclusivamente [{"productId":"uuid","quantity":integer}], senza prezzi o
-- altri dati di anagrafica prodotto.

BEGIN;

-- PostgreSQL richiede una chiave univoca che corrisponda esattamente alle
-- colonne referenziate dalla FK composita. Il vincolo assicura inoltre che una
-- sessione non possa associare la company di un invito a un'altra company.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'prospect_invitations_id_company_unique'
      AND conrelid = 'public.prospect_invitations'::regclass
  ) THEN
    ALTER TABLE public.prospect_invitations
      ADD CONSTRAINT prospect_invitations_id_company_unique
      UNIQUE (id, company_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.prospect_composition_sessions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id                 uuid NOT NULL,
  company_id                    uuid NOT NULL,
  started_at                    timestamptz NOT NULL DEFAULT now(),
  last_activity_at              timestamptz NOT NULL DEFAULT now(),
  cart_snapshot                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  list_total                    numeric(10,2) NOT NULL DEFAULT 0,
  discounted_net                numeric(10,2) NOT NULL DEFAULT 0,
  reached_tier                  varchar(50),
  next_tier_distance_eur        numeric(10,2),
  submitted                     boolean NOT NULL DEFAULT false,

  CONSTRAINT prospect_composition_sessions_invitation_company_fkey
    FOREIGN KEY (invitation_id, company_id)
    REFERENCES public.prospect_invitations (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT prospect_composition_sessions_activity_after_started
    CHECK (last_activity_at >= started_at),
  CONSTRAINT prospect_composition_sessions_cart_array
    CHECK (jsonb_typeof(cart_snapshot) = 'array'),
  CONSTRAINT prospect_composition_sessions_list_total_nonnegative
    CHECK (list_total >= 0),
  CONSTRAINT prospect_composition_sessions_discounted_net_nonnegative
    CHECK (discounted_net >= 0),
  CONSTRAINT prospect_composition_sessions_reached_tier_nonblank
    CHECK (reached_tier IS NULL OR length(btrim(reached_tier)) > 0),
  CONSTRAINT prospect_composition_sessions_next_tier_distance_nonnegative
    CHECK (next_tier_distance_eur IS NULL OR next_tier_distance_eur >= 0)
);

COMMENT ON TABLE public.prospect_composition_sessions IS
  'Storico server-side delle composizioni carrello degli inviti prospect. Le sessioni restano consultabili in admin anche dopo scadenza o revoca del token.';

COMMENT ON COLUMN public.prospect_composition_sessions.cart_snapshot IS
  'Array JSONB minimo di productId e quantity; nessun prezzo, nome prodotto o dato di contatto viene duplicato nella sessione.';

COMMENT ON COLUMN public.prospect_composition_sessions.list_total IS
  'Totale listino del carrello al momento dell''ultima attività, calcolato autorevolmente dal server.';

COMMENT ON COLUMN public.prospect_composition_sessions.discounted_net IS
  'Netto merce pagato secondo la fascia raggiunta al momento dell''ultima attività, calcolato autorevolmente dal server.';

COMMENT ON COLUMN public.prospect_composition_sessions.next_tier_distance_eur IS
  'Importo di netto scontato ancora necessario per la fascia successiva; NULL quando non esiste una fascia superiore o il carrello è vuoto.';

COMMENT ON COLUMN public.prospect_composition_sessions.submitted IS
  'True solo per la sessione che ha prodotto l''ordine prospect inviato; la marcatura avviene nella stessa transazione del submit.';

-- Timeline del dettaglio invito e recupero della sessione più recente.
CREATE INDEX IF NOT EXISTS idx_prospect_composition_sessions_invitation_activity
  ON public.prospect_composition_sessions (invitation_id, last_activity_at DESC);

-- Query amministrative eventualmente filtrate per company, sempre coerenti con
-- il contesto attivo. Non concede alcun accesso diretto dal browser.
CREATE INDEX IF NOT EXISTS idx_prospect_composition_sessions_company_activity
  ON public.prospect_composition_sessions (company_id, last_activity_at DESC);

-- Supporta il segnale "ha composto senza inviare" nella lista inviti senza
-- indicizzare le sessioni già attribuite a un ordine inviato.
CREATE INDEX IF NOT EXISTS idx_prospect_composition_sessions_unsubmitted
  ON public.prospect_composition_sessions (invitation_id, last_activity_at DESC)
  WHERE submitted = false;

-- Nessuna policy permissiva: letture e scritture passano esclusivamente da
-- publicProcedure/adminProcedure server-side, con token o company attiva.
ALTER TABLE public.prospect_composition_sessions ENABLE ROW LEVEL SECURITY;

COMMIT;
