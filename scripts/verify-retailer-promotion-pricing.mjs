import postgres from "postgres";
import { calculateOrderPricing } from "../server/pricing.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL non disponibile");
}

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

function money(value) {
  return Number.parseFloat(value).toFixed(2);
}

try {
  const retailers = await sql`
    SELECT
      r.id,
      r.name,
      r."companyId" AS "companyId",
      r."pricingModel" AS "pricingModel",
      r."markupPercentage" AS "markupPercentage",
      pp.name AS "packageName",
      pp."discountPercent" AS "tierDiscountPercent"
    FROM retailers r
    LEFT JOIN "pricingPackages" pp ON pp.id = r."pricingPackageId"
    ORDER BY r.name
  `;

  const checks = [];

  for (const retailer of retailers) {
    const promotions = await sql`
      SELECT id, title, discount_percent AS "discountPercent", "productId" AS "productId"
      FROM promotions
      WHERE company_id = ${retailer.companyId}::uuid
        AND is_active = true
        AND valid_from <= NOW()
        AND valid_to >= NOW()
        AND discount_percent IS NOT NULL
        AND discount_percent > 0
      ORDER BY discount_percent DESC, "createdAt" ASC
    `;

    if (promotions.length === 0) {
      checks.push({ retailer: retailer.name, result: "SKIPPED", reason: "Nessuna promo attiva per la company" });
      continue;
    }

    const specific = promotions.find((promotion) => promotion.productId);
    const selectedPromotion = specific ?? promotions[0];
    const productRows = selectedPromotion.productId
      ? await sql`
          SELECT id, name FROM products WHERE id = ${selectedPromotion.productId}::uuid LIMIT 1
        `
      : await sql`
          SELECT id, name FROM products WHERE "unitPrice" IS NOT NULL ORDER BY name LIMIT 1
        `;

    const product = productRows[0];
    if (!product) {
      checks.push({ retailer: retailer.name, result: "FAILED", reason: "Prodotto della promo non trovato" });
      continue;
    }

    const pricing = await calculateOrderPricing(
      retailer.id,
      [{ productId: product.id, quantity: 1 }],
      retailer.companyId,
    );
    const item = pricing.items[0];
    const expectedFinal = Math.round(
      (Number(item.unitPriceTier) * (1 - Number(item.promotionDiscountPercent) / 100) + Number.EPSILON) * 100,
    ) / 100;
    const hasCartMetadata = Boolean(
      item.promotionId &&
      item.publicListPrice &&
      item.unitPriceTier &&
      item.promotionSavingsPerUnit &&
      item.unitPriceBeforePromotion,
    );
    const priceIsCorrect = Math.abs(Number(item.unitPriceFinal) - expectedFinal) < 0.001;

    checks.push({
      retailer: retailer.name,
      companyId: retailer.companyId,
      pricingModel: retailer.pricingModel,
      tier: retailer.packageName ?? "N/D",
      product: product.name,
      promotion: selectedPromotion.title,
      publicListPrice: money(item.publicListPrice),
      tierPrice: money(item.unitPriceTier),
      promotionSavings: money(item.promotionSavingsPerUnit),
      finalPrice: money(item.unitPriceFinal),
      result: hasCartMetadata && priceIsCorrect ? "PASSED" : "FAILED",
      reason: hasCartMetadata && priceIsCorrect
        ? "Metadati carrello completi e prezzo finale corretto"
        : "Metadati promo incompleti oppure formula non coerente",
    });
  }

  console.log(JSON.stringify(checks, null, 2));
  const failed = checks.filter((check) => check.result === "FAILED");
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
