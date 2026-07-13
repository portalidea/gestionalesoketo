-- M12: Aggiunge campo "Codice Articolo" (codice interno) ai prodotti
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "internalCode" varchar(50);
