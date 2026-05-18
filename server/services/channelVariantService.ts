/**
 * M8.1 — Channel Variant Service
 * Syncs variants from Shopify and manages unmapped variants.
 * Hardened: progress logging, per-variant error handling, timeout awareness.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { channelVariants, salesStores } from "../../drizzle/schema";
import { ShopifyClient } from "./shopifyService";

// ─── Sync Variants from Shopify ──────────────────────────────────────────────

export interface SyncVariantsResult {
  imported: number;
  updated: number;
  unmapped: number;
  errors: string[];
  status: "completed" | "partial" | "timeout";
  totalProducts: number;
  processedProducts: number;
}

/**
 * Sync all variants from Shopify store.
 * Includes timeout awareness: if approaching maxDurationMs, returns partial result.
 * @param storeId - UUID of the sales_stores record
 * @param maxDurationMs - Maximum allowed duration in ms (default 28000 = 28s, under Vercel 30s)
 */
export async function syncVariantsFromShopify(
  storeId: string,
  maxDurationMs = 28000,
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

  // 2. Fetch all products/variants from Shopify (pagination handled inside client)
  const client = new ShopifyClient(store.storeIdentifier, credentials.accessToken);

  let products;
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
      processedProducts: 0,
    };
  }

  console.log(
    `[channelVariantService.sync] storeId=${storeId} fetched ${products.length} products from Shopify in ${Date.now() - startTime}ms`,
  );

  let imported = 0;
  let updated = 0;
  let processedProducts = 0;
  const errors: string[] = [];
  let timedOut = false;

  // 3. For each product, UPSERT variants
  for (let i = 0; i < products.length; i++) {
    // Timeout check: leave 2s margin for final DB query
    if (Date.now() - startTime > maxDurationMs - 2000) {
      console.warn(
        `[channelVariantService.sync] timeout approaching at product ${i + 1}/${products.length} (${Date.now() - startTime}ms elapsed). Stopping.`,
      );
      timedOut = true;
      break;
    }

    const product = products[i];

    // Progress logging every 50 products
    if (i > 0 && i % 50 === 0) {
      console.log(
        `[channelVariantService.sync] progress: ${i}/${products.length} products processed, imported=${imported} updated=${updated} errors=${errors.length} (${Date.now() - startTime}ms)`,
      );
    }

    for (const variant of product.variants) {
      const sku = variant.sku || `variant_${variant.id}`;

      try {
        // Check if already exists
        const existing = await db
          .select({
            id: channelVariants.id,
            productId: channelVariants.productId,
            multiplier: channelVariants.multiplier,
          })
          .from(channelVariants)
          .where(
            and(
              eq(channelVariants.storeId, storeId),
              eq(channelVariants.channelSku, sku),
            ),
          )
          .limit(1);

        const displayName =
          product.variants.length > 1
            ? `${product.title} - ${variant.title}`
            : product.title;

        if (existing.length > 0) {
          // Update: only channelProductId, channelVariantId, displayName
          // Do NOT overwrite productId or multiplier (admin manages those)
          await db
            .update(channelVariants)
            .set({
              channelProductId: String(product.id),
              channelVariantId: String(variant.id),
              displayName,
              updatedAt: new Date(),
            })
            .where(eq(channelVariants.id, existing[0].id));
          updated++;
        } else {
          // Insert new: productId=NULL, multiplier=1 (admin must map)
          await db.insert(channelVariants).values({
            storeId,
            channelSku: sku,
            channelProductId: String(product.id),
            channelVariantId: String(variant.id),
            displayName,
            productId: null,
            multiplier: 1,
            isActive: true,
          });
          imported++;
        }
      } catch (variantErr: any) {
        errors.push(
          `Prodotto "${product.title}" SKU "${sku}": ${variantErr.message}`,
        );
        console.error(
          `[channelVariantService.sync] error on product=${product.id} sku=${sku}: ${variantErr.message}`,
        );
      }
    }

    processedProducts++;
  }

  // 4. Count unmapped
  let unmapped = 0;
  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channelVariants)
      .where(
        and(
          eq(channelVariants.storeId, storeId),
          isNull(channelVariants.productId),
          eq(channelVariants.isActive, true),
        ),
      );
    unmapped = count;
  } catch (countErr: any) {
    console.error(
      `[channelVariantService.sync] count unmapped failed: ${countErr.message}`,
    );
  }

  const elapsed = Date.now() - startTime;
  const status = timedOut ? "timeout" : errors.length > 0 ? "partial" : "completed";

  console.log(
    `[channelVariantService.sync] done: storeId=${storeId} status=${status} imported=${imported} updated=${updated} unmapped=${unmapped} errors=${errors.length} processedProducts=${processedProducts}/${products.length} elapsed=${elapsed}ms`,
  );

  return {
    imported,
    updated,
    unmapped,
    errors,
    status,
    totalProducts: products.length,
    processedProducts,
  };
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
