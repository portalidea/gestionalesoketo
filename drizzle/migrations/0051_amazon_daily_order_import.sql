-- 0051 — Amazon Make: import giornaliero e prova senza movimenti.
-- Applicazione produzione manuale dall'utente. Nessun dato storico/backfill.
BEGIN;

CREATE TABLE public.amazon_import_configs (
  store_id uuid PRIMARY KEY REFERENCES public.sales_stores(id) ON DELETE RESTRICT,
  seller_account_id text NOT NULL UNIQUE CHECK (length(btrim(seller_account_id)) > 0),
  purchase_cutoff date NOT NULL DEFAULT DATE '2026-09-01',
  dry_run boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT false,
  checkpoint_at timestamptz,
  updated_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.amazon_import_configs.dry_run IS 'Disattivazione esclusivamente manuale admin; nessuna scadenza automatica dopo la settimana di prova.';
COMMENT ON COLUMN public.amazon_import_configs.purchase_cutoff IS 'Cutoff applicato a purchase-date nel calendario Europe/Rome, non a last-updated-date.';

CREATE TABLE public.amazon_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.amazon_import_configs(store_id) ON DELETE RESTRICT,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  report_id text,
  report_document_id text,
  document_sha256 text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','pending','processing','completed','cancelled','fatal','review_required')),
  dry_run boolean NOT NULL DEFAULT true,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_import_runs_window_valid CHECK (window_end > window_start AND window_end <= window_start + interval '30 days'),
  CONSTRAINT amazon_import_runs_report_unique UNIQUE (store_id, report_id)
);
CREATE UNIQUE INDEX amazon_import_runs_one_open ON public.amazon_import_runs(store_id) WHERE status IN ('requested','pending','processing');
CREATE INDEX amazon_import_runs_store_created ON public.amazon_import_runs(store_id, created_at DESC);

ALTER TABLE public.marketplace_order_items
  ADD COLUMN "amazonSellerAccountId" text,
  ADD COLUMN "amazonOrderId" text,
  ADD COLUMN "amazonOrderItemId" text,
  ADD COLUMN "amazonPurchaseDate" timestamptz,
  ADD COLUMN "amazonUpdatedAt" timestamptz,
  ADD COLUMN "amazonItemStatus" text,
  ADD COLUMN "amazonOrderStatus" text,
  ADD COLUMN "amazonFulfillmentChannel" text,
  ADD COLUMN "amazonStockStatus" text,
  ADD COLUMN "amazonStockReason" text,
  ADD COLUMN "amazonPiecesProcessed" integer NOT NULL DEFAULT 0,
  ADD COLUMN "amazonFefoPreview" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "amazonSourceSnapshot" jsonb,
  ADD COLUMN "amazonLastRunId" uuid REFERENCES public.amazon_import_runs(id) ON DELETE RESTRICT;
ALTER TABLE public.marketplace_order_items ADD CONSTRAINT marketplace_items_amazon_identity_valid CHECK (
  ("amazonSellerAccountId" IS NULL AND "amazonOrderId" IS NULL AND "amazonOrderItemId" IS NULL)
  OR ("amazonSellerAccountId" IS NOT NULL AND "amazonOrderId" IS NOT NULL AND "amazonOrderItemId" IS NOT NULL
      AND length(btrim("amazonSellerAccountId")) > 0 AND length(btrim("amazonOrderId")) > 0 AND length(btrim("amazonOrderItemId")) > 0
      AND "amazonPurchaseDate" IS NOT NULL AND "amazonUpdatedAt" IS NOT NULL AND "amazonStockStatus" IS NOT NULL)
);
ALTER TABLE public.marketplace_order_items ADD CONSTRAINT marketplace_items_amazon_processed_nonneg CHECK ("amazonPiecesProcessed" >= 0);
ALTER TABLE public.marketplace_order_items ADD CONSTRAINT marketplace_items_amazon_status_valid CHECK (
  "amazonStockStatus" IS NULL OR "amazonStockStatus" IN ('pending','not_shipped','pre_cutoff','review_required','dry_run','processed','cancelled','post_stock_alert')
);
CREATE UNIQUE INDEX marketplace_items_amazon_identity_unique ON public.marketplace_order_items("amazonSellerAccountId","amazonOrderId","amazonOrderItemId") WHERE "amazonSellerAccountId" IS NOT NULL;
CREATE INDEX marketplace_items_amazon_run_status ON public.marketplace_order_items("amazonLastRunId","amazonStockStatus");

CREATE TABLE public.amazon_stock_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.marketplace_order_items(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES public.amazon_import_runs(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public."productBatches"(id) ON DELETE RESTRICT,
  stock_movement_id uuid NOT NULL UNIQUE REFERENCES public."stockMovements"(id) ON DELETE RESTRICT,
  pieces integer NOT NULL CHECK (pieces > 0),
  amazon_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_stock_allocations_item_batch_unique UNIQUE(item_id,product_id,batch_id)
);
COMMENT ON COLUMN public.amazon_stock_allocations.amazon_updated_at IS 'Data aggiornamento Amazon: data del movimento, NON data di spedizione.';
CREATE INDEX amazon_stock_allocations_run ON public.amazon_stock_allocations(run_id);

-- Osservazioni delle righe per run: preservano anche le righe prive di ID articolo,
-- in quarantena, e rendono riconciliabile la modalità prova senza creare movimenti.
CREATE TABLE public.amazon_import_row_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.amazon_import_runs(id) ON DELETE RESTRICT,
  row_key text NOT NULL,
  item_id uuid REFERENCES public.marketplace_order_items(id) ON DELETE RESTRICT,
  source_row jsonb NOT NULL,
  outcome text NOT NULL,
  reason text,
  planned_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_import_row_observations_unique UNIQUE(run_id,row_key)
);
CREATE INDEX amazon_import_row_observations_run ON public.amazon_import_row_observations(run_id);

CREATE FUNCTION public.amazon_stock_allocations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'amazon_stock_allocations è append-only: vietati UPDATE e DELETE' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER amazon_stock_allocations_immutable BEFORE UPDATE OR DELETE ON public.amazon_stock_allocations FOR EACH ROW EXECUTE FUNCTION public.amazon_stock_allocations_append_only();

ALTER TABLE public.amazon_import_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_stock_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_import_row_observations ENABLE ROW LEVEL SECURITY;
-- Nessuna policy client: accesso solo backend runtime, come i ledger esistenti.
COMMIT;
