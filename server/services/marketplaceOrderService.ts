/**
 * M8.1 — Marketplace Order Service
 * Handles import, stock processing (FEFO), and retry for marketplace orders.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  channelVariants,
  channelVariantComponents,
  inventoryByBatch,
  locations,
  marketplaceOrderItems,
  marketplaceOrders,
  productBatches,
  stockMovements,
} from "../../drizzle/schema";
import type { ShopifyOrder } from "./shopifyService";

// ─── Import Order ────────────────────────────────────────────────────────────

export async function importShopifyOrder(
  storeId: string,
  shopifyOrder: ShopifyOrder,
): Promise<{
  marketplaceOrderId: string;
  status: "imported" | "duplicate" | "error";
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const channelOrderId = String(shopifyOrder.id);

  // 1. Idempotency check
  const existing = await db
    .select({ id: marketplaceOrders.id })
    .from(marketplaceOrders)
    .where(
      and(
        eq(marketplaceOrders.storeId, storeId),
        eq(marketplaceOrders.channelOrderId, channelOrderId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    console.log(
      `[marketplaceOrderService.import] duplicate: storeId=${storeId} orderId=${channelOrderId}`,
    );
    return { marketplaceOrderId: existing[0].id, status: "duplicate" };
  }

  // 2. Build customer name
  const customerName = shopifyOrder.customer
    ? [shopifyOrder.customer.first_name, shopifyOrder.customer.last_name]
        .filter(Boolean)
        .join(" ") || null
    : null;

  // 3. Lookup channel_variants for each line item SKU
  const skus = shopifyOrder.line_items
    .map((li) => li.sku)
    .filter((s): s is string => !!s);

  const variantMap = new Map<
    string,
    { id: string; productId: string | null; multiplier: number }
  >();

  if (skus.length > 0) {
    const variants = await db
      .select({
        id: channelVariants.id,
        channelSku: channelVariants.channelSku,
        productId: channelVariants.productId,
        multiplier: channelVariants.multiplier,
      })
      .from(channelVariants)
      .where(
        and(
          eq(channelVariants.storeId, storeId),
          inArray(channelVariants.channelSku, skus),
          eq(channelVariants.isActive, true),
        ),
      );

    for (const v of variants) {
      variantMap.set(v.channelSku, {
        id: v.id,
        productId: v.productId,
        multiplier: v.multiplier,
      });
    }
  }

  // 4. Transaction: insert order + items
  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(marketplaceOrders)
      .values({
        storeId,
        channelOrderId,
        channelOrderNumber: String(shopifyOrder.order_number),
        customerEmail: shopifyOrder.email || null,
        customerName,
        orderDate: new Date(shopifyOrder.created_at),
        totalGross: shopifyOrder.total_price,
        currency: shopifyOrder.currency,
        shippingCountry:
          shopifyOrder.shipping_address?.country_code || null,
        rawPayload: shopifyOrder as unknown as Record<string, unknown>,
        stockProcessingStatus: "pending",
      })
      .returning();

    // Insert items
    const itemValues = shopifyOrder.line_items.map((li) => {
      const sku = li.sku || `unknown_${li.id}`;
      const variant = variantMap.get(sku);
      const multiplier = variant?.multiplier ?? 1;
      return {
        marketplaceOrderId: order.id,
        channelSku: sku,
        productId: variant?.productId || null,
        channelVariantId: variant?.id || null,
        channelQuantity: li.quantity,
        piecesQuantity: li.quantity * multiplier,
        unitPrice: li.price,
        lineTotal: (parseFloat(li.price) * li.quantity).toFixed(2),
        displayName: li.name,
      };
    });

    if (itemValues.length > 0) {
      await tx.insert(marketplaceOrderItems).values(itemValues);
    }

    return order;
  });

  console.log(
    `[marketplaceOrderService.import] imported: marketplaceOrderId=${result.id} channelOrderId=${channelOrderId}`,
  );
  return { marketplaceOrderId: result.id, status: "imported" };
}

// ─── Process Stock (FEFO) ────────────────────────────────────────────────────

export async function processStockForMarketplaceOrder(
  marketplaceOrderId: string,
): Promise<{ status: "processed" | "partial" | "failed"; errors: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. Load order
  const [order] = await db
    .select()
    .from(marketplaceOrders)
    .where(eq(marketplaceOrders.id, marketplaceOrderId))
    .limit(1);

  if (!order) throw new Error(`Order ${marketplaceOrderId} not found`);

  // 2. Idempotency: skip if already processed
  if (order.stockProcessingStatus === "processed") {
    console.log(
      `[marketplaceOrderService.processStock] already processed: ${marketplaceOrderId}`,
    );
    return { status: "processed", errors: [] };
  }

  // 3. Load items
  const items = await db
    .select()
    .from(marketplaceOrderItems)
    .where(eq(marketplaceOrderItems.marketplaceOrderId, marketplaceOrderId));

  // 4. Find central warehouse
  const [warehouse] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.type, "central_warehouse"))
    .limit(1);

  if (!warehouse) {
    await db
      .update(marketplaceOrders)
      .set({
        stockProcessingStatus: "failed",
        stockProcessingError: "Magazzino centrale non configurato",
        stockProcessingAttempts: sql`"stockProcessingAttempts" + 1`,
        updatedAt: new Date(),
      })
      .where(eq(marketplaceOrders.id, marketplaceOrderId));
    return { status: "failed", errors: ["Magazzino centrale non configurato"] };
  }

  const errors: string[] = [];
  let processedCount = 0;

  // 5. Process each item — resolve variant to determine simple vs bundle
  for (const item of items) {
    try {
      // Load channel variant to check isBundle
      let variant: { id: string; productId: string | null; multiplier: number; isBundle: boolean } | null = null;
      if (item.channelVariantId) {
        const [v] = await db
          .select({
            id: channelVariants.id,
            productId: channelVariants.productId,
            multiplier: channelVariants.multiplier,
            isBundle: channelVariants.isBundle,
          })
          .from(channelVariants)
          .where(eq(channelVariants.id, item.channelVariantId))
          .limit(1);
        variant = v || null;
      }

      if (variant?.isBundle) {
        // ─── Bundle case: decrement each component separately ───
        const components = await db
          .select({
            productId: channelVariantComponents.productId,
            quantity: channelVariantComponents.quantity,
          })
          .from(channelVariantComponents)
          .where(eq(channelVariantComponents.channelVariantId, variant.id));

        if (components.length === 0) {
          errors.push(
            `SKU "${item.channelSku}" (${item.displayName}): bundle senza componenti configurati`,
          );
          continue;
        }

        let bundleOk = true;
        for (const component of components) {
          const requiredQty = component.quantity * item.channelQuantity;

          const fefoResult = await decrementStockFEFO({
            db,
            productId: component.productId,
            quantity: requiredQty,
            warehouseId: warehouse.id,
            marketplaceOrderId,
            notes: `Shopify order #${order.channelOrderNumber}`,
            notesInternal: `Shopify order #${order.channelOrderNumber}, bundle ${item.displayName} component, customer: ${order.customerName || order.customerEmail || "N/A"}, SKU: ${item.channelSku}`,
          });

          if (fefoResult.shortfall > 0) {
            errors.push(
              `SKU "${item.channelSku}" bundle component productId=${component.productId}: stock insufficiente, mancano ${fefoResult.shortfall} pezzi`,
            );
            bundleOk = false;
          }
        }

        if (bundleOk) processedCount++;
      } else {
        // ─── Simple case: single product ───
        if (!item.productId) {
          errors.push(
            `SKU "${item.channelSku}" (${item.displayName}): non mappato a prodotto interno`,
          );
          continue;
        }

        const fefoResult = await decrementStockFEFO({
          db,
          productId: item.productId,
          quantity: item.piecesQuantity,
          warehouseId: warehouse.id,
          marketplaceOrderId,
          notes: `Shopify order #${order.channelOrderNumber}`,
          notesInternal: `Shopify order #${order.channelOrderNumber}, customer: ${order.customerName || order.customerEmail || "N/A"}, SKU: ${item.channelSku}`,
        });

        if (fefoResult.shortfall > 0) {
          errors.push(
            `SKU "${item.channelSku}" (${item.displayName}): stock insufficiente, mancano ${fefoResult.shortfall} pezzi su ${item.piecesQuantity} richiesti`,
          );
        } else {
          processedCount++;
        }
      }
    } catch (e: any) {
      errors.push(
        `SKU "${item.channelSku}" (${item.displayName}): errore — ${e.message}`,
      );
    }
  }

  // 6. Determine final status
  const itemsWithProduct = items.filter((i) => i.productId);
  let finalStatus: "processed" | "partial" | "failed";

  if (errors.length === 0) {
    finalStatus = "processed";
  } else if (processedCount > 0) {
    finalStatus = "partial";
  } else {
    finalStatus = "failed";
  }

  // 7. Update order status
  await db
    .update(marketplaceOrders)
    .set({
      stockProcessingStatus: finalStatus,
      stockProcessedAt: finalStatus === "processed" ? new Date() : null,
      stockProcessingError: errors.length > 0 ? errors.join("; ") : null,
      stockProcessingAttempts: sql`"stockProcessingAttempts" + 1`,
      updatedAt: new Date(),
    })
    .where(eq(marketplaceOrders.id, marketplaceOrderId));

  console.log(
    `[marketplaceOrderService.processStock] orderId=${marketplaceOrderId} status=${finalStatus} processed=${processedCount}/${itemsWithProduct.length} errors=${errors.length}`,
  );

  return { status: finalStatus, errors };
}

// ─── Retry Failed Orders ─────────────────────────────────────────────────────

export async function retryFailedOrders(
  storeId?: string,
): Promise<{ retried: number; succeeded: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [
    inArray(marketplaceOrders.stockProcessingStatus, [
      "failed",
      "partial",
    ]),
    sql`"stockProcessingAttempts" < 5`,
  ];

  if (storeId) {
    conditions.push(eq(marketplaceOrders.storeId, storeId));
  }

  const failedOrders = await db
    .select({ id: marketplaceOrders.id })
    .from(marketplaceOrders)
    .where(and(...conditions));

  let succeeded = 0;

  for (const order of failedOrders) {
    // Reset error before retry
    await db
      .update(marketplaceOrders)
      .set({
        stockProcessingError: null,
        updatedAt: new Date(),
      })
      .where(eq(marketplaceOrders.id, order.id));

    const result = await processStockForMarketplaceOrder(order.id);
    if (result.status === "processed") {
      succeeded++;
    }
  }

  console.log(
    `[marketplaceOrderService.retryFailed] retried=${failedOrders.length} succeeded=${succeeded}`,
  );

  return { retried: failedOrders.length, succeeded };
}

// ─── FEFO Decrement Helper ──────────────────────────────────────────────────

interface DecrementStockFEFOParams {
  db: any;
  productId: string;
  quantity: number;
  warehouseId: string;
  marketplaceOrderId: string;
  notes: string;
  notesInternal: string;
}

async function decrementStockFEFO(
  params: DecrementStockFEFOParams,
): Promise<{ allocated: number; shortfall: number }> {
  const { db, productId, quantity, warehouseId, marketplaceOrderId, notes, notesInternal } = params;

  // FEFO: get available batches ordered by expiration
  const availableBatches = await db
    .select({
      batchId: productBatches.id,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      quantity: inventoryByBatch.quantity,
      inventoryId: inventoryByBatch.id,
    })
    .from(productBatches)
    .innerJoin(
      inventoryByBatch,
      and(
        eq(inventoryByBatch.batchId, productBatches.id),
        eq(inventoryByBatch.locationId, warehouseId),
      ),
    )
    .where(
      and(
        eq(productBatches.productId, productId),
        gt(inventoryByBatch.quantity, 0),
      ),
    )
    .orderBy(asc(productBatches.expirationDate));

  let remaining = quantity;

  // Greedy FEFO allocation
  for (const batch of availableBatches) {
    if (remaining <= 0) break;
    const allocQty = Math.min(remaining, batch.quantity);

    // Decrement central stock
    await db
      .update(inventoryByBatch)
      .set({
        quantity: batch.quantity - allocQty,
        updatedAt: new Date(),
      })
      .where(eq(inventoryByBatch.id, batch.inventoryId));

    // Create stock movement
    await db.insert(stockMovements).values({
      productId,
      type: "SHOPIFY_EXIT",
      quantity: allocQty,
      previousQuantity: batch.quantity,
      newQuantity: batch.quantity - allocQty,
      batchId: batch.batchId,
      fromLocationId: warehouseId,
      toLocationId: null,
      marketplaceOrderId,
      notes,
      notesInternal: `${notesInternal}, batch: ${batch.batchNumber}`,
    });

    remaining -= allocQty;
  }

  return {
    allocated: quantity - remaining,
    shortfall: remaining,
  };
}
