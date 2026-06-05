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
  status: "completed" | "partial" | "timeout";
  totalProducts: number;
  totalVariants: number;
}

// ─── Sync Variants from Shopify (bulk upsert) ───────────────────────────────

const CHUNK_SIZE = 200;

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

  let products: ShopifyProduct[];
  try {
    products = await client.fetchAllProducts();
  } catch (fetchErr: any) {
    console.error(
      `[channelVariantService.sync] fetchAllProducts failed: ${fetchErr.message}`,
    );
    return {
      imported: 0,
      updated: 0,
      unmapped: 0,
      errors: [`Errore fetch prodotti da Shopify: ${fetchErr.message}`],
      status: "partial",
      totalProducts: 0,
      totalVariants: 0,
    };
  }

  const fetchElapsed = Date.now() - startTime;
  console.log(
    `[channelVariantService.sync] storeId=${storeId} fetched ${products.length} products in ${fetchElapsed}ms`,
  );

  // 3. Flatten all variants into upsert-ready rows
  const allRows: Array<{
    storeId: string;
    channelSku: string;
    channelProductId: string;
    channelVariantId: string;
    displayName: string;
    multiplier: number;
    isActive: boolean;
  }> = [];

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

  console.log(
    `[channelVariantService.sync] prepared ${allRows.length} variant rows for bulk upsert`,
  );

  if (allRows.length === 0) {
    return {
      imported: 0,
      updated: 0,
      unmapped: 0,
      errors: [],
      status: "completed",
      totalProducts: products.length,
      totalVariants: 0,
    };
  }

  // 4. Count existing before upsert (to calculate imported vs updated)
  const [{ existingCount }] = await db
    .select({ existingCount: sql<number>`count(*)::int` })
    .from(channelVariants)
    .where(eq(channelVariants.storeId, storeId));

  // 5. Bulk upsert in chunks
  const errors: string[] = [];
  let upsertedTotal = 0;

  for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
    const chunk = allRows.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(allRows.length / CHUNK_SIZE);

    try {
      await db
        .insert(channelVariants)
        .values(chunk)
        .onConflictDoUpdate({
          target: [channelVariants.storeId, channelVariants.channelSku],
          set: {
            channelProductId: sql`EXCLUDED."channelProductId"`,
            channelVariantId: sql`EXCLUDED."channelVariantId"`,
            displayName: sql`EXCLUDED."displayName"`,
            updatedAt: new Date(),
            // DO NOT overwrite productId, multiplier (admin manages those)
          },
        });

      upsertedTotal += chunk.length;
      console.log(
        `[channelVariantService.sync] chunk ${chunkNum}/${totalChunks} done (${chunk.length} rows, cumulative ${upsertedTotal})`,
      );
    } catch (chunkErr: any) {
      errors.push(
        `Chunk ${chunkNum}/${totalChunks}: ${chunkErr.message}`,
      );
      console.error(
        `[channelVariantService.sync] chunk ${chunkNum} failed: ${chunkErr.message}`,
      );
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
  const status = errors.length > 0 ? "partial" : "completed";

  console.log(
    `[channelVariantService.sync] bulk upsert ${allRows.length} variants done in ${elapsed}ms. imported=${imported} updated=${updated} unmapped=${unmapped} errors=${errors.length}`,
  );

  return {
    imported,
    updated,
    unmapped,
    errors,
    status,
    totalProducts: products.length,
    totalVariants: allRows.length,
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
