import { and, count, eq, ne } from "drizzle-orm";
import { getDb } from "../db";
import { affiliateCommissions, affiliates, orders, retailers } from "../../drizzle/schema";

/**
 * M7-A: Commission service — calcola e gestisce commissioni affiliati.
 * Chiamato dalla state machine a paid/paid_on_delivery e cancelled.
 */

export async function calculateCommissionForOrder(orderId: string): Promise<void> {
  const t0 = Date.now();
  console.log("[commissionService.calculate] start", { orderId });

  const db = (await getDb())!;

  // 1. Load order
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) {
    console.log("[commissionService.calculate] order not found, skip");
    return;
  }

  // 2. Load retailer per affiliateId
  const [retailer] = await db
    .select()
    .from(retailers)
    .where(eq(retailers.id, order.retailerId))
    .limit(1);
  if (!retailer || !retailer.affiliateId) {
    console.log("[commissionService.calculate] retailer has no affiliate, skip", {
      retailerId: order.retailerId,
    });
    return;
  }

  // 3. Load affiliate, verifica active
  const [affiliate] = await db
    .select()
    .from(affiliates)
    .where(eq(affiliates.id, retailer.affiliateId))
    .limit(1);
  if (!affiliate || affiliate.status !== "active") {
    console.log("[commissionService.calculate] affiliate inactive or not found, skip", {
      affiliateId: retailer.affiliateId,
    });
    return;
  }

  // 4. Idempotenza: commissione già esistente per questo orderId?
  const [existing] = await db
    .select()
    .from(affiliateCommissions)
    .where(
      and(
        eq(affiliateCommissions.orderId, orderId),
        ne(affiliateCommissions.status, "voided"),
      ),
    )
    .limit(1);
  if (existing) {
    console.log("[commissionService.calculate] commission already exists, skip", {
      commissionId: existing.id,
    });
    return;
  }

  // 5. Determina isFirstOrder (conta commissioni non-voided per questo retailer)
  const [{ value: prevCount }] = await db
    .select({ value: count() })
    .from(affiliateCommissions)
    .where(
      and(
        eq(affiliateCommissions.retailerId, order.retailerId),
        ne(affiliateCommissions.status, "voided"),
      ),
    );

  const isFirstOrder = prevCount === 0;
  const rate = isFirstOrder
    ? Number(affiliate.firstOrderRate)
    : Number(affiliate.recurringRate);

  // 6. Calcola amount su subtotalNet (escluso IVA)
  const orderTotal = Number(order.subtotalNet);
  const commissionAmount = +(orderTotal * (rate / 100)).toFixed(2);

  // 7. INSERT
  await db.insert(affiliateCommissions).values({
    affiliateId: affiliate.id,
    orderId: order.id,
    retailerId: order.retailerId,
    orderTotal: orderTotal.toFixed(2),
    commissionRate: rate.toFixed(2),
    commissionAmount: commissionAmount.toFixed(2),
    isFirstOrder,
    status: "pending",
    pendingAt: new Date(),
  });

  console.log("[commissionService.calculate] done", {
    orderId,
    affiliateId: affiliate.id,
    rate,
    commissionAmount,
    isFirstOrder,
    ms: Date.now() - t0,
  });
}

export async function voidCommissionForOrder(orderId: string, reason: string): Promise<void> {
  console.log("[commissionService.void] start", { orderId, reason });

  const db = (await getDb())!;

  await db
    .update(affiliateCommissions)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidedReason: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(affiliateCommissions.orderId, orderId),
        ne(affiliateCommissions.status, "voided"),
      ),
    );

  console.log("[commissionService.void] done", { orderId });
}
