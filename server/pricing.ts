/**
 * M6.2.A — Pricing Calculator
 * M11.A.markup — Aggiunto supporto pricing model "cost_markup"
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
  // M11.A.markup: info calcolo markup (solo per cost_markup)
  costPrice?: string; // costo anagrafico (2 decimali)
  markupPercent?: string; // markup applicato (2 decimali)
  pricingModel?: "tier_discount" | "cost_markup";
}

export interface PricingResult {
  discountPercent: string; // 2 decimali
  packageName: string | null; // nome pacchetto pricing (null se prezzo pieno)
  items: PricingItemOutput[];
  subtotalNet: string; // 2 decimali
  vatAmount: string; // 2 decimali
  totalGross: string; // 2 decimali
  warnings: string[];
  // M11.A.markup: metadata
  pricingModel: "tier_discount" | "cost_markup";
  markupPercent?: string; // markup effettivo applicato (2 decimali)
}

export interface CalculateOrderPricingOptions {
  retailerId: string;
  items: PricingItemInput[];
  companyId?: string;
  markupPercentageOverride?: number | null; // override per singolo ordine
}

/**
 * Calcola pricing completo per un ordine.
 * Supporta sia tier_discount che cost_markup.
 */
export async function calculateOrderPricing(
  retailerIdOrOpts: string | CalculateOrderPricingOptions,
  itemsArg?: PricingItemInput[],
  companyIdArg?: string,
): Promise<PricingResult> {
  // Supporto backward-compat: vecchia signature (retailerId, items, companyId)
  let retailerId: string;
  let items: PricingItemInput[];
  let companyId: string | undefined;
  let markupPercentageOverride: number | null | undefined;

  if (typeof retailerIdOrOpts === "string") {
    retailerId = retailerIdOrOpts;
    items = itemsArg!;
    companyId = companyIdArg;
  } else {
    retailerId = retailerIdOrOpts.retailerId;
    items = retailerIdOrOpts.items;
    companyId = retailerIdOrOpts.companyId;
    markupPercentageOverride = retailerIdOrOpts.markupPercentageOverride;
  }

  const db = await getDb();
  if (!db) throw new Error("Database non disponibile");

  // 1. Ottieni retailer + pacchetto pricing + pricing model
  const [retailer] = await db
    .select({
      id: retailers.id,
      name: retailers.name,
      pricingPackageId: retailers.pricingPackageId,
      pricingModel: retailers.pricingModel,
      markupPercentage: retailers.markupPercentage,
    })
    .from(retailers)
    .where(eq(retailers.id, retailerId))
    .limit(1);

  if (!retailer) throw new Error("Retailer non trovato");

  const pricingModel = retailer.pricingModel ?? "tier_discount";

  // Determina discount (tier_discount) o markup (cost_markup)
  let discountPercent = 0;
  let packageName: string | null = null;
  let effectiveMarkup = 0;

  if (pricingModel === "cost_markup") {
    // Markup: override ordine > markup retailer
    effectiveMarkup = markupPercentageOverride != null
      ? markupPercentageOverride
      : parseFloat(retailer.markupPercentage || "0");
  } else {
    // Tier discount: logica invariata
    if (retailer.pricingPackageId) {
      const [pkg] = await db
        .select({
          discountPercent: pricingPackages.discountPercent,
          name: pricingPackages.name,
        })
        .from(pricingPackages)
        .where(eq(pricingPackages.id, retailer.pricingPackageId))
        .limit(1);
      if (pkg) {
        discountPercent = parseFloat(pkg.discountPercent);
        packageName = pkg.name;
      }
    }
  }

  // 2. Ottieni prodotti (incluso costPrice per cost_markup)
  const productIds = items.map((i) => i.productId);
  const productRows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unitPrice: products.unitPrice,
      vatRate: products.vatRate,
      piecesPerUnit: products.piecesPerUnit,
      costPrice: products.costPrice,
    })
    .from(products)
    .where(sql`${products.id} IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})`);

  const productMap = new Map(productRows.map((p) => [p.id, p]));

  // 3. Ottieni stock centrale per ogni prodotto
  const stockRows = await db.execute<{ productId: string; totalQty: number }>(sql`
    SELECT pb."productId" AS "productId", COALESCE(SUM(ibb."quantity"), 0)::int AS "totalQty"
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
    WHERE l."type" = 'central_warehouse'
      AND pb."productId" IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ${companyId ? sql`AND l."companyId" = ${companyId}` : sql``}
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

    const vatRate = parseFloat(product.vatRate);
    const piecesPerUnit = product.piecesPerUnit;
    let unitPriceBase: number;
    let unitPriceFinal: number;
    let costPriceStr: string | undefined;
    let markupPercentStr: string | undefined;

    if (pricingModel === "cost_markup") {
      // M11.A.markup: prezzo = costPrice × (1 + markup/100)
      const costBase = parseFloat(product.costPrice || "0");
      if (!costBase || costBase === 0) {
        throw new Error(
          `Costo non valorizzato per il prodotto "${product.name}". Imposta costPrice in anagrafica prima di creare ordini con pricing markup-su-costo.`,
        );
      }
      unitPriceBase = costBase;
      unitPriceFinal = roundTo2(costBase * (1 + effectiveMarkup / 100));
      costPriceStr = costBase.toFixed(2);
      markupPercentStr = effectiveMarkup.toFixed(2);
    } else {
      // Tier discount: logica invariata
      unitPriceBase = parseFloat(product.unitPrice || "0");
      unitPriceFinal = roundTo2(unitPriceBase * (1 - discountPercent / 100));
    }

    const lineTotalNet = roundTo2(unitPriceFinal * item.quantity);
    const lineVat = roundTo2(lineTotalNet * (vatRate / 100));
    const lineTotalGross = roundTo2(lineTotalNet + lineVat);

    sumNet += lineTotalNet;
    sumVat += lineVat;
    sumGross += lineTotalGross;

    // Stock check (soft warning) — stockMap è in pezzi, convertiamo in confezioni
    const stockPieces = stockMap.get(item.productId) ?? 0;
    const ppu = piecesPerUnit ?? 1;
    const stockAvailableConf = Math.floor(stockPieces / ppu);
    const stockWarning = item.quantity > stockAvailableConf;
    if (stockWarning) {
      warnings.push(
        `${product.name}: richieste ${item.quantity} conf, disponibili ${stockAvailableConf} conf`,
      );
    }
    pricedItems.push({
      productId: item.productId,
      productSku: product.sku,
      productName: product.name,
      piecesPerUnit,
      quantity: item.quantity,
      unitPriceBase: unitPriceBase.toFixed(2),
      discountPercent: pricingModel === "cost_markup" ? "0.00" : discountPercent.toFixed(2),
      unitPriceFinal: unitPriceFinal.toFixed(2),
      vatRate: vatRate.toFixed(2),
      lineTotalNet: lineTotalNet.toFixed(2),
      lineTotalGross: lineTotalGross.toFixed(2),
      stockAvailableConfezioni: stockAvailableConf,
      stockWarning,
      // M11.A.markup: extra info
      ...(pricingModel === "cost_markup" && {
        costPrice: costPriceStr,
        markupPercent: markupPercentStr,
        pricingModel: "cost_markup" as const,
      }),
      ...(pricingModel === "tier_discount" && {
        pricingModel: "tier_discount" as const,
      }),
    });
  }

  return {
    discountPercent: discountPercent.toFixed(2),
    packageName,
    items: pricedItems,
    subtotalNet: roundTo2(sumNet).toFixed(2),
    vatAmount: roundTo2(sumVat).toFixed(2),
    totalGross: roundTo2(sumGross).toFixed(2),
    warnings,
    pricingModel,
    ...(pricingModel === "cost_markup" && {
      markupPercent: effectiveMarkup.toFixed(2),
    }),
  };
}

/**
 * Calcola pricing per ordini evento (senza retailer, sconto 0%).
 * Usa prezzo pieno del prodotto.
 */
export async function calculateEventOrderPricing(
  items: PricingItemInput[],
  companyId?: string, // M11.A — optional for backward compat
): Promise<PricingResult> {
  const db = await getDb();
  if (!db) throw new Error("Database non disponibile");
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
  const stockRows = await db.execute<{ productId: string; totalQty: number }>(sql`
    SELECT pb."productId" AS "productId", COALESCE(SUM(ibb."quantity"), 0)::int AS "totalQty"
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
    WHERE l."type" = 'central_warehouse'
      AND pb."productId" IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ${companyId ? sql`AND l."companyId" = ${companyId}` : sql``}
    GROUP BY pb."productId"
  `);
  const stockMap = new Map(
    (stockRows as unknown as Array<{ productId: string; totalQty: number }>).map((s) => [
      s.productId,
      s.totalQty,
    ]),
  );
  const warnings: string[] = [];
  const pricedItems: PricingItemOutput[] = [];
  let sumNet = 0;
  let sumVat = 0;
  let sumGross = 0;
  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) throw new Error(`Prodotto ${item.productId} non trovato`);
    const unitPriceBase = parseFloat(product.unitPrice || "0");
    const vatRate = parseFloat(product.vatRate);
    const unitPriceFinal = unitPriceBase; // no discount for event orders
    const lineTotalNet = roundTo2(unitPriceFinal * item.quantity);
    const lineVat = roundTo2(lineTotalNet * (vatRate / 100));
    const lineTotalGross = roundTo2(lineTotalNet + lineVat);
    sumNet += lineTotalNet;
    sumVat += lineVat;
    sumGross += lineTotalGross;
    // Stock in pezzi → converti in confezioni
    const stockPieces = stockMap.get(item.productId) ?? 0;
    const ppu = product.piecesPerUnit ?? 1;
    const stockAvailableConf = Math.floor(stockPieces / ppu);
    const stockWarning = item.quantity > stockAvailableConf;
    if (stockWarning) {
      warnings.push(`${product.name}: richieste ${item.quantity} conf, disponibili ${stockAvailableConf} conf`);
    }
    pricedItems.push({
      productId: item.productId,
      productSku: product.sku,
      productName: product.name,
      piecesPerUnit: product.piecesPerUnit,
      quantity: item.quantity,
      unitPriceBase: unitPriceBase.toFixed(2),
      discountPercent: "0.00",
      unitPriceFinal: unitPriceFinal.toFixed(2),
      vatRate: vatRate.toFixed(2),
      lineTotalNet: lineTotalNet.toFixed(2),
      lineTotalGross: lineTotalGross.toFixed(2),
      stockAvailableConfezioni: stockAvailableConf,
      stockWarning,
      pricingModel: "tier_discount",
    });
  }
  return {
    discountPercent: "0.00",
    packageName: null,
    items: pricedItems,
    subtotalNet: roundTo2(sumNet).toFixed(2),
    vatAmount: roundTo2(sumVat).toFixed(2),
    totalGross: roundTo2(sumGross).toFixed(2),
    warnings,
    pricingModel: "tier_discount",
  };
}

/** Arrotonda a 2 decimali (half-up) */
function roundTo2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
