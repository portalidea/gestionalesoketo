/**
 * M6.2.B — Stock availability service
 *
 * Provides getAvailableStock(productIds) that returns:
 * - totalStock: qty in central warehouse
 * - reservedQty: qty reserved by orders in pending/paid/approved_for_shipping
 * - availableQty: totalStock - reservedQty
 *
 * Used by:
 * - catalogPortal (retailer catalog)
 * - retailerCheckout (stock validation)
 * - admin order management (stock check before transition)
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";

export interface ProductStockInfo {
  productId: string;
  totalStock: number;
  reservedQty: number;
  availableQty: number;
}

/**
 * Get available stock for a list of products.
 * Available = central warehouse stock - reserved by active orders.
 * Active orders = status IN (pending, paid, approved_for_shipping).
 */
export async function getAvailableStock(
  productIds: string[],
): Promise<Map<string, ProductStockInfo>> {
  if (productIds.length === 0) return new Map();

  const db = await getDb();
  if (!db) return new Map();

  // 1. Total stock in central warehouse
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

  // 2. Reserved qty from active orders (pending, paid, approved_for_shipping)
  const reservedRows = await db.execute<{ productId: string; reservedQty: number }>(sql`
    SELECT oi."productId" AS "productId",
           COALESCE(SUM(oi."quantity"), 0)::int AS "reservedQty"
    FROM "orderItems" oi
    INNER JOIN "orders" o ON o."id" = oi."orderId"
    WHERE o."status" IN ('pending', 'paid', 'approved_for_shipping')
      AND oi."productId" IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY oi."productId"
  `);

  const reservedMap = new Map(
    (reservedRows as unknown as Array<{ productId: string; reservedQty: number }>).map((r) => [
      r.productId,
      r.reservedQty,
    ]),
  );

  // 3. Combine
  const result = new Map<string, ProductStockInfo>();
  for (const pid of productIds) {
    const totalStock = stockMap.get(pid) ?? 0;
    const reservedQty = reservedMap.get(pid) ?? 0;
    result.set(pid, {
      productId: pid,
      totalStock,
      reservedQty,
      availableQty: Math.max(0, totalStock - reservedQty),
    });
  }

  return result;
}

/**
 * Validate that all items in an order have sufficient stock.
 * Returns list of items with insufficient stock.
 */
export async function validateOrderStock(
  items: Array<{ productId: string; productName: string; quantity: number }>,
): Promise<{ valid: boolean; insufficientItems: Array<{ productName: string; requested: number; available: number }> }> {
  const productIds = items.map((i) => i.productId);
  const stockInfo = await getAvailableStock(productIds);

  const insufficientItems: Array<{ productName: string; requested: number; available: number }> = [];

  for (const item of items) {
    const info = stockInfo.get(item.productId);
    const available = info?.availableQty ?? 0;
    if (item.quantity > available) {
      insufficientItems.push({
        productName: item.productName,
        requested: item.quantity,
        available,
      });
    }
  }

  return { valid: insufficientItems.length === 0, insufficientItems };
}
