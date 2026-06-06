BEGIN;

-- 1) Enum pricing model
CREATE TYPE pricing_model_enum AS ENUM ('tier_discount', 'cost_markup');

-- 2) Colonne su retailers
ALTER TABLE retailers
  ADD COLUMN "pricingModel" pricing_model_enum NOT NULL DEFAULT 'tier_discount',
  ADD COLUMN "markupPercentage" decimal(5,2);

-- 3) Constraint: se pricingModel='cost_markup' markupPercentage obbligatoria
ALTER TABLE retailers
  ADD CONSTRAINT "retailer_markup_required_when_cost_model"
  CHECK (
    ("pricingModel" != 'cost_markup') OR
    ("pricingModel" = 'cost_markup' AND "markupPercentage" IS NOT NULL
     AND "markupPercentage" >= 0 AND "markupPercentage" <= 100)
  );

-- 4) Colonna override per-ordine (rimpiazza markup retailer in quel singolo ordine)
ALTER TABLE orders
  ADD COLUMN "markupPercentageOverride" decimal(5,2);

ALTER TABLE orders
  ADD CONSTRAINT "order_markup_override_range"
  CHECK (
    "markupPercentageOverride" IS NULL OR
    ("markupPercentageOverride" >= 0 AND "markupPercentageOverride" <= 100)
  );

-- 5) Verifica
SELECT
  'retailers_total'      AS check_name, COUNT(*)::text AS value FROM retailers
UNION ALL
SELECT 'retailers_cost_markup', COUNT(*)::text FROM retailers WHERE "pricingModel"='cost_markup';

-- Atteso: retailers_total = N, retailers_cost_markup = 0
-- (Il retailer SoKeto Srl verrà creato dopo da UI col modello cost_markup.)

COMMIT;
