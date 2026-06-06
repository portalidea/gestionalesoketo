/**
 * M6.2.G — Order State Machine Service (refactored)
 *
 * Two independent axes:
 * 1. Fulfillment: pending → transferring → shipped → delivered | cancelled
 * 2. Payment: unpaid → paid | refunded
 *
 * transitionFulfillment() handles axis 1.
 * registerPayment() / cancelPayment() handle axis 2.
 * modifyOrderItems() remains unchanged (operates on pending orders).
 */
import { TRPCError } from "@trpc/server";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import { orders, orderItems, retailers, products, productBatches } from "../../drizzle/schema";
import * as ficDocService from "./ficDocumentService";
import { sendOrderStatusEmail } from "./orderEmailService";

// --- Types ---

export type OrderStatus = "pending" | "transferring" | "shipped" | "delivered" | "cancelled";
export type PaymentStatus = "unpaid" | "paid" | "refunded";
export type PaymentTerms = "advance_transfer" | "on_delivery" | "credit_card" | "manual";

// --- Fulfillment State Machine ---

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["transferring", "cancelled"],
  transferring: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [], // terminal
  cancelled: [], // terminal
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// --- Timestamp mapping ---

const TIMESTAMP_MAP: Partial<Record<OrderStatus, string>> = {
  transferring: "transferringAt",
  shipped: "shippedAt",
  delivered: "deliveredAt",
  cancelled: "cancelledAt",
};

// --- Fulfillment transition ---

export interface TransitionInput {
  orderId: string;
  toStatus: OrderStatus;
  actorUserId: string;
  reason?: string; // for cancellation
}

export interface TransitionResult {
  previousStatus: OrderStatus;
  newStatus: OrderStatus;
  ficProformaId?: number;
  ficProformaNumber?: string;
  ficInvoiceId?: number;
  ficInvoiceNumber?: string;
}

export async function transitionOrder(input: TransitionInput): Promise<TransitionResult> {
  const t0 = Date.now();
  const { orderId, toStatus, actorUserId, reason } = input;
  console.log(`[orderStateMachine] transitionOrder start orderId=${orderId} to=${toStatus}`);

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  // 1. Load current order
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentTerms: orders.paymentTerms,
      retailerId: orders.retailerId,
      orderNumber: orders.orderNumber,
      ficProformaId: orders.ficProformaId,
      ficProformaNumber: orders.ficProformaNumber,
      totalGross: orders.totalGross,
      notes: orders.notes,
      notesInternal: orders.notesInternal,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
  }

  const currentStatus = order.status as OrderStatus;
  const paymentTerms = order.paymentTerms as PaymentTerms;

  // 2. Validate transition — NO payment gate
  if (!canTransition(currentStatus, toStatus)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Transizione non valida: ${currentStatus} → ${toStatus}. Consentite: ${VALID_TRANSITIONS[currentStatus]?.join(", ") || "nessuna"}`,
    });
  }

  // 3. Execute side effects
  let ficProformaId = order.ficProformaId;
  let ficProformaNumber = order.ficProformaNumber;
  let ficInvoiceId: number | undefined;
  let ficInvoiceNumber: string | undefined;

  const transitionKey = `${currentStatus}→${toStatus}`;

  switch (transitionKey) {
    case "pending→transferring": {
      // Validate all items have batches assigned
      const items = await db
        .select({ id: orderItems.id, batchId: orderItems.batchId, productName: orderItems.productName })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      const unassigned = items.filter((it) => !it.batchId);
      if (unassigned.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Impossibile trasferire: ${unassigned.length} item(s) senza lotto assegnato (${unassigned.map((u) => u.productName).join(", ")})`,
        });
      }

      // Create proforma on FiC if not already created and it's a retailer order
      if (!ficProformaId && order.retailerId) {
        const [retailer] = await db
          .select({ ficClientId: retailers.ficClientId, name: retailers.name })
          .from(retailers)
          .where(eq(retailers.id, order.retailerId))
          .limit(1);

        if (retailer?.ficClientId) {
          const ficItems = await db
            .select({
              productName: orderItems.productName,
              productSku: orderItems.productSku,
              quantity: orderItems.quantity,
              unitPriceFinal: orderItems.unitPriceFinal,
              vatRate: orderItems.vatRate,
              batchId: orderItems.batchId,
              batchNumber: productBatches.batchNumber,
              expirationDate: productBatches.expirationDate,
            })
            .from(orderItems)
            .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
            .where(eq(orderItems.orderId, orderId));

          try {
            const proforma = await ficDocService.createProforma({
              orderId,
              orderNumber: order.orderNumber ?? "",
              retailerFicClientId: retailer.ficClientId,
              items: ficItems.map((it) => ({
                productName: it.productName,
                quantity: it.quantity,
                unitPrice: parseFloat(it.unitPriceFinal),
                vatRate: parseFloat(it.vatRate),
                batchNumber: it.batchNumber ?? undefined,
                expiryDate: it.expirationDate ?? undefined,
                sku: it.productSku ?? undefined,
              })),
              paymentTerms,
              totalGross: order.totalGross ? parseFloat(order.totalGross) : undefined,
              notes: order.notesInternal ?? undefined,
            });
            ficProformaId = proforma.ficDocumentId;
            ficProformaNumber = proforma.ficNumber;
          } catch (e: any) {
            console.error(`[orderStateMachine] createProforma failed: ${e.message}`);
            // Don't block transition
          }
        }
      }
      break;
    }

    case "shipped→delivered": {
      // Transform proforma → invoice when payment is already done
      if (ficProformaId && order.paymentStatus === "paid") {
        try {
          const invoice = await ficDocService.transformProformaToInvoice(ficProformaId);
          ficInvoiceId = invoice.ficInvoiceId;
          ficInvoiceNumber = invoice.ficInvoiceNumber;
        } catch (e: any) {
          console.error(`[orderStateMachine] transformToInvoice failed: ${e.message}`);
        }
      }
      break;
    }

    case "pending→cancelled":
    case "transferring→cancelled": {
      // Delete proforma from FiC
      if (ficProformaId) {
        try {
          await ficDocService.deleteProforma(ficProformaId);
        } catch (e: any) {
          console.error(`[orderStateMachine] deleteProforma failed: ${e.message}`);
        }
      }
      // M7-A: Void commission if exists
      try {
        const { voidCommissionForOrder } = await import("./commissionService");
        await voidCommissionForOrder(orderId, reason ?? "Ordine annullato");
      } catch (e: any) {
        console.error(`[orderStateMachine] commission void failed: ${e.message}`);
      }
      break;
    }
  }

  // 4. Update order status + timestamps
  const updateData: Record<string, any> = {
    status: toStatus,
    updatedAt: new Date(),
  };

  const tsField = TIMESTAMP_MAP[toStatus];
  if (tsField) {
    updateData[tsField] = new Date();
  }

  if (ficProformaId !== order.ficProformaId) {
    updateData.ficProformaId = ficProformaId;
    updateData.ficProformaNumber = ficProformaNumber;
  }
  if (ficInvoiceId) {
    updateData.ficInvoiceId = ficInvoiceId;
    updateData.ficInvoiceNumber = ficInvoiceNumber;
  }
  if (toStatus === "cancelled") {
    updateData.cancelledReason = reason ?? null;
    if (ficProformaId) {
      updateData.ficProformaId = null;
      updateData.ficProformaNumber = null;
    }
  }

  await db.update(orders).set(updateData).where(eq(orders.id, orderId));

  // 5. Send email notification (async, don't block)
  sendOrderStatusEmail({
    orderId,
    orderNumber: order.orderNumber ?? "",
    retailerId: order.retailerId!,
    newStatus: toStatus,
    previousStatus: currentStatus,
    reason,
    ficInvoiceNumber,
  }).catch((err) => {
    console.error(`[orderStateMachine] email notification failed: ${err.message}`);
  });

  console.log(
    `[orderStateMachine] transitionOrder DONE ${currentStatus}→${toStatus} (${Date.now() - t0}ms)`,
  );

  return {
    previousStatus: currentStatus,
    newStatus: toStatus,
    ficProformaId: ficProformaId ?? undefined,
    ficProformaNumber: ficProformaNumber ?? undefined,
    ficInvoiceId,
    ficInvoiceNumber,
  };
}

// --- Payment axis ---

export interface RegisterPaymentInput {
  orderId: string;
  actorUserId: string;
  paidAt: Date;
  paymentMethod: string;
  note?: string;
}

export interface RegisterPaymentResult {
  paymentStatus: PaymentStatus;
  paidAt: Date;
  paymentMethod: string;
  ficInvoiceId?: number;
  ficInvoiceNumber?: string;
}

export async function registerPayment(input: RegisterPaymentInput): Promise<RegisterPaymentResult> {
  const t0 = Date.now();
  console.log(`[orderStateMachine] registerPayment orderId=${input.orderId}`);

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentTerms: orders.paymentTerms,
      retailerId: orders.retailerId,
      orderNumber: orders.orderNumber,
      ficProformaId: orders.ficProformaId,
      totalGross: orders.totalGross,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);

  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

  if (order.paymentStatus !== "unpaid") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Pagamento già registrato (stato: ${order.paymentStatus})` });
  }
  if (order.status === "cancelled") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Impossibile registrare pagamento su ordine annullato" });
  }

  // Update payment fields
  const updateData: Record<string, any> = {
    paymentStatus: "paid",
    paidAt: input.paidAt,
    paymentMethod: input.paymentMethod,
    updatedAt: new Date(),
  };

  // If note provided, append to notesInternal
  if (input.note) {
    const existingNotes = order.orderNumber; // we'll read notesInternal separately
    const [orderFull] = await db
      .select({ notesInternal: orders.notesInternal })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    const existing = orderFull?.notesInternal ?? "";
    updateData.notesInternal = existing
      ? `${existing}\n[Pagamento] ${input.note}`
      : `[Pagamento] ${input.note}`;
  }

  await db.update(orders).set(updateData).where(eq(orders.id, input.orderId));

  // M7-A: Calculate commission
  try {
    const { calculateCommissionForOrder } = await import("./commissionService");
    await calculateCommissionForOrder(input.orderId);
  } catch (e: any) {
    console.error(`[orderStateMachine] commission calculate failed: ${e.message}`);
  }

  // Transform proforma → invoice if order is already delivered
  let ficInvoiceId: number | undefined;
  let ficInvoiceNumber: string | undefined;
  if (order.ficProformaId && order.status === "delivered") {
    try {
      const invoice = await ficDocService.transformProformaToInvoice(order.ficProformaId);
      ficInvoiceId = invoice.ficInvoiceId;
      ficInvoiceNumber = invoice.ficInvoiceNumber;
      await db.update(orders).set({ ficInvoiceId, ficInvoiceNumber }).where(eq(orders.id, input.orderId));
    } catch (e: any) {
      console.error(`[orderStateMachine] transformToInvoice on payment failed: ${e.message}`);
    }
  }

  // Send email "Pagamento ricevuto"
  if (order.retailerId) {
    sendOrderStatusEmail({
      orderId: input.orderId,
      orderNumber: order.orderNumber ?? "",
      retailerId: order.retailerId,
      newStatus: "payment_received",
      previousStatus: order.status as string,
      ficInvoiceNumber,
    }).catch((err) => {
      console.error(`[orderStateMachine] payment email failed: ${err.message}`);
    });
  }

  console.log(`[orderStateMachine] registerPayment DONE (${Date.now() - t0}ms)`);

  return {
    paymentStatus: "paid",
    paidAt: input.paidAt,
    paymentMethod: input.paymentMethod,
    ficInvoiceId,
    ficInvoiceNumber,
  };
}

export interface CancelPaymentInput {
  orderId: string;
  actorUserId: string;
  reason: string;
}

export async function cancelPayment(input: CancelPaymentInput): Promise<{ paymentStatus: PaymentStatus }> {
  const t0 = Date.now();
  console.log(`[orderStateMachine] cancelPayment orderId=${input.orderId}`);

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  const [order] = await db
    .select({
      id: orders.id,
      paymentStatus: orders.paymentStatus,
      orderNumber: orders.orderNumber,
      notesInternal: orders.notesInternal,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);

  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

  if (order.paymentStatus !== "paid") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Pagamento non annullabile (stato: ${order.paymentStatus})` });
  }

  const existingNotes = order.notesInternal ?? "";
  const newNotes = existingNotes
    ? `${existingNotes}\n[Annullo pagamento] ${input.reason}`
    : `[Annullo pagamento] ${input.reason}`;

  await db.update(orders).set({
    paymentStatus: "unpaid",
    paidAt: null,
    paymentMethod: null,
    notesInternal: newNotes,
    updatedAt: new Date(),
  }).where(eq(orders.id, input.orderId));

  // Void commission
  try {
    const { voidCommissionForOrder } = await import("./commissionService");
    await voidCommissionForOrder(input.orderId, `Pagamento annullato: ${input.reason}`);
  } catch (e: any) {
    console.error(`[orderStateMachine] commission void on cancelPayment failed: ${e.message}`);
  }

  console.log(`[orderStateMachine] cancelPayment DONE (${Date.now() - t0}ms)`);
  return { paymentStatus: "unpaid" };
}

// --- Modify order items (full replacement: add/remove/update) ---

export interface ModifyOrderItemsInput {
  orderId: string;
  actorUserId: string;
  /** New items list — replaces all existing items */
  items: Array<{
    productId: string;
    quantity: number;
  }>;
}

export interface ModifyOrderItemsResult {
  success: boolean;
  totalGross: string;
  warnings: string[];
  ficUpdated: boolean;
  commissionRecalculated: boolean;
}

/**
 * Unified modify order items — supports pending status only now.
 * Does a full delete+re-insert with recalculated pricing.
 * NO stock check (backorder allowed — stock is checked only at transfer time).
 */
export async function modifyOrderItems(input: ModifyOrderItemsInput): Promise<ModifyOrderItemsResult> {
  const t0 = Date.now();
  console.log(`[orderStateMachine.modifyOrderItems] start orderId=${input.orderId}`);

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  // 1. Load order, verify status
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentTerms: orders.paymentTerms,
      retailerId: orders.retailerId,
      eventType: orders.eventType,
      orderNumber: orders.orderNumber,
      ficProformaId: orders.ficProformaId,
      notesInternal: orders.notesInternal,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);

  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

  const isEventOrder = !!order.eventType;

  // M6.2.G: items can be modified only in pending status
  const allowedStatuses = ["pending"];
  if (!allowedStatuses.includes(order.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Modifica consentita solo per ordini in stato 'pending'. Stato attuale: ${order.status}`,
    });
  }

  if (!order.retailerId && !isEventOrder) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Ordine senza retailer né evento non modificabile" });
  }

  if (input.items.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Almeno un item richiesto" });
  }

  // 2. Recalculate pricing (M11.A.markup: read markupPercentageOverride from order)
  let pricing;
  if (isEventOrder) {
    const { calculateEventOrderPricing } = await import("../pricing");
    pricing = await calculateEventOrderPricing(input.items);
  } else {
    const { calculateOrderPricing } = await import("../pricing");
    // Read existing markupPercentageOverride from the order row
    const [orderForMarkup] = await db
      .select({ markupPercentageOverride: orders.markupPercentageOverride })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    const markupOverride = orderForMarkup?.markupPercentageOverride
      ? parseFloat(orderForMarkup.markupPercentageOverride)
      : undefined;
    pricing = await calculateOrderPricing({
      retailerId: order.retailerId!,
      items: input.items,
      markupPercentageOverride: markupOverride,
    });
  }

  // 3. Transaction: diff strategy — preserve batchId on existing items
  await db.transaction(async (tx) => {
    const existingItems = await tx
      .select({ id: orderItems.id, productId: orderItems.productId, batchId: orderItems.batchId })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId));

    const existingByProduct = new Map<string, typeof existingItems[0]>();
    for (const ei of existingItems) {
      existingByProduct.set(ei.productId, ei);
    }

    const matchedExistingIds = new Set<string>();

    for (const pi of pricing.items) {
      const existing = existingByProduct.get(pi.productId);

      if (existing) {
        matchedExistingIds.add(existing.id);
        await tx
          .update(orderItems)
          .set({
            quantity: pi.quantity,
            unitPriceBase: pi.unitPriceBase,
            discountPercent: pi.discountPercent,
            unitPriceFinal: pi.unitPriceFinal,
            vatRate: pi.vatRate,
            lineTotalNet: pi.lineTotalNet,
            lineTotalGross: pi.lineTotalGross,
            productSku: pi.productSku,
            productName: pi.productName,
          })
          .where(eq(orderItems.id, existing.id));
      } else {
        await tx.insert(orderItems).values({
          orderId: input.orderId,
          productId: pi.productId,
          quantity: pi.quantity,
          unitPriceBase: pi.unitPriceBase,
          discountPercent: pi.discountPercent,
          unitPriceFinal: pi.unitPriceFinal,
          vatRate: pi.vatRate,
          lineTotalNet: pi.lineTotalNet,
          lineTotalGross: pi.lineTotalGross,
          productSku: pi.productSku,
          productName: pi.productName,
          batchId: null,
        });
      }
    }

    const removedItems = existingItems.filter((ei) => !matchedExistingIds.has(ei.id));
    for (const removed of removedItems) {
      await tx.delete(orderItems).where(eq(orderItems.id, removed.id));
    }

    await tx
      .update(orders)
      .set({
        subtotalNet: pricing.subtotalNet,
        vatAmount: pricing.vatAmount,
        totalGross: pricing.totalGross,
        discountPercent: pricing.discountPercent,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, input.orderId));
  });

  let ficUpdated = false;
  let commissionRecalculated = false;

  // 4. Update FiC proforma if exists (SOLO ordini retailer)
  if (!isEventOrder && order.ficProformaId && order.retailerId) {
    const [retailer] = await db
      .select({ ficClientId: retailers.ficClientId })
      .from(retailers)
      .where(eq(retailers.id, order.retailerId))
      .limit(1);

    if (retailer?.ficClientId) {
      const updatedItems = await db
        .select({
          productName: orderItems.productName,
          productSku: orderItems.productSku,
          quantity: orderItems.quantity,
          unitPriceFinal: orderItems.unitPriceFinal,
          vatRate: orderItems.vatRate,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
        })
        .from(orderItems)
        .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
        .where(eq(orderItems.orderId, input.orderId));

      try {
        await ficDocService.modifyProforma(order.ficProformaId, {
          orderId: input.orderId,
          orderNumber: order.orderNumber ?? "",
          retailerFicClientId: retailer.ficClientId,
          items: updatedItems.map((it) => ({
            productName: it.productName,
            quantity: it.quantity,
            unitPrice: parseFloat(it.unitPriceFinal),
            vatRate: parseFloat(it.vatRate),
            batchNumber: it.batchNumber ?? undefined,
            expiryDate: it.expirationDate ?? undefined,
            sku: it.productSku ?? undefined,
          })),
          paymentTerms: order.paymentTerms as PaymentTerms,
          totalGross: parseFloat(pricing.totalGross),
          notes: order.notesInternal ?? undefined,
        });
        ficUpdated = true;
      } catch (e: any) {
        console.error(`[orderStateMachine.modifyOrderItems] FiC modify failed: ${e.message}`);
      }
    }
  }

  // 5. Send notification email (SOLO ordini retailer)
  if (!isEventOrder && order.retailerId) {
    sendOrderStatusEmail({
      orderId: input.orderId,
      orderNumber: order.orderNumber ?? "",
      retailerId: order.retailerId,
      newStatus: "modified" as any,
      previousStatus: order.status as OrderStatus,
    }).catch((err) => {
      console.error(`[orderStateMachine.modifyOrderItems] email failed: ${err.message}`);
    });
  }

  console.log(
    `[orderStateMachine.modifyOrderItems] DONE (${Date.now() - t0}ms)`,
  );

  return {
    success: true,
    totalGross: pricing.totalGross,
    warnings: pricing.warnings,
    ficUpdated,
    commissionRecalculated,
  };
}

// Legacy alias — kept for backward compatibility
export type ModifyPaidOrderInput = ModifyOrderItemsInput;
export async function modifyPaidOrder(input: ModifyPaidOrderInput): Promise<void> {
  await modifyOrderItems(input);
}
