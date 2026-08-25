-- Verifica isolata M13: una tabella con RLS abilitato e senza policy
-- rifiuta scritture di un ruolo che non possiede BYPASSRLS, anche con GRANT SQL.
-- Eseguire solo tramite l'ambiente testdb locale, mai contro produzione.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'm13_local_non_bypass') THEN
    DROP OWNED BY m13_local_non_bypass;
    DROP ROLE m13_local_non_bypass;
  END IF;
END;
$$;

INSERT INTO companies (id, name, "isActive")
VALUES ('00000000-0000-0000-0000-0000000000f1', 'TEST RLS M13', true)
ON CONFLICT (id) DO NOTHING;

CREATE ROLE m13_local_non_bypass LOGIN NOINHERIT NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO m13_local_non_bypass;
GRANT SELECT, INSERT, UPDATE, DELETE ON expiry_alert_runs TO m13_local_non_bypass;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE m13_local_non_bypass;
    INSERT INTO expiry_alert_runs (company_id, mode, run_date, trigger, status)
    VALUES ('00000000-0000-0000-0000-0000000000f1', 'alignment', DATE '2099-01-01', 'manual', 'running');
    RAISE EXCEPTION 'ERRORE: la scrittura ha bypassato RLS senza policy';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS: ruolo non-BYPASSRLS bloccato da RLS senza policy';
  END;
END;
$$;

-- Il proprietario/superuser mantiene l'accesso, equivalente al caso backend
-- solo se DATABASE_URL usa davvero un ruolo con BYPASSRLS.
INSERT INTO expiry_alert_runs (company_id, mode, run_date, trigger, status)
VALUES ('00000000-0000-0000-0000-0000000000f1', 'alignment', DATE '2099-01-01', 'manual', 'running');

DELETE FROM expiry_alert_runs
WHERE company_id = '00000000-0000-0000-0000-0000000000f1'
  AND run_date = DATE '2099-01-01'
  AND trigger = 'manual';

DROP OWNED BY m13_local_non_bypass;
DROP ROLE m13_local_non_bypass;

\echo 'PASS: verifica RLS locale completata'
