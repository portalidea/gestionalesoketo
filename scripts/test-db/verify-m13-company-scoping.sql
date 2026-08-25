-- Verifica locale M13: i run cron sono indipendenti per company e le
-- notifiche interne usano is_internal, non retailer_id NULL come semantica.
-- Eseguire esclusivamente sull'ambiente PostgreSQL isolato.

\set ON_ERROR_STOP on

INSERT INTO companies (id, name, "isActive")
VALUES
  ('00000000-0000-0000-0000-0000000000f2', 'TEST M13 Scope A', true),
  ('00000000-0000-0000-0000-0000000000f3', 'TEST M13 Scope B', true)
ON CONFLICT (id) DO NOTHING;

-- Stessa finestra cron: una riga per ciascuna company è ammessa.
INSERT INTO expiry_alert_runs (company_id, mode, run_date, period_start, period_end, trigger, status)
VALUES
  ('00000000-0000-0000-0000-0000000000f2', 'alert', DATE '2099-02-01', DATE '2099-02-01', DATE '2099-02-28', 'cron', 'running'),
  ('00000000-0000-0000-0000-0000000000f3', 'alert', DATE '2099-02-01', DATE '2099-02-01', DATE '2099-02-28', 'cron', 'running');

DO $$
BEGIN
  BEGIN
    INSERT INTO expiry_alert_runs (company_id, mode, run_date, period_start, period_end, trigger, status)
    VALUES ('00000000-0000-0000-0000-0000000000f2', 'alert', DATE '2099-02-01', DATE '2099-02-01', DATE '2099-02-28', 'cron', 'running');
    RAISE EXCEPTION 'ERRORE: il vincolo cron non ha bloccato il duplicato della stessa company';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'PASS: il duplicato cron della stessa company è bloccato';
  END;
END;
$$;

WITH internal_run AS (
  INSERT INTO expiry_alert_runs (company_id, mode, run_date, trigger, status)
  VALUES ('00000000-0000-0000-0000-0000000000f2', 'internal', DATE '2099-02-02', 'manual', 'running')
  RETURNING id
)
INSERT INTO expiry_alert_notifications (
  run_id, retailer_id, is_internal, retailer_name, recipient_email,
  status, response_token, token_expires_at
)
SELECT id, NULL, true, 'Sistema', 'internal@test.invalid', 'pending', 'm13-internal-first', now() + interval '1 day'
FROM internal_run;

DO $$
DECLARE
  internal_run_id uuid;
BEGIN
  SELECT id INTO internal_run_id
  FROM expiry_alert_runs
  WHERE company_id = '00000000-0000-0000-0000-0000000000f2'
    AND run_date = DATE '2099-02-02'
    AND trigger = 'manual';

  BEGIN
    INSERT INTO expiry_alert_notifications (
      run_id, retailer_id, is_internal, retailer_name, recipient_email,
      status, response_token, token_expires_at
    )
    VALUES (internal_run_id, NULL, true, 'Sistema', 'internal@test.invalid', 'pending', 'm13-internal-second', now() + interval '1 day');
    RAISE EXCEPTION 'ERRORE: il vincolo della notifica interna non ha bloccato il duplicato';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'PASS: una sola notifica interna per run è ammessa';
  END;
END;
$$;

DELETE FROM expiry_alert_runs
WHERE company_id IN ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3');

DELETE FROM companies
WHERE id IN ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3');

\echo 'PASS: verifica scope company e notifiche interne M13 completata'
