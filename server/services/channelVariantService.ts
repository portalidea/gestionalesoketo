/**
 * M8.1 — Channel Variant Service
 * Syncs variants from Shopify and manages unmapped variants.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { channelVariants, salesStores } from "../../drizzle/schema";
import { ShopifyClient } from "./shopifyService";

// ─── Sync Variants from Shopify ──────────────────────────────────────────────

export async function syncVariantsFromShopify(storeId: string): Promise<{
  imported: number;
  updated: number;
  unmapped: number;
}> {
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
  const products = await client.fetchAllProducts();

  let imported = 0;
  let updated = 0;

  // 3. For each variant, UPSERT into channel_variants
  for (const product of products) {
    for (const variant of product.variants) {
      const sku = variant.sku || `variant_${variant.id}`;

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

      if (existing.length > 0) {
        // Update: only channelProductId, channelVariantId, displayName
        // Do NOT overwrite productId or multiplier (admin manages those)
        await db
          .update(channelVariants)
          .set({
            channelProductId: String(product.id),
            channelVariantId: String(variant.id),
            displayName:
              product.variants.length > 1
                ? `${product.title} - ${variant.title}`
                : product.title,
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
          displayName:
            product.variants.length > 1
              ? `${product.title} - ${variant.title}`
              : product.title,
          productId: null,
          multiplier: 1,
          isActive: true,
        });
        imported++;
      }
    }
  }

  // 4. Count unmapped
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

  console.log(
    `[channelVariantService.sync] storeId=${storeId} imported=${imported} updated=${updated} unmapped=${unmapped}`,
  );

  return { imported, updated, unmapped };
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
