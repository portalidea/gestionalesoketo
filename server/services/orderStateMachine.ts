/**
 * M6.2.B — Order State Machine Service
 *
 * Centralizes all order status transitions with:
 * - State validation (canTransition)
 * - Payment terms compatibility checks
 * - Side effects (FiC document lifecycle, stock, email)
 * - Audit logging
 *
 * All transitions go through transitionOrder(). No direct UPDATE on orders.status
 * should happen outside this module.
 */
import { TRPCError } from "@trpc/server";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import { orders, orderItems, retailers, products, productBatches } from "../../drizzle/schema";
import * as ficDocService from "./ficDocumentService";
import { sendOrderStatusEmail } from "./orderEmailService";

// --- Types ---

export type OrderStatus =
  | "pending"
  | "paid"
  | "approved_for_shipping"
  | "transferring"
  | "shipped"
  | "delivered"
  | "paid_on_delivery"
  | "cancelled";

export type PaymentTerms = "advance_transfer" | "on_delivery" | "credit_card" | "manual";

// --- State Machine Definition ---

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "approved_for_shipping", "cancelled"],
  paid: ["transferring", "cancelled"],
  approved_for_shipping: ["transferring", "cancelled"],
  transferring: ["shipped"],
  shipped: ["delivered"],
  delivered: ["paid_on_delivery"],
  paid_on_delivery: [],
  cancelled: [],
};

// Payment terms constraints
const PAYMENT_TERMS_CONSTRAINTS: Partial<Record<OrderStatus, PaymentTerms[]>> = {
  paid: ["advance_transfer", "credit_card", "manual"],
  approved_for_shipping: ["on_delivery"],
  paid_on_delivery: ["on_delivery"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// --- Timestamp mapping ---

const TIMESTAMP_MAP: Partial<Record<OrderStatus, string>> = {
  paid: "paidAt",
  approved_for_shipping: "approvedForShippingAt",
  transferring: "transferringAt",
  shipped: "shippedAt",
  delivered: "deliveredAt",
  paid_on_delivery: "paidAt", // reuse paidAt for on_delivery final payment
  cancelled: "cancelledAt",
};

// --- Main transition function ---

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

  // 2. Validate transition
  if (!canTransition(currentStatus, toStatus)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Transizione non valida: ${currentStatus} → ${toStatus}. Consentite: ${VALID_TRANSITIONS[currentStatus]?.join(", ") || "nessuna"}`,
    });
  }

  // 3. Validate payment terms compatibility
  const allowedTerms = PAYMENT_TERMS_CONSTRAINTS[toStatus];
  if (allowedTerms && !allowedTerms.includes(paymentTerms)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Transizione ${currentStatus} → ${toStatus} non consentita per payment_terms='${paymentTerms}'. Richiesto: ${allowedTerms.join(" o ")}`,
    });
  }

  // 4. Execute side effects
  let ficProformaId = order.ficProformaId;
  let ficProformaNumber = order.ficProformaNumber;
  let ficInvoiceId: number | undefined;
  let ficInvoiceNumber: string | undefined;

  const transitionKey = `${currentStatus}→${toStatus}`;

  switch (transitionKey) {
    case "pending→paid":
    case "pending→approved_for_shipping": {
      // Create proforma on FiC
      const [retailer] = await db
        .select({ ficClientId: retailers.ficClientId, name: retailers.name })
        .from(retailers)
        .where(eq(retailers.id, order.retailerId))
        .limit(1);

      if (!retailer?.ficClientId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Retailer non ha ficClientId — configura prima l'anagrafica FiC",
        });
      }

      // Load order items with batch info
      const items = await db
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

      const proforma = await ficDocService.createProforma({
        orderId,
        orderNumber: order.orderNumber ?? "",
        retailerFicClientId: retailer.ficClientId,
        items: items.map((it) => ({
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
      break;
    }

    case "paid→transferring":
    case "approved_for_shipping→transferring": {
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
      // NOTE: actual stock decrement + TRANSFER movement creation is handled
      // by the calling procedure (orders-router.ts transfer logic).
      // The state machine only validates and transitions.
      break;
    }

    case "shipped→delivered": {
      // DECISIONE-1: Transform proforma → invoice ONLY for advance_transfer/credit_card/manual
      // For on_delivery, transform happens at delivered→paid_on_delivery (incasso effettivo)
      if (ficProformaId && paymentTerms !== "on_delivery") {
        try {
          const invoice = await ficDocService.transformProformaToInvoice(ficProformaId);
          ficInvoiceId = invoice.ficInvoiceId;
          ficInvoiceNumber = invoice.ficInvoiceNumber;
        } catch (e: any) {
          console.error(`[orderStateMachine] transformToInvoice failed: ${e.message}`);
          // Don't block the transition, but log the failure
          // Admin can manually transform later
        }
      }
      break;
    }

    case "delivered→paid_on_delivery": {
      // DECISIONE-1: For on_delivery, transform proforma → invoice at payment confirmation
      if (ficProformaId) {
        try {
          const invoice = await ficDocService.transformProformaToInvoice(ficProformaId);
          ficInvoiceId = invoice.ficInvoiceId;
          ficInvoiceNumber = invoice.ficInvoiceNumber;
        } catch (e: any) {
          console.error(`[orderStateMachine] transformToInvoice (on_delivery) failed: ${e.message}`);
          // Don't block the transition
        }
      }
      break;
    }

    case "pending→cancelled": {
      // No proforma to cancel (pending has no proforma)
      break;
    }

    case "paid→cancelled":
    case "approved_for_shipping→cancelled": {
      // Delete proforma from FiC
      if (ficProformaId) {
        try {
          await ficDocService.deleteProforma(ficProformaId);
        } catch (e: any) {
          console.error(`[orderStateMachine] deleteProforma failed: ${e.message}`);
          // Don't block cancellation
        }
      }
      break;
    }
  }

  // 5. Update order status + timestamps
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
    // Clear proforma reference on cancel
    if (ficProformaId) {
      updateData.ficProformaId = null;
      updateData.ficProformaNumber = null;
    }
  }

  await db.update(orders).set(updateData).where(eq(orders.id, orderId));

  // 6. Send email notification (async, don't block)
  sendOrderStatusEmail({
    orderId,
    orderNumber: order.orderNumber ?? "",
    retailerId: order.retailerId,
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

// --- Modify paid order ---

export interface ModifyPaidOrderInput {
  orderId: string;
  actorUserId: string;
  items: Array<{
    orderItemId: string;
    quantity: number;
  }>;
}

export async function modifyPaidOrder(input: ModifyPaidOrderInput): Promise<void> {
  const t0 = Date.now();
  console.log(`[orderStateMachine.modifyPaidOrder] start orderId=${input.orderId}`);

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  // 1. Load order, verify status
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentTerms: orders.paymentTerms,
      retailerId: orders.retailerId,
      orderNumber: orders.orderNumber,
      ficProformaId: orders.ficProformaId,
      notesInternal: orders.notesInternal,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);

  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

  if (order.status !== "paid" && order.status !== "approved_for_shipping") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Modifica consentita solo per ordini in stato 'paid' o 'approved_for_shipping'. Stato attuale: ${order.status}`,
    });
  }

  // 2. Update order items quantities
  for (const item of input.items) {
    if (item.quantity <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Quantità deve essere > 0 per item ${item.orderItemId}`,
      });
    }

    // Recalculate line totals
    const [existingItem] = await db
      .select({
        unitPriceFinal: orderItems.unitPriceFinal,
        vatRate: orderItems.vatRate,
      })
      .from(orderItems)
      .where(eq(orderItems.id, item.orderItemId))
      .limit(1);

    if (!existingItem) continue;

    const unitPrice = parseFloat(existingItem.unitPriceFinal);
    const vatRate = parseFloat(existingItem.vatRate);
    const lineTotalNet = unitPrice * item.quantity;
    const lineTotalGross = lineTotalNet * (1 + vatRate / 100);

    await db
      .update(orderItems)
      .set({
        quantity: item.quantity,
        lineTotalNet: lineTotalNet.toFixed(2),
        lineTotalGross: lineTotalGross.toFixed(2),
      })
      .where(eq(orderItems.id, item.orderItemId));
  }

  // 3. Recalculate order totals
  const allItems = await db
    .select({
      lineTotalNet: orderItems.lineTotalNet,
      lineTotalGross: orderItems.lineTotalGross,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, input.orderId));

  const subtotalNet = allItems.reduce((sum, it) => sum + parseFloat(it.lineTotalNet), 0);
  const totalGross = allItems.reduce((sum, it) => sum + parseFloat(it.lineTotalGross), 0);
  const vatAmount = totalGross - subtotalNet;

  await db
    .update(orders)
    .set({
      subtotalNet: subtotalNet.toFixed(2),
      vatAmount: vatAmount.toFixed(2),
      totalGross: totalGross.toFixed(2),
      updatedAt: new Date(),
    })
    .where(eq(orders.id, input.orderId));

  // 4. Modify proforma on FiC if exists
  if (order.ficProformaId) {
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
          totalGross,
          notes: order.notesInternal ?? undefined,
        });
      } catch (e: any) {
        console.error(`[orderStateMachine.modifyPaidOrder] FiC modify failed: ${e.message}`);
        // Don't block the modification, log for manual fix
      }
    }
  }

  // 5. Send notification email
  sendOrderStatusEmail({
    orderId: input.orderId,
    orderNumber: order.orderNumber ?? "",
    retailerId: order.retailerId,
    newStatus: "modified" as any,
    previousStatus: order.status as OrderStatus,
  }).catch((err) => {
    console.error(`[orderStateMachine.modifyPaidOrder] email failed: ${err.message}`);
  });

  console.log(
    `[orderStateMachine.modifyPaidOrder] DONE (${Date.now() - t0}ms)`,
  );
}
