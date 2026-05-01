-- ============================================================
-- Phase B — Milestone 2: TRANSFER + EXPIRY_WRITE_OFF + drop legacy
-- ============================================================
-- Migration scritta a mano (drizzle-kit non gestisce ALTER TYPE
-- ADD VALUE né COMMENT ON COLUMN). Idempotency: IF NOT EXISTS.
--
-- Effetti:
--   1. Estende enum `stock_movement_type` con TRANSFER e
--      EXPIRY_WRITE_OFF (Phase B M2).
--   2. Aggiunge `stockMovements.notesInternal` (audit log
--      backend-generated, distinto da `notes` user-facing).
--   3. DROP TABLE `inventory` legacy.
--
-- Pre-condizioni verificate:
-- - frontend non chiama più `trpc.inventory.*` (rimosso in M1)
-- - server/db.ts non importa più `inventory`
-- - server/fattureincloud-sync.ts: syncInventory/syncMovements
--   stub no-op; tRPC `sync.syncRetailer` ora throws TRPCError
--   PRECONDITION_FAILED (refactor FiC = M3)
-- - 2 righe storiche pre-M1 in `inventory` già migrate a
--   `inventoryByBatch` come lotti placeholder LEGACY-{uuid}

-- ============================================================
-- 1. EXTEND stock_movement_type
-- ============================================================
-- Postgres 12+: ADD VALUE in transaction OK; valore non utilizzabile
-- nello stesso file. Questa migration NON crea movimenti, è solo
-- DDL → nessun problema.
ALTER TYPE "public"."stock_movement_type" ADD VALUE IF NOT EXISTS 'TRANSFER';
--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE IF NOT EXISTS 'EXPIRY_WRITE_OFF';
--> statement-breakpoint

-- ============================================================
-- 2. ADD audit column on stockMovements
-- ============================================================
ALTER TABLE "stockMovements" ADD COLUMN IF NOT EXISTS "notesInternal" text;
--> statement-breakpoint

COMMENT ON COLUMN "stockMovements"."notesInternal" IS
  'Audit log automatico generato dal backend (es. "Generato da TRANSFER warehouse→retailer X"). Non visualizzato in UI user-facing — distinto da `notes` che è inserito dall''utente.';
--> statement-breakpoint

-- ============================================================
-- 3. DROP tabella inventory legacy
-- ============================================================
-- Nessun CASCADE: la tabella non ha FK uscenti né incoming
-- (legacy schema senza vincoli reali). Nessun policy RLS da
-- pulire esplicitamente: cade insieme alla tabella.
DROP TABLE IF EXISTS "inventory";
--> statement-breakpoint
