-- Migration 0011: M5.8 — piecesPerUnit + sellableUnitLabel
-- Adds piecesPerUnit (integer, default 1, CHECK >= 1) and
-- sellableUnitLabel (varchar(50), default 'PZ') to products table.
-- No data backfill needed: default values are retro-compatible.

ALTER TABLE "products"
  ADD COLUMN "piecesPerUnit" integer NOT NULL DEFAULT 1
  CONSTRAINT "products_piecesPerUnit_check" CHECK ("piecesPerUnit" >= 1);

ALTER TABLE "products"
  ADD COLUMN "sellableUnitLabel" varchar(50) NOT NULL DEFAULT 'PZ';
