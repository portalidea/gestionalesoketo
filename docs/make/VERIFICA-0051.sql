-- Solo lettura: eseguire dopo la 0051, prima di abilitare Make.
SELECT c.relname AS tabella, c.relrowsecurity AS rls_attiva
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
 ('amazon_import_configs','amazon_import_runs','amazon_stock_allocations','amazon_import_row_observations')
ORDER BY c.relname LIMIT 4;

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='amazon_import_configs'
 AND column_name IN ('purchase_cutoff','dry_run','enabled')
ORDER BY column_name LIMIT 3;

SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN ('marketplace_items_amazon_identity_valid','marketplace_items_amazon_status_valid',
 'marketplace_items_amazon_processed_nonneg','amazon_stock_allocations_item_batch_unique','amazon_import_runs_window_valid')
ORDER BY conname LIMIT 5;

SELECT indexname
FROM pg_indexes
WHERE schemaname='public' AND indexname IN
 ('marketplace_items_amazon_identity_unique','amazon_import_runs_one_open','amazon_import_runs_store_created')
ORDER BY indexname LIMIT 3;

SELECT tgname, tgenabled
FROM pg_trigger WHERE tgname='amazon_stock_allocations_immutable' LIMIT 1;
