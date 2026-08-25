-- M13 — Alert scadenze rivenditori, allineamento giacenze e audit email.
-- Applicare manualmente nel Supabase SQL Editor prima di pubblicare il codice M13.

BEGIN;

-- 1. Flag anagrafica rivenditore.
ALTER TABLE retailers
  ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "expiryAlertOptOut" boolean NOT NULL DEFAULT false;

-- 2. Configurazione per company: soglia minima invio, espressa in pezzi.
CREATE TABLE IF NOT EXISTS expiry_alert_settings (
  company_id           uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  min_pieces_threshold integer NOT NULL DEFAULT 5 CHECK (min_pieces_threshold >= 1),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO expiry_alert_settings (company_id)
SELECT id FROM companies
ON CONFLICT (company_id) DO NOTHING;

CREATE OR REPLACE FUNCTION update_expiry_alert_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_expiry_alert_settings_updated_at ON expiry_alert_settings;
CREATE TRIGGER trg_expiry_alert_settings_updated_at
  BEFORE UPDATE ON expiry_alert_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_expiry_alert_settings_updated_at();

-- 3. Registro delle esecuzioni.
CREATE TABLE IF NOT EXISTS expiry_alert_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  mode                text NOT NULL DEFAULT 'alert'
                        CHECK (mode IN ('alignment', 'alert', 'internal')),
  run_date            date NOT NULL,
  period_start        date,
  period_end          date,
  trigger             text NOT NULL
                        CHECK (trigger IN ('cron', 'manual', 'dry_run')),
  status              text NOT NULL
                        CHECK (status IN ('running', 'completed', 'failed')),
  retailers_evaluated integer NOT NULL DEFAULT 0,
  retailers_notified  integer NOT NULL DEFAULT 0,
  emails_sent         integer NOT NULL DEFAULT 0,
  emails_failed       integer NOT NULL DEFAULT 0,
  items_flagged       integer NOT NULL DEFAULT 0,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cron_run_period
  ON expiry_alert_runs(company_id, period_start, period_end)
  WHERE trigger = 'cron' AND status <> 'failed';

-- 4. Audit email M13. I servizi email esistenti non usano questa tabella in questa milestone.
CREATE TABLE IF NOT EXISTS email_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL DEFAULT 'resend',
  provider_message_id text,
  idempotency_key     text NOT NULL,
  email_type          text NOT NULL,
  related_entity_type text,
  related_entity_id   text,
  recipient_email     text NOT NULL,
  recipient_name      text,
  from_email          text,
  reply_to_email      text,
  subject             text NOT NULL,
  template_key        text,
  template_version    text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  text_body           text,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sent', 'failed', 'delivered', 'opened', 'clicked', 'bounced', 'complained')),
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  opened_at           timestamptz,
  clicked_at          timestamptz,
  bounced_at          timestamptz,
  complained_at       timestamptz,
  last_event_at       timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_log_idempotency
  ON email_log(idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_log_provider_message
  ON email_log(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_log_related_entity
  ON email_log(related_entity_type, related_entity_id);

CREATE INDEX IF NOT EXISTS idx_email_log_recipient_created
  ON email_log(recipient_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_log_status_created
  ON email_log(status, created_at DESC);

-- 5. Eventi provider append-only. provider_event_id contiene l'header svix-id verificato.
CREATE TABLE IF NOT EXISTS email_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_log_id       uuid NOT NULL REFERENCES email_log(id) ON DELETE CASCADE,
  provider           text NOT NULL DEFAULT 'resend',
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  payload            jsonb,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_email_events_log_time
  ON email_events(email_log_id, occurred_at DESC);

-- 6. Una notifica per rivenditore per run. is_internal identifica esplicitamente il modulo internal.
CREATE TABLE IF NOT EXISTS expiry_alert_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES expiry_alert_runs(id) ON DELETE CASCADE,
  retailer_id       uuid REFERENCES retailers(id) ON DELETE SET NULL,
  is_internal       boolean NOT NULL DEFAULT false,
  retailer_name     text NOT NULL,
  recipient_email   text NOT NULL,
  status            text NOT NULL
                      CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  skip_reason       text,
  email_log_id      uuid REFERENCES email_log(id) ON DELETE SET NULL,
  response_token    text NOT NULL UNIQUE,
  token_expires_at  timestamptz NOT NULL,
  responded_at      timestamptz,
  response_type     text,
  response_note     text,
  items_count       integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_expiry_notification_retailer
  ON expiry_alert_notifications(run_id, retailer_id)
  WHERE retailer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_expiry_notification_internal
  ON expiry_alert_notifications(run_id)
  WHERE is_internal = true;

CREATE INDEX IF NOT EXISTS idx_expiry_alert_notifications_run
  ON expiry_alert_notifications(run_id);

CREATE INDEX IF NOT EXISTS idx_expiry_alert_notifications_email_log
  ON expiry_alert_notifications(email_log_id);

ALTER TABLE expiry_alert_notifications
  ADD CONSTRAINT expiry_alert_notifications_internal_check
  CHECK (NOT is_internal OR retailer_id IS NULL);

-- 7. Snapshot lotto/prodotto della notifica. I riferimenti possono sparire senza invalidare lo storico.
CREATE TABLE IF NOT EXISTS expiry_alert_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id    uuid NOT NULL REFERENCES expiry_alert_notifications(id) ON DELETE CASCADE,
  product_id         uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name       text NOT NULL,
  batch_id           uuid REFERENCES "productBatches"(id) ON DELETE SET NULL,
  batch_code         text NOT NULL,
  expiry_date        date NOT NULL,
  quantity_pieces    integer NOT NULL CHECK (quantity_pieces >= 0),
  pieces_per_unit    integer NOT NULL DEFAULT 1 CHECK (pieces_per_unit >= 1),
  delivery_status    text NOT NULL DEFAULT 'delivered'
                        CHECK (delivery_status IN ('delivered', 'in_transit')),
  last_transfer_date date,
  declared_quantity  integer,
  adjustment_applied boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eai_notification
  ON expiry_alert_items(notification_id);

CREATE INDEX IF NOT EXISTS idx_eai_batch
  ON expiry_alert_items(batch_id);

-- 8. Il frontend dispone di Supabase Auth/anon key; i dati applicativi passano oggi via tRPC,
-- ma PostgREST resta raggiungibile. Le nuove tabelle non espongono policy permissive: pagina token solo server-side.
ALTER TABLE expiry_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_alert_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_alert_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_alert_items ENABLE ROW LEVEL SECURITY;

COMMIT;
