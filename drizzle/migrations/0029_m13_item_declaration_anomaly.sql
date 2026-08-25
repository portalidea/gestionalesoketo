-- M13 follow-up: anomalie dichiarazione per singolo item.
-- Applicazione manuale su Supabase dopo revisione.
BEGIN;

ALTER TABLE expiry_alert_items
  ADD COLUMN IF NOT EXISTS declaration_anomaly boolean NOT NULL DEFAULT false;

CREATE INDEX idx_eai_declaration_anomaly
  ON expiry_alert_items(notification_id)
  WHERE declaration_anomaly = true;

COMMIT;
