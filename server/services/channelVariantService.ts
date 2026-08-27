/**
 * M8.1 — Channel Variant Service
 * Syncs variants from Shopify and manages unmapped variants.
 * Performance: bulk upsert in chunks of 200 (avoids Vercel 60s timeout).
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  channelVariants,
  channelVariantComponents,
  inventoryByBatch,
  locations,
  productBatches,
  salesStores,
} from "../../drizzle/schema";
import { ShopifyClient, type ShopifyProduct } from "./shopifyService";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SyncVariantsResult {
  imported: number;
  updated: number;
  unmapped: number;
  errors: string[];
  duplicateSkus: string[];
  failedSkus: string[];
  errorDetails: VariantSyncErrorDetail[];
  recoveredChunkCount: number;
  status: "completed" | "partial" | "timeout";
  totalProducts: number;
  totalVariants: number;
  pagesFetched: number;
  productsFetched: number;
  variantsFetched: number;
  invalidProducts: number;
}

export interface VariantSyncErrorDetail {
  scope: "chunk" | "row";
  message: string;
  code?: string;
  detail?: string;
  constraint?: string;
  sku?: string;
  chunk?: number;
  recoveredByRowRetry: boolean;
}

export type ShopifyVariantUpsertRow = {
  storeId: string;
  channelSku: string;
  channelProductId: string;
  channelVariantId: string;
  displayName: string;
  multiplier: number;
  isActive: boolean;
};

// ─── Sync Variants from Shopify (bulk upsert) ───────────────────────────────

const CHUNK_SIZE = 200;

/**
 * PostgreSQL non permette alla stessa chiave ON CONFLICT di essere aggiornata
 * due volte nello stesso INSERT. Per una SKU duplicata su Shopify viene
 * mantenuta intenzionalmente l’ultima occorrenza ricevuta.
 */
export function deduplicateShopifyVariantRows(rows: ShopifyVariantUpsertRow[]): {
  rows: ShopifyVariantUpsertRow[];
  duplicateSkus: string[];
} {
  const latestByKey = new Map<string, ShopifyVariantUpsertRow>();
  const duplicateSkus = new Set<string>();
  for (const row of rows) {
    const key = `${row.storeId}:${row.channelSku}`;
    if (latestByKey.has(key)) duplicateSkus.add(row.channelSku);
    latestByKey.set(key, row);
  }
  return {
    rows: Array.from(latestByKey.values()),
    duplicateSkus: Array.from(duplicateSkus).sort(),
  };
}

export function getVariantSyncErrorDetail(
  error: unknown,
  context: Pick<VariantSyncErrorDetail, "scope" | "sku" | "chunk" | "recoveredByRowRetry">,
): VariantSyncErrorDetail {
  const topLevel = error as Record<string, unknown> | undefined;
  const cause = topLevel?.cause as Record<string, unknown> | undefined;
  const source = cause && typeof cause === "object" ? cause : topLevel;
  const readString = (key: string) => typeof source?.[key] === "string" ? source[key] : undefined;
  return {
    ...context,
    message: readString("message") ?? (error instanceof Error ? error.message : String(error)),
    code: readString("code"),
    detail: readString("detail"),
    constraint: readString("constraint"),
  };
}

export interface VariantChunkUpsertResult {
  upsertedCount: number;
  failedSkus: string[];
  errorDetails: VariantSyncErrorDetail[];
  recoveredByRowRetry: boolean;
}

export async function upsertVariantChunkWithFallback(
  chunk: ShopifyVariantUpsertRow[],
  chunkNum: number,
  totalChunks: number,
  upsertRows: (rows: ShopifyVariantUpsertRow[]) => Promise<unknown>,
): Promise<VariantChunkUpsertResult> {
  try {
    await upsertRows(chunk);
    return { upsertedCount: chunk.length, failedSkus: [], errorDetails: [], recoveredByRowRetry: false };
  } catch (chunkErr: unknown) {
    const chunkDetail = getVariantSyncErrorDetail(chunkErr, {
      scope: "chunk", chunk: chunkNum, recoveredByRowRetry: true,
    });
    console.error(
      `[channelVariantService.sync] chunk ${chunkNum}/${totalChunks} failed; retrying ${chunk.length} rows individually`,
      chunkDetail,
    );
    const failedSkus: string[] = [];
    const errorDetails: VariantSyncErrorDetail[] = [chunkDetail];
    let upsertedCount = 0;
    for (const row of chunk) {
      try {
        await upsertRows([row]);
        upsertedCount++;
      } catch (rowErr: unknown) {
        const rowDetail = getVariantSyncErrorDetail(rowErr, {
          scope: "row", sku: row.channelSku, chunk: chunkNum, recoveredByRowRetry: false,
        });
        failedSkus.push(row.channelSku);
        errorDetails.push(rowDetail);
        console.error(`[channelVariantService.sync] SKU ${row.channelSku} failed in fallback`, rowDetail);
      }
    }
    return {
      upsertedCount,
      failedSkus,
      errorDetails,
      recoveredByRowRetry: upsertedCount > 0,
    };
  }
}

export function resolveVariantSyncOutcome(errors: string[], paginationError?: string): {
  errors: string[];
  status: "completed" | "partial";
} {
  const allErrors = paginationError ? [...errors, paginationError] : errors;
  return { errors: allErrors, status: allErrors.length > 0 ? "partial" : "completed" };
}

/**
 * Sync all variants from Shopify store using bulk upsert.
 * Replaces per-variant loop with chunked INSERT ... ON CONFLICT DO UPDATE.
 */
export async function syncVariantsFromShopify(
  storeId: string,
): Promise<SyncVariantsResult> {
  const startTime = Date.now();
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. Get store credentials
  const [store] = await db
    .select()
    .from(salesStores)
    .where(eq(salesStores.id, storeId))
    .limit(1);

  if (!store) throw new Error(`Store ${storeId} not found`);
  if (!store.apiCredentials)
    throw new Error(`Store ${storeId} has no API credentials configured`);

  const credentials = store.apiCredentials as { accessToken: string };
  if (!credentials.accessToken)
    throw new Error(`Store ${storeId} missing accessToken`);

  // 2. Fetch all products/variants from Shopify
  const client = new ShopifyClient(store.storeIdentifier, credentials.accessToken);

  let fetchedCatalog: Awaited<ReturnType<ShopifyClient["fetchAllProducts"]>>;
  try {
    fetchedCatalog = await client.fetchAllProducts();
  } catch (fetchErr: any) {
    console.error(
      `[channelVariantService.sync] fetchAllProducts failed: ${fetchErr.message}`,
    );
    return {
      imported: 0,
      updated: 0,
      unmapped: 0,
      errors: [`Errore fetch prodotti da Shopify: ${fetchErr.message}`],
      duplicateSkus: [],
      failedSkus: [],
      errorDetails: [],
      recoveredChunkCount: 0,
      status: "partial",
      totalProducts: 0,
      totalVariants: 0,
      pagesFetched: 0,
      productsFetched: 0,
      variantsFetched: 0,
      invalidProducts: 0,
    };
  }
  const { products } = fetchedCatalog;

  const fetchElapsed = Date.now() - startTime;
  console.log(
    `[channelVariantService.sync] storeId=${storeId} fetched pages=${fetchedCatalog.pagesFetched} rawProducts=${fetchedCatalog.productsFetched} validProducts=${products.length} variants=${fetchedCatalog.variantsFetched} in ${fetchElapsed}ms`,
  );

  // 3. Flatten all variants into upsert-ready rows
  const allRows: ShopifyVariantUpsertRow[] = [];

  for (const product of products) {
    for (const variant of product.variants) {
      const sku = variant.sku || `variant_${variant.id}`;
      const displayName =
        product.variants.length > 1
          ? `${product.title} - ${variant.title}`
          : product.title;

      allRows.push({
        storeId,
        channelSku: sku,
        channelProductId: String(product.id),
        channelVariantId: String(variant.id),
        displayName,
        multiplier: 1, // default, admin adjusts after
        isActive: true,
      });
    }
  }

  const deduplicated = deduplicateShopifyVariantRows(allRows);
  const uniqueRows = deduplicated.rows;
  console.log(
    `[channelVariantService.sync] prepared variants=${allRows.length} uniqueRows=${uniqueRows.length} duplicateSkus=${deduplicated.duplicateSkus.length}`,
  );

  if (uniqueRows.length === 0) {
    const outcome = resolveVariantSyncOutcome([], fetchedCatalog.paginationError);
    return {
      imported: 0,
      updated: 0,
      unmapped: 0,
      errors: outcome.errors,
      duplicateSkus: deduplicated.duplicateSkus,
      failedSkus: [],
      errorDetails: [],
      recoveredChunkCount: 0,
      status: outcome.status,
      totalProducts: products.length,
      totalVariants: 0,
      pagesFetched: fetchedCatalog.pagesFetched,
      productsFetched: fetchedCatalog.productsFetched,
      variantsFetched: fetchedCatalog.variantsFetched,
      invalidProducts: fetchedCatalog.invalidProducts,
    };
  }

  // 4. Count existing before upsert (to calculate imported vs updated)
  const [{ existingCount }] = await db
    .select({ existingCount: sql<number>`count(*)::int` })
    .from(channelVariants)
    .where(eq(channelVariants.storeId, storeId));

  // 5. Bulk upsert in chunks. Se un chunk fallisce, ogni riga viene
  // ritentata per non perdere tutte le SKU sane dello stesso blocco.
  const errors: string[] = [];
  const failedSkus: string[] = [];
  const errorDetails: VariantSyncErrorDetail[] = [];
  let recoveredChunkCount = 0;
  let upsertedTotal = 0;

  const upsertRows = async (rows: ShopifyVariantUpsertRow[]) =>
    db
      .insert(channelVariants)
      .values(rows)
      .onConflictDoUpdate({
        target: [channelVariants.storeId, channelVariants.channelSku],
        set: {
          channelProductId: sql`EXCLUDED."channelProductId"`,
          channelVariantId: sql`EXCLUDED."channelVariantId"`,
          displayName: sql`EXCLUDED."displayName"`,
          updatedAt: new Date(),
          // productId e multiplier restano gestiti dall'operatore.
        },
      });

  for (let i = 0; i < uniqueRows.length; i += CHUNK_SIZE) {
    const chunk = uniqueRows.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(uniqueRows.length / CHUNK_SIZE);

    const result = await upsertVariantChunkWithFallback(
      chunk,
      chunkNum,
      totalChunks,
      upsertRows,
    );
    upsertedTotal += result.upsertedCount;
    failedSkus.push(...result.failedSkus);
    errorDetails.push(...result.errorDetails);
    if (result.recoveredByRowRetry) recoveredChunkCount++;
    if (result.errorDetails.length === 0) {
      console.log(
        `[channelVariantService.sync] chunk ${chunkNum}/${totalChunks} done (${chunk.length} rows, cumulative ${upsertedTotal})`,
      );
    } else {
      for (const detail of result.errorDetails) {
        if (detail.scope === "row") {
          errors.push(`SKU ${detail.sku}: ${detail.message}`);
        }
      }
    }
  }

  // 6. Count after upsert to determine imported vs updated
  const [{ afterCount }] = await db
    .select({ afterCount: sql<number>`count(*)::int` })
    .from(channelVariants)
    .where(eq(channelVariants.storeId, storeId));

  const imported = afterCount - existingCount;
  const updated = upsertedTotal - imported;

  // 7. Count unmapped
  const [{ count: unmapped }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelVariants)
    .where(
      and(
        eq(channelVariants.storeId, storeId),
        isNull(channelVariants.productId),
        eq(channelVariants.isActive, true),
      ),
    );

  const elapsed = Date.now() - startTime;
  const outcome = resolveVariantSyncOutcome(errors, fetchedCatalog.paginationError);

  console.log(
    `[channelVariantService.sync] bulk upsert ${allRows.length} variants done in ${elapsed}ms. imported=${imported} updated=${updated} unmapped=${unmapped} errors=${errors.length}`,
  );

  return {
    imported,
    updated,
    unmapped,
    errors: outcome.errors,
    duplicateSkus: deduplicated.duplicateSkus,
    failedSkus,
    errorDetails,
    recoveredChunkCount,
    status: outcome.status,
    totalProducts: products.length,
    totalVariants: allRows.length,
    pagesFetched: fetchedCatalog.pagesFetched,
    productsFetched: fetchedCatalog.productsFetched,
    variantsFetched: fetchedCatalog.variantsFetched,
    invalidProducts: fetchedCatalog.invalidProducts,
  };
}

// ─── Compute Bundle Available Stock ──────────────────────────────────────────

/**
 * Compute available stock for a channel variant.
 * For simple variants: sum(inventoryByBatch) / multiplier
 * For bundles: min across components of floor(componentStock / componentQty)
 */
export async function computeVariantAvailableStock(
  variantId: string,
  companyId?: string,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  // 1. Load variant
  const [variant] = await db
    .select({
      id: channelVariants.id,
      productId: channelVariants.productId,
      multiplier: channelVariants.multiplier,
      isBundle: channelVariants.isBundle,
    })
    .from(channelVariants)
    .where(eq(channelVariants.id, variantId))
    .limit(1);

  if (!variant) return 0;

  // 2. Get central warehouse (M11.A: filtro companyId)
  const warehouseConditions: any[] = [eq(locations.type, "central_warehouse")];
  if (companyId) warehouseConditions.push(eq(locations.companyId, companyId));
  const [warehouse] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(...warehouseConditions))
    .limit(1);

  if (!warehouse) return 0;

  if (!variant.isBundle) {
    // Simple variant: stock / multiplier
    if (!variant.productId) return 0;
    const stock = await getProductStockInWarehouse(variant.productId, warehouse.id);
    return Math.floor(stock / variant.multiplier);
  }

  // Bundle: min across components
  const components = await db
    .select({
      productId: channelVariantComponents.productId,
      quantity: channelVariantComponents.quantity,
    })
    .from(channelVariantComponents)
    .where(eq(channelVariantComponents.channelVariantId, variantId));

  if (components.length === 0) return 0;

  let minBundles = Infinity;
  for (const c of components) {
    const componentStock = await getProductStockInWarehouse(c.productId, warehouse.id);
    const possibleBundles = Math.floor(componentStock / c.quantity);
    minBundles = Math.min(minBundles, possibleBundles);
  }

  return minBundles === Infinity ? 0 : minBundles;
}

/**
 * Helper: get total available stock for a product in a specific warehouse.
 */
async function getProductStockInWarehouse(
  productId: string,
  warehouseId: string,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const [row] = await db
    .select({
      totalQty: sql<number>`COALESCE(SUM(${inventoryByBatch.quantity}), 0)::int`,
    })
    .from(inventoryByBatch)
    .innerJoin(productBatches, eq(inventoryByBatch.batchId, productBatches.id))
    .where(
      and(
        eq(productBatches.productId, productId),
        eq(inventoryByBatch.locationId, warehouseId),
        gt(inventoryByBatch.quantity, 0),
      ),
    );

  return row?.totalQty ?? 0;
}

// ─── Get Unmapped Variants ───────────────────────────────────────────────────

export async function getUnmappedVariants(storeId: string) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(channelVariants)
    .where(
      and(
        eq(channelVariants.storeId, storeId),
        isNull(channelVariants.productId),
        eq(channelVariants.isActive, true),
      ),
    );
}

// ─── Get Variant Counts ──────────────────────────────────────────────────────

export async function getVariantCounts(storeId: string): Promise<{
  total: number;
  mapped: number;
  unmapped: number;
}> {
  const db = await getDb();
  if (!db) return { total: 0, mapped: 0, unmapped: 0 };

  const [result] = await db
    .select({
      total: sql<number>`count(*)::int`,
      mapped: sql<number>`count("productId")::int`,
    })
    .from(channelVariants)
    .where(
      and(eq(channelVariants.storeId, storeId), eq(channelVariants.isActive, true)),
    );

  return {
    total: result.total,
    mapped: result.mapped,
    unmapped: result.total - result.mapped,
  };
}
