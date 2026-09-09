-- 0040 — Deroga tracciata al minimo ordine prospect.
-- Già applicata in produzione; mantenuta nel repository per un replay locale
-- continuo fra la 0039 e la 0041. Tutte le aggiunte sono idempotenti.
BEGIN;

ALTER TABLE public.prospect_simulations
  ADD COLUMN IF NOT EXISTS "minimumOrderOverrideApplied" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "minimumOrderOverrideReason" text,
  ADD COLUMN IF NOT EXISTS "minimumOrderOverriddenBy" uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "minimumOrderOverriddenAt" timestamptz;

COMMIT;
