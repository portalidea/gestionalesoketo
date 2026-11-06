-- 0052 — Durable Amazon report acquisition and restartable bounded processing.
-- Production application is manual. No backfill, external API or stock changes.
BEGIN;

CREATE TABLE public.amazon_import_documents (
  run_id uuid PRIMARY KEY REFERENCES public.amazon_import_runs(id) ON DELETE RESTRICT,
  body_base64 text NOT NULL,
  compression text NOT NULL CHECK (compression IN ('NONE', 'GZIP')),
  total_rows integer NOT NULL CHECK (total_rows BETWEEN 0 AND 2000),
  ingested_rows integer NOT NULL DEFAULT 0,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  ingest_started_at timestamptz,
  ingest_completed_at timestamptz,
  processing_completed_at timestamptz,
  processing_ms bigint NOT NULL DEFAULT 0 CHECK (processing_ms >= 0),
  last_error text CHECK (last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT amazon_import_documents_cursor_valid CHECK (ingested_rows BETWEEN 0 AND total_rows),
  -- Original wire bytes <= 8 MiB, encoded without line breaks. Decode is checked
  -- at acquisition; database storage is bounded independently of the application.
  CONSTRAINT amazon_import_documents_body_bounded CHECK (
    octet_length(body_base64) BETWEEN 4 AND 11184812
    AND body_base64 ~ '^[A-Za-z0-9+/]*={0,2}$'
    AND octet_length(decode(body_base64, 'base64')) <= 8388608
  ),
  CONSTRAINT amazon_import_documents_ingest_complete_valid CHECK (
    ingest_completed_at IS NULL OR ingested_rows = total_rows
  ),
  CONSTRAINT amazon_import_documents_processing_complete_valid CHECK (
    processing_completed_at IS NULL OR ingest_completed_at IS NOT NULL
  )
);
COMMENT ON TABLE public.amazon_import_documents IS 'Backend-only original report bytes. Immutable payload; cursor and observations commit atomically. Identity/digest belong to the unique run report contract.';
COMMENT ON COLUMN public.amazon_import_documents.processing_ms IS 'Accumulated committed worker elapsed milliseconds, not HTTP acquisition time.';

-- Payload and report row count must not change when resuming processing.
CREATE FUNCTION public.amazon_import_documents_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.body_base64 IS DISTINCT FROM OLD.body_base64
     OR NEW.compression IS DISTINCT FROM OLD.compression
     OR NEW.total_rows IS DISTINCT FROM OLD.total_rows
     OR NEW.acquired_at IS DISTINCT FROM OLD.acquired_at THEN
    RAISE EXCEPTION 'amazon_import_documents content is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.ingested_rows < OLD.ingested_rows THEN
    RAISE EXCEPTION 'amazon_import_documents cursor cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER amazon_import_documents_content_immutable
  BEFORE UPDATE ON public.amazon_import_documents
  FOR EACH ROW EXECUTE FUNCTION public.amazon_import_documents_content_immutable();

ALTER TABLE public.amazon_import_documents ENABLE ROW LEVEL SECURITY;
-- No client policies: backend runtime only, same as the existing Amazon ledger.
COMMIT;
