/**
 * M8.1 — Channel Variant Service
 * Syncs variants from Shopify and manages unmapped variants.
 * Performance: bulk upsert in chunks of 200 (avoids Vercel 60s timeout).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { channelVariants, salesStores } from "../../drizzle/schema";
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
