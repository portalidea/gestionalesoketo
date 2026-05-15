/**
 * M6.2.A — Pricing Calculator
 *
 * Calcola pricing ordine con snapshot frozen al momento della creazione.
 * Riusabile da: admin order creation, retailer portal checkout (futuro M6.2.B).
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  products,
  retailers,
  pricingPackages,
} from "../drizzle/schema";

export interface PricingItemInput {
  productId: string;
  quantity: number; // in unità di vendita (confezioni)
}

export interface PricingItemOutput {
  productId: string;
  productSku: string;
  productName: string;
  piecesPerUnit: number;
  quantity: number;
  unitPriceBase: string; // 2 decimali
  discountPercent: string; // 2 decimali
  unitPriceFinal: string; // 2 decimali
  vatRate: string; // 2 decimali
  lineTotalNet: string; // 2 decimali
  lineTotalGross: string; // 2 decimali
  // Stock info per soft warning
  stockAvailableConfezioni: number;
  stockWarning: boolean;
}

export interface PricingResult {
  discountPercent: string; // 2 decimali
  items: PricingItemOutput[];
  subtotalNet: string; // 2 decimali
  vatAmount: string; // 2 decimali
  totalGross: string; // 2 decimali
  warnings: string[];
}

/**
 * Calcola pricing completo per un ordine.
 * @param retailerId UUID del retailer destinatario
 * @param items Array di { productId, quantity }
 * @returns PricingResult con totali e warnings stock
 */
export async function calculateOrderPricing(
  retailerId: string,
  items: PricingItemInput[],
): Promise<PricingResult> {
  const db = await getDb();
  if (!db) throw new Error("Database non disponibile");

  // 1. Ottieni retailer + pacchetto pricing
  const [retailer] = await db
    .select({
      id: retailers.id,
      name: retailers.name,
      pricingPackageId: retailers.pricingPackageId,
    })
    .from(retailers)
    .where(eq(retailers.id, retailerId))
    .limit(1);

  if (!retailer) throw new Error("Retailer non trovato");

  let discountPercent = 0;
  if (retailer.pricingPackageId) {
    const [pkg] = await db
      .select({ discountPercent: pricingPackages.discountPercent })
      .from(pricingPackages)
      .where(eq(pricingPackages.id, retailer.pricingPackageId))
      .limit(1);
    if (pkg) {
      discountPercent = parseFloat(pkg.discountPercent);
    }
  }

  // 2. Ottieni prodotti
  const productIds = items.map((i) => i.productId);
  const productRows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unitPrice: products.unitPrice,
      vatRate: products.vatRate,
      piecesPerUnit: products.piecesPerUnit,
    })
    .from(products)
    .where(sql`${products.id} IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})`);

  const productMap = new Map(productRows.map((p) => [p.id, p]));

  // 3. Ottieni stock centrale per ogni prodotto (raw SQL per join complessi)
  const stockRows = await db.execute<{ productId: string; totalQty: number }>(sql`
    SELECT pb."productId" AS "productId", COALESCE(SUM(ibb."quantity"), 0)::int AS "totalQty"
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
    WHERE l."type" = 'central_warehouse'
      AND pb."productId" IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY pb."productId"
  `);

  const stockMap = new Map(
    (stockRows as unknown as Array<{ productId: string; totalQty: number }>).map((s) => [
      s.productId,
      s.totalQty,
    ]),
  );

  // 4. Calcola pricing per ogni item
  const warnings: string[] = [];
  const pricedItems: PricingItemOutput[] = [];
  let sumNet = 0;
  let sumVat = 0;
  let sumGross = 0;

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      throw new Error(`Prodotto ${item.productId} non trovato`);
    }

    const unitPriceBase = parseFloat(product.unitPrice || "0");
    const vatRate = parseFloat(product.vatRate);
    const piecesPerUnit = product.piecesPerUnit;

    // Calcolo prezzo con sconto
    const unitPriceFinal = roundTo2(unitPriceBase * (1 - discountPercent / 100));
    const lineTotalNet = roundTo2(unitPriceFinal * item.quantity);
    const lineVat = roundTo2(lineTotalNet * (vatRate / 100));
    const lineTotalGross = roundTo2(lineTotalNet + lineVat);

    sumNet += lineTotalNet;
    sumVat += lineVat;
    sumGross += lineTotalGross;

    // Stock check (soft warning)
    const stockAvailable = stockMap.get(item.productId) ?? 0;
    const stockWarning = item.quantity > stockAvailable;
    if (stockWarning) {
      warnings.push(
        `${product.name}: richieste ${item.quantity} conf, disponibili ${stockAvailable} conf`,
      );
    }

    pricedItems.push({
      productId: item.productId,
      productSku: product.sku,
      productName: product.name,
      piecesPerUnit,
      quantity: item.quantity,
      unitPriceBase: unitPriceBase.toFixed(2),
      discountPercent: discountPercent.toFixed(2),
      unitPriceFinal: unitPriceFinal.toFixed(2),
      vatRate: vatRate.toFixed(2),
      lineTotalNet: lineTotalNet.toFixed(2),
      lineTotalGross: lineTotalGross.toFixed(2),
      stockAvailableConfezioni: stockAvailable,
      stockWarning,
    });
  }

  return {
    discountPercent: discountPercent.toFixed(2),
    items: pricedItems,
    subtotalNet: roundTo2(sumNet).toFixed(2),
    vatAmount: roundTo2(sumVat).toFixed(2),
    totalGross: roundTo2(sumGross).toFixed(2),
    warnings,
  };
}

/** Arrotonda a 2 decimali */
function roundTo2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
