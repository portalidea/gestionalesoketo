-- Read-only verification after manually applying migration 0052 in Supabase.
-- No report bytes, Seller IDs, credentials, buyer data or stock writes.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_active
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'amazon_import_documents'
LIMIT 1;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'amazon_import_documents'
ORDER BY ordinal_position
LIMIT 20;

SELECT conname AS constraint_name, convalidated AS validated, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.amazon_import_documents'::regclass
ORDER BY conname
LIMIT 20;

SELECT t.tgname AS trigger_name, t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
WHERE t.tgrelid = 'public.amazon_import_documents'::regclass AND NOT t.tgisinternal
ORDER BY t.tgname
LIMIT 5;

SELECT count(*) AS documents, count(*) FILTER (WHERE ingest_completed_at IS NULL) AS waiting_ingestion,
       count(*) FILTER (WHERE processing_completed_at IS NOT NULL) AS completed
FROM public.amazon_import_documents
LIMIT 1;
-- Immediately after migration, before the approved next upload, all counts should be 0.
