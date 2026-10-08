-- ============================================================
-- 0046 — Persistenza best-effort delle chiamate API legacy
--
-- Applicare manualmente su Supabase prima del deploy.
-- I riferimenti utente/rivenditore sono SET NULL: l'audit resta
-- consultabile anche dopo eventuali cancellazioni anagrafiche.
-- ============================================================

CREATE TABLE IF NOT EXISTS legacy_api_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure varchar(100) NOT NULL,
  "userId" uuid REFERENCES users(id) ON DELETE SET NULL,
  "retailerId" uuid REFERENCES retailers(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_api_calls_procedure_nonblank
    CHECK (length(btrim(procedure)) > 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS legacy_api_calls_procedure_created_at_idx
  ON legacy_api_calls (procedure, "createdAt" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS legacy_api_calls_created_at_idx
  ON legacy_api_calls ("createdAt" DESC);
