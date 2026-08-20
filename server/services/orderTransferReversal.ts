import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  inventoryByBatch,
  locations,
  orderItems,
  orders,
  products,
  stockMovements,
} from "../../drizzle/schema";

export const ORDER_TRANSFER_SOURCE_TYPE = "order_transfer";
export const ORDER_CANCELLATION_REVERSAL_SOURCE_TYPE = "order_cancellation_reversal";

export type ReversalLine = {
  batchId: string;
  productId: string;
  requestedPieces: number;
  reversedPieces: number;
  missingPieces: number;
};

export type BatchAllocationInput = {
  batchId: string | null;
  productId: string;
  quantity: number;
  piecesPerUnit: number | null;
};

export function aggregateOrderBatchPieces(items: BatchAllocationInput[]) {
  const byBatch = new Map<string, { productId: string; requestedPieces: number }>();
  for (const item of items) {
    if (!item.batchId) continue;
    const requestedPieces = item.quantity * (item.piecesPerUnit ?? 1);
    const existing = byBatch.get(item.batchId);
    if (existing) existing.requestedPieces += requestedPieces;
    else byBatch.set(item.batchId, { productId: item.productId, requestedPieces });
  }
  return Array.from(byBatch.entries());
}

export function calculatePartialReversal(requestedPieces: number, availablePieces: number) {
  const reversedPieces = Math.min(Math.max(availablePieces, 0), requestedPieces);
  return { reversedPieces, missingPieces: requestedPieces - reversedPieces };
}

export function shouldReverseTransferredOrder(status: string, reversalAlreadyRecorded: boolean) {
  return status === "transferring" && !reversalAlreadyRecorded;
}

export type CancelledOrderWithReversal = {
  orderId: string;
  orderNumber: string;
  retailerId: string | null;
  companyId: string;
  previousStatus: "pending" | "transferring" | "cancelled";
  ficProformaId: number | null;
  reversalAlreadyRecorded: boolean;
  reversalLines: ReversalLine[];
};

/**
 * Cancels an order under a row lock. For transferred retailer orders it also
 * performs the reverse transfer retailer → central warehouse in the same
 * database transaction. The order row lock serializes concurrent cancellations.
 */
export async function cancelOrderWithTransferReversal(input: {
  orderId: string;
  actorUserId: string;
  reason?: string;
}): Promise<CancelledOrderWithReversal> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  return db.transaction(async (tx) => {
    // MUST be the first data operation: this serializes two concurrent cancellation attempts.
    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        retailerId: orders.retailerId,
        companyId: orders.companyId,
        ficProformaId: orders.ficProformaId,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update")
      .limit(1);

    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
    if (order.status === "cancelled") {
      const [existingReversal] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.sourceDocumentType, ORDER_CANCELLATION_REVERSAL_SOURCE_TYPE),
            eq(stockMovements.sourceDocument, order.id),
          ),
        )
        .limit(1);
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        retailerId: order.retailerId,
        companyId: order.companyId,
        previousStatus: "cancelled",
        ficProformaId: order.ficProformaId,
        reversalAlreadyRecorded: Boolean(existingReversal),
        reversalLines: [],
      };
    }
    if (order.status !== "pending" && order.status !== "transferring") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Solo ordini pending o transferring possono essere annullati (stato attuale: ${order.status})`,
      });
    }

    const previousStatus = order.status;
    const reversalLines: ReversalLine[] = [];
    let reversalAlreadyRecorded = false;

    if (previousStatus === "transferring" && order.retailerId) {
      const [existingReversal] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.sourceDocumentType, ORDER_CANCELLATION_REVERSAL_SOURCE_TYPE),
            eq(stockMovements.sourceDocument, order.id),
          ),
        )
        .limit(1);

      if (existingReversal) {
        reversalAlreadyRecorded = true;
      } else {
        const [centralWarehouse] = await tx
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.type, "central_warehouse"), eq(locations.companyId, order.companyId)))
          .limit(1);
        const [retailerLocation] = await tx
          .select({ id: locations.id })
          .from(locations)
          .where(
            and(
              eq(locations.type, "retailer"),
              eq(locations.retailerId, order.retailerId),
              eq(locations.companyId, order.companyId),
            ),
          )
          .limit(1);

        if (!centralWarehouse || !retailerLocation) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Impossibile stornare: magazzino centrale o location rivenditore non configurati",
          });
        }

        // Order rows can already be split by FEFO. Aggregate before touching inventory,
        // therefore each batch produces one and only one reverse-transfer movement.
        const itemRows = await tx
          .select({
            batchId: orderItems.batchId,
            productId: orderItems.productId,
            quantity: orderItems.quantity,
            piecesPerUnit: products.piecesPerUnit,
          })
          .from(orderItems)
          .leftJoin(products, eq(orderItems.productId, products.id))
          .where(eq(orderItems.orderId, order.id));

        const allocations = aggregateOrderBatchPieces(itemRows);

        for (const [batchId, requested] of allocations) {
          const retailerRows = await tx
            .select({ id: inventoryByBatch.id, quantity: inventoryByBatch.quantity })
            .from(inventoryByBatch)
            .where(and(eq(inventoryByBatch.locationId, retailerLocation.id), eq(inventoryByBatch.batchId, batchId)))
            .for("update");
          const retailerStock = retailerRows[0];
          const availablePieces = retailerStock?.quantity ?? 0;
          const { reversedPieces, missingPieces } = calculatePartialReversal(
            requested.requestedPieces,
            availablePieces,
          );

          const centralRows = await tx
            .select({ id: inventoryByBatch.id, quantity: inventoryByBatch.quantity })
            .from(inventoryByBatch)
            .where(and(eq(inventoryByBatch.locationId, centralWarehouse.id), eq(inventoryByBatch.batchId, batchId)))
            .for("update");
          const centralStock = centralRows[0];

          if (retailerStock && reversedPieces > 0) {
            await tx
              .update(inventoryByBatch)
              .set({ quantity: availablePieces - reversedPieces, updatedAt: new Date() })
              .where(eq(inventoryByBatch.id, retailerStock.id));
          }

          if (reversedPieces > 0) {
            if (centralStock) {
              await tx
                .update(inventoryByBatch)
                .set({ quantity: centralStock.quantity + reversedPieces, updatedAt: new Date() })
                .where(eq(inventoryByBatch.id, centralStock.id));
            } else {
              await tx.insert(inventoryByBatch).values({
                locationId: centralWarehouse.id,
                batchId,
                quantity: reversedPieces,
                companyId: order.companyId,
              });
            }
          }

          const discrepancy = missingPieces > 0
            ? ` Discrepanza: richiesti ${requested.requestedPieces} pz, disponibili presso rivenditore ${availablePieces} pz, stornati ${reversedPieces} pz, mancanti ${missingPieces} pz.`
            : "";
          await tx.insert(stockMovements).values({
            productId: requested.productId,
            type: "TRANSFER",
            quantity: reversedPieces,
            previousQuantity: availablePieces,
            newQuantity: availablePieces - reversedPieces,
            sourceDocumentType: ORDER_CANCELLATION_REVERSAL_SOURCE_TYPE,
            sourceDocument: order.id,
            notes: `Storno ordine ${order.orderNumber} annullato.${discrepancy}`,
            notesInternal: `reversal_of_order:${order.id}:batch:${batchId}; requested=${requested.requestedPieces}; available=${availablePieces}; reversed=${reversedPieces}; missing=${missingPieces}`,
            batchId,
            fromLocationId: retailerLocation.id,
            toLocationId: centralWarehouse.id,
            createdBy: input.actorUserId,
            companyId: order.companyId,
          });

          reversalLines.push({
            batchId,
            productId: requested.productId,
            requestedPieces: requested.requestedPieces,
            reversedPieces,
            missingPieces,
          });
        }
      }
    }

    await tx
      .update(orders)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledReason: input.reason ?? null,
        ficProformaId: null,
        ficProformaNumber: null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      retailerId: order.retailerId,
      companyId: order.companyId,
      previousStatus,
      ficProformaId: order.ficProformaId,
      reversalAlreadyRecorded,
      reversalLines,
    };
  });
}
