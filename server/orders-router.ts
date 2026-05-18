/**
 * M6.2.A — Orders Router (Admin)
 *
 * 7 procedure:
 * 1. orders.list — lista ordini con filtri (status, retailer, date range)
 * 2. orders.getById — dettaglio ordine con items
 * 3. orders.preview — calcola pricing senza creare ordine
 * 4. orders.create — crea ordine con items (snapshot pricing)
 * 5. orders.updateItems — modifica items ordine pending
 * 6. orders.updateStatus — transizione status con validazione FSM
 * 7. orders.generateProforma — genera proforma FiC e salva riferimento
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { staffProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  orders,
  orderItems,
  retailers,
  products,
  productBatches,
  inventoryByBatch,
  locations,
} from "../drizzle/schema";
import { eq, desc, and, gte, lte, sql, inArray, asc, gt } from "drizzle-orm";
import { calculateOrderPricing, calculateEventOrderPricing, type PricingItemInput } from "./pricing";
import { createFicProforma } from "./fic-integration";
import { transitionOrder, modifyPaidOrder, type OrderStatus } from "./services/orderStateMachine";
import { getAvailableStock } from "./services/stockService";

// --- Zod Schemas ---

const orderItemInput = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

const statusEnum = z.enum([
  "pending",
  "paid",
  "approved_for_shipping",
  "transferring",
  "shipped",
  "delivered",
  "paid_on_delivery",
  "cancelled",
]);

// FSM: actual state machine is in server/services/orderStateMachine.ts
// Legacy updateStatus procedure removed — all transitions go through transitionOrder()

// --- Router ---

export const ordersRouter = router({
  /**
   * 1. Lista ordini con filtri
   */
  list: staffProcedure
    .input(
      z.object({
        status: statusEnum.optional(),
        retailerId: z.string().uuid().optional(),
        orderType: z.enum(["retailer", "event"]).optional(),
        dateFrom: z.string().optional(), // ISO date
        dateTo: z.string().optional(), // ISO date
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
      const conditions: any[] = [];

      if (input.status) {
        conditions.push(eq(orders.status, input.status));
      }
      if (input.retailerId) {
        conditions.push(eq(orders.retailerId, input.retailerId));
      }
      if (input.orderType === "event") {
        conditions.push(sql`${orders.eventType} IS NOT NULL`);
      } else if (input.orderType === "retailer") {
        conditions.push(sql`${orders.eventType} IS NULL`);
      }
      if (input.dateFrom) {
        conditions.push(gte(orders.createdAt, new Date(input.dateFrom)));
      }
      if (input.dateTo) {
        conditions.push(lte(orders.createdAt, new Date(input.dateTo)));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countResult] = await Promise.all([
        db
          .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            retailerId: orders.retailerId,
            retailerName: retailers.name,
            status: orders.status,
            subtotalNet: orders.subtotalNet,
            vatAmount: orders.vatAmount,
            totalGross: orders.totalGross,
            discountPercent: orders.discountPercent,
            ficProformaNumber: orders.ficProformaNumber,
            eventType: orders.eventType,
            eventName: orders.eventName,
            createdAt: orders.createdAt,
            updatedAt: orders.updatedAt,
            hasUnassignedBatch: sql<boolean>`EXISTS (
              SELECT 1 FROM "orderItems" oi
              WHERE oi."orderId" = ${orders.id} AND oi."batchId" IS NULL
            )`.as("hasUnassignedBatch"),
          })
          .from(orders)
          .leftJoin(retailers, eq(orders.retailerId, retailers.id))
          .where(whereClause)
          .orderBy(desc(orders.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(whereClause),
      ]);

      return {
        orders: rows,
        total: countResult[0]?.count ?? 0,
      };
    }),

  /**
   * 2. Dettaglio ordine con items
   */
  getById: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [order] = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          retailerId: orders.retailerId,
          retailerName: retailers.name,
          status: orders.status,
          subtotalNet: orders.subtotalNet,
          vatAmount: orders.vatAmount,
          totalGross: orders.totalGross,
          discountPercent: orders.discountPercent,
          notes: orders.notes,
          notesInternal: orders.notesInternal,
          ficProformaId: orders.ficProformaId,
          ficProformaNumber: orders.ficProformaNumber,
          ficInvoiceId: orders.ficInvoiceId,
          ficInvoiceNumber: orders.ficInvoiceNumber,
          paymentTerms: orders.paymentTerms,
          paidAt: orders.paidAt,
          approvedForShippingAt: orders.approvedForShippingAt,
          transferringAt: orders.transferringAt,
          shippedAt: orders.shippedAt,
          deliveredAt: orders.deliveredAt,
          cancelledAt: orders.cancelledAt,
          cancelledReason: orders.cancelledReason,
          eventType: orders.eventType,
          eventName: orders.eventName,
          eventDate: orders.eventDate,
          fiscalReceiptRef: orders.fiscalReceiptRef,
          createdBy: orders.createdBy,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .leftJoin(retailers, eq(orders.retailerId, retailers.id))
        .where(eq(orders.id, input.id))
        .limit(1);

      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      }

       const items = await db
        .select({
          id: orderItems.id,
          orderId: orderItems.orderId,
          productId: orderItems.productId,
          batchId: orderItems.batchId,
          quantity: orderItems.quantity,
          unitPriceBase: orderItems.unitPriceBase,
          discountPercent: orderItems.discountPercent,
          unitPriceFinal: orderItems.unitPriceFinal,
          vatRate: orderItems.vatRate,
          lineTotalNet: orderItems.lineTotalNet,
          lineTotalGross: orderItems.lineTotalGross,
          productSku: orderItems.productSku,
          productName: orderItems.productName,
          createdAt: orderItems.createdAt,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
        })
        .from(orderItems)
        .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
        .where(eq(orderItems.orderId, input.id))
        .orderBy(orderItems.createdAt);
      return { ...order, items };
    }),

  /**
   * 3. Preview pricing (senza creare ordine)
   */
  preview: staffProcedure
    .input(
      z.object({
        retailerId: z.string().uuid(),
        items: z.array(orderItemInput).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      return calculateOrderPricing(input.retailerId, input.items);
    }),

  /**
   * 4. Crea ordine con items (snapshot pricing)
   */
  create: staffProcedure
    .input(
      z.object({
        retailerId: z.string().uuid(),
        items: z.array(orderItemInput).min(1),
        notes: z.string().optional(),
        notesInternal: z.string().optional(),
        paymentTerms: z.enum(['advance_transfer', 'on_delivery', 'credit_card', 'manual']).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // BUG-1 FIX: Resolve paymentTerms with fallback chain
      // input.paymentTerms ?? retailer.paymentTerms ?? 'advance_transfer'
      const [retailerForPT] = await db
        .select({ paymentTerms: retailers.paymentTerms })
        .from(retailers)
        .where(eq(retailers.id, input.retailerId))
        .limit(1);
      const resolvedPaymentTerms = input.paymentTerms ?? retailerForPT?.paymentTerms ?? 'advance_transfer';

      // Calcola pricing
      const pricing = await calculateOrderPricing(input.retailerId, input.items);

      // --- Auto-assegnazione FEFO lotti ---
      // Trova magazzino centrale
      const [warehouse] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.type, "central_warehouse"))
        .limit(1);

      // Per ogni item, alloca lotti FEFO dal magazzino centrale
      type BatchAllocation = {
        productId: string;
        batchId: string;
        quantity: number; // in confezioni
        batchNumber: string;
        expirationDate: string;
      };
      const allAllocations: (typeof pricing.items[0] & { allocations: BatchAllocation[] })[] = [];
      const fefoWarnings: string[] = [];

      for (const pi of pricing.items) {
        const allocations: BatchAllocation[] = [];
        let remaining = pi.quantity; // in confezioni

        if (warehouse) {
          // Query lotti disponibili FEFO per questo prodotto nel magazzino centrale
          const availableBatches = await db
            .select({
              batchId: productBatches.id,
              batchNumber: productBatches.batchNumber,
              expirationDate: productBatches.expirationDate,
              centralStock: inventoryByBatch.quantity,
            })
            .from(productBatches)
            .innerJoin(
              inventoryByBatch,
              and(
                eq(inventoryByBatch.batchId, productBatches.id),
                eq(inventoryByBatch.locationId, warehouse.id),
              ),
            )
            .where(
              and(
                eq(productBatches.productId, pi.productId),
                gt(inventoryByBatch.quantity, 0),
              ),
            )
            .orderBy(asc(productBatches.expirationDate));

          // Greedy FEFO allocation
          for (const batch of availableBatches) {
            if (remaining <= 0) break;
            const allocQty = Math.min(remaining, batch.centralStock);
            allocations.push({
              productId: pi.productId,
              batchId: batch.batchId,
              quantity: allocQty,
              batchNumber: batch.batchNumber,
              expirationDate: batch.expirationDate,
            });
            remaining -= allocQty;
          }
        }

        if (remaining > 0) {
          fefoWarnings.push(
            `${pi.productSku}: stock insufficiente per ${remaining} conf. su ${pi.quantity} richieste — ${remaining} senza lotto`,
          );
        }

        allAllocations.push({ ...pi, allocations });
      }

      // Crea ordine in transazione
      const result = await db.transaction(async (tx) => {
        // Insert order
        const [order] = await tx
          .insert(orders)
          .values({
            retailerId: input.retailerId,
            status: "pending",
            paymentTerms: resolvedPaymentTerms,
            subtotalNet: pricing.subtotalNet,
            vatAmount: pricing.vatAmount,
            totalGross: pricing.totalGross,
            discountPercent: pricing.discountPercent,
            notes: input.notes ?? null,
            notesInternal: input.notesInternal ?? null,
            createdBy: ctx.user.id,
          })
          .returning();

        // Insert items con snapshot + batch FEFO
        const itemValues: Array<{
          orderId: string;
          productId: string;
          quantity: number;
          unitPriceBase: string;
          discountPercent: string;
          unitPriceFinal: string;
          vatRate: string;
          lineTotalNet: string;
          lineTotalGross: string;
          productSku: string;
          productName: string;
          batchId: string | null;
        }> = [];

        for (const pi of allAllocations) {
          if (pi.allocations.length === 0) {
            // Nessun lotto disponibile — item senza batch
            itemValues.push({
              orderId: order.id,
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
          } else {
            // Split item per lotto (ricalcola lineTotals proporzionalmente)
            for (const alloc of pi.allocations) {
              const ratio = alloc.quantity / pi.quantity;
              const lineNet = (parseFloat(pi.lineTotalNet) * ratio).toFixed(2);
              const lineGross = (parseFloat(pi.lineTotalGross) * ratio).toFixed(2);
              itemValues.push({
                orderId: order.id,
                productId: pi.productId,
                quantity: alloc.quantity,
                unitPriceBase: pi.unitPriceBase,
                discountPercent: pi.discountPercent,
                unitPriceFinal: pi.unitPriceFinal,
                vatRate: pi.vatRate,
                lineTotalNet: lineNet,
                lineTotalGross: lineGross,
                productSku: pi.productSku,
                productName: pi.productName,
                batchId: alloc.batchId,
              });
            }
            // Se c'è un residuo senza lotto (stock insufficiente)
            const allocatedTotal = pi.allocations.reduce((s, a) => s + a.quantity, 0);
            const unallocated = pi.quantity - allocatedTotal;
            if (unallocated > 0) {
              const ratio = unallocated / pi.quantity;
              const lineNet = (parseFloat(pi.lineTotalNet) * ratio).toFixed(2);
              const lineGross = (parseFloat(pi.lineTotalGross) * ratio).toFixed(2);
              itemValues.push({
                orderId: order.id,
                productId: pi.productId,
                quantity: unallocated,
                unitPriceBase: pi.unitPriceBase,
                discountPercent: pi.discountPercent,
                unitPriceFinal: pi.unitPriceFinal,
                vatRate: pi.vatRate,
                lineTotalNet: lineNet,
                lineTotalGross: lineGross,
                productSku: pi.productSku,
                productName: pi.productName,
                batchId: null,
              });
            }
          }
        }

        if (itemValues.length > 0) {
          await tx.insert(orderItems).values(itemValues);
        }

        return order;
      });

      return {
        id: result.id,
        orderNumber: result.orderNumber,
        totalGross: pricing.totalGross,
        warnings: [...pricing.warnings, ...fefoWarnings],
      };
    }),

  /**
   * 5. Modifica items ordine pending
   */
  updateItems: staffProcedure
    .input(
      z.object({
        orderId: z.string().uuid(),
        items: z.array(orderItemInput).min(1),
        notes: z.string().optional(),
        notesInternal: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Verifica ordine pending
      const [order] = await db
        .select({ id: orders.id, status: orders.status, retailerId: orders.retailerId })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (order.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Solo ordini in stato 'pending' possono essere modificati",
        });
      }

      // Ricalcola pricing
      const pricing = await calculateOrderPricing(order.retailerId!, input.items);

      await db.transaction(async (tx) => {
        // Elimina vecchi items
        await tx.delete(orderItems).where(eq(orderItems.orderId, input.orderId));

        // Aggiorna totali ordine
        await tx
          .update(orders)
          .set({
            subtotalNet: pricing.subtotalNet,
            vatAmount: pricing.vatAmount,
            totalGross: pricing.totalGross,
            discountPercent: pricing.discountPercent,
            notes: input.notes ?? null,
            notesInternal: input.notesInternal ?? null,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, input.orderId));

        // Inserisci nuovi items
        const itemValues = pricing.items.map((pi) => ({
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
        }));

        await tx.insert(orderItems).values(itemValues);
      });

      return {
        totalGross: pricing.totalGross,
        warnings: pricing.warnings,
      };
    }),

  // [REMOVED] updateStatus — replaced by specific procedures (confirmPayment, approveForShipping, etc.)
  // All transitions now go through transitionOrder() in orderStateMachine.ts

  /**
   * 7. Genera proforma FiC e salva riferimento
   */
  /**
   * 8. Assegna/rimuovi lotto su un orderItem
   */
  assignBatch: staffProcedure
    .input(
      z.object({
        orderItemId: z.string().uuid(),
        batchId: z.string().uuid().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Verifica orderItem esiste
      const [item] = await db
        .select({
          id: orderItems.id,
          orderId: orderItems.orderId,
          productId: orderItems.productId,
          productName: orderItems.productName,
          batchId: orderItems.batchId,
        })
        .from(orderItems)
        .where(eq(orderItems.id, input.orderItemId))
        .limit(1);

      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item ordine non trovato" });

      // Idempotenza: se batchId è già lo stesso, skip
      if (item.batchId === input.batchId) {
        const existingBatch = input.batchId
          ? await db.select({ batchNumber: productBatches.batchNumber, expirationDate: productBatches.expirationDate }).from(productBatches).where(eq(productBatches.id, input.batchId)).limit(1).then(r => r[0])
          : null;
        return {
          batchId: input.batchId,
          batchNumber: existingBatch?.batchNumber ?? null,
          expirationDate: existingBatch?.expirationDate ?? null,
          ficUpdated: false,
        };
      }

      // Verifica ordine non è in stato finale
      const [order] = await db
        .select({
          status: orders.status,
          ficProformaId: orders.ficProformaId,
          orderNumber: orders.orderNumber,
          retailerId: orders.retailerId,
          paymentTerms: orders.paymentTerms,
          notesInternal: orders.notesInternal,
        })
        .from(orders)
        .where(eq(orders.id, item.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (["delivered", "cancelled"].includes(order.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Non è possibile modificare lotti su un ordine ${order.status}`,
        });
      }

      let batchNumber: string | null = null;
      let expirationDate: string | null = null;

      if (input.batchId) {
        // Verifica batch esiste e appartiene allo stesso prodotto
        const [batch] = await db
          .select({
            id: productBatches.id,
            productId: productBatches.productId,
            batchNumber: productBatches.batchNumber,
            expirationDate: productBatches.expirationDate,
          })
          .from(productBatches)
          .where(eq(productBatches.id, input.batchId))
          .limit(1);

        if (!batch) throw new TRPCError({ code: "NOT_FOUND", message: "Lotto non trovato" });
        if (batch.productId !== item.productId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Il lotto selezionato non appartiene allo stesso prodotto dell'item",
          });
        }

        batchNumber = batch.batchNumber;
        expirationDate = batch.expirationDate;

        await db
          .update(orderItems)
          .set({ batchId: input.batchId })
          .where(eq(orderItems.id, input.orderItemId));
      } else {
        // Rimuovi assegnazione
        await db
          .update(orderItems)
          .set({ batchId: null })
          .where(eq(orderItems.id, input.orderItemId));
      }

      // Update FiC proforma if order is paid/approved_for_shipping and has proforma
      let ficUpdated = false;
      if (
        ["paid", "approved_for_shipping"].includes(order.status) &&
        order.ficProformaId &&
        order.retailerId
      ) {
        try {
          const [retailer] = await db
            .select({ ficClientId: retailers.ficClientId })
            .from(retailers)
            .where(eq(retailers.id, order.retailerId))
            .limit(1);

          if (retailer?.ficClientId) {
            // Reload all items with updated batch info
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
              .where(eq(orderItems.orderId, item.orderId));

            const { modifyProforma } = await import("./services/ficDocumentService");
            await modifyProforma(order.ficProformaId, {
              orderId: item.orderId,
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
              paymentTerms: order.paymentTerms as any,
              notes: order.notesInternal ?? undefined,
            });
            ficUpdated = true;
            console.log(
              `[orders.assignBatch] FiC proforma updated: ficDocId=${order.ficProformaId}, batchId=${input.batchId}, productName=${item.productName}`,
            );
          }
        } catch (e: any) {
          console.error(`[orders.assignBatch] FiC update failed: ${e.message}`);
        }
      }

      console.log(
        `[orders.assignBatch] DONE: orderItemId=${input.orderItemId}, batchId=${input.batchId}, ficUpdated=${ficUpdated}`,
      );

      return { batchId: input.batchId, batchNumber, expirationDate, ficUpdated };
    }),

  /**
   * 9. Lista lotti disponibili per un prodotto (per dropdown assegnazione)
   */
  batchesForProduct: staffProcedure
    .input(z.object({ productId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const batches = await db
        .select({
          id: productBatches.id,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
        })
        .from(productBatches)
        .where(eq(productBatches.productId, input.productId))
        .orderBy(productBatches.expirationDate);

      return batches;
    }),

  /**
   * 9b. List all batches with stock for an order item, with FEFO suggestion flag
   */
  suggestBatchForItem: staffProcedure
    .input(z.object({ orderItemId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Get the order item's product and quantity
      const [item] = await db
        .select({ productId: orderItems.productId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.id, input.orderItemId))
        .limit(1);

      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item non trovato" });

      // Find central warehouse
      const [warehouse] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.type, "central_warehouse"))
        .limit(1);

      if (!warehouse) return { batches: [], requiredQuantity: item.quantity };

      // All batches with stock > 0, ordered FEFO
      const candidates = await db
        .select({
          batchId: productBatches.id,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
          availableQuantity: inventoryByBatch.quantity,
        })
        .from(productBatches)
        .innerJoin(
          inventoryByBatch,
          and(
            eq(inventoryByBatch.batchId, productBatches.id),
            eq(inventoryByBatch.locationId, warehouse.id),
          ),
        )
        .where(
          and(
            eq(productBatches.productId, item.productId),
            gt(inventoryByBatch.quantity, 0),
          ),
        )
        .orderBy(asc(productBatches.expirationDate));

      // FEFO suggestion: first batch with enough stock, or first batch overall
      const fefoId = (candidates.find((c) => c.availableQuantity >= item.quantity) ?? candidates[0])?.batchId ?? null;

      return {
        batches: candidates.map((c) => ({
          batchId: c.batchId,
          batchNumber: c.batchNumber,
          expirationDate: c.expirationDate,
          availableQuantity: c.availableQuantity,
          isFefoSuggested: c.batchId === fefoId,
        })),
        requiredQuantity: item.quantity,
      };
    }),

  /**
   * 10. Genera proforma FiC e salva riferimento
   */
  generateProforma: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Carica ordine + retailer
      const [order] = await db
        .select({
          id: orders.id,
          status: orders.status,
          retailerId: orders.retailerId,
          ficProformaId: orders.ficProformaId,
          orderNumber: orders.orderNumber,
          notesInternal: orders.notesInternal,
          totalGross: orders.totalGross,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (order.ficProformaId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Proforma già generata: ${order.ficProformaId}`,
        });
      }

      // Verifica retailer ha ficClientId
      const [retailer] = await db
        .select({ ficClientId: retailers.ficClientId, name: retailers.name })
        .from(retailers)
        .where(eq(retailers.id, order.retailerId!))
        .limit(1);

      if (!retailer?.ficClientId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Retailer non ha ficClientId associato — configura prima l'anagrafica FiC",
        });
      }

      // Carica items con product description e batch info
      const items = await db
        .select({
          id: orderItems.id,
          productSku: orderItems.productSku,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          unitPriceFinal: orderItems.unitPriceFinal,
          vatRate: orderItems.vatRate,
          batchId: orderItems.batchId,
          productDescription: products.description,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
        })
        .from(orderItems)
        .leftJoin(products, eq(orderItems.productId, products.id))
        .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
        .where(eq(orderItems.orderId, input.orderId));

      if (items.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Ordine senza righe" });
      }

      // Crea proforma su FiC — name (grassetto) + description (lotto/scad, normale)
      const ficItems = items.map((it) => {
        let description = "";
        if (it.batchId && it.batchNumber) {
          const expDate = it.expirationDate
            ? new Date(it.expirationDate).toLocaleDateString("it-IT")
            : "N/D";
          description = `Lotto: ${it.batchNumber} - Scadenza: ${expDate}`;
        }
        return {
          name: it.productName,       // ← solo nome prodotto (grassetto su FiC)
          description,                 // ← lotto + scadenza (testo normale su FiC)
          qty: it.quantity,
          unitPriceFinal: it.unitPriceFinal,
          vatRate: it.vatRate,
        };
      });

      const proforma = await createFicProforma({
        ficClientId: retailer.ficClientId,
        date: new Date().toISOString().split("T")[0],
        orderNumber: order.orderNumber ?? undefined,
        totalGross: order.totalGross ? parseFloat(order.totalGross) : undefined,
        notesInternal: `Ordine ${order.orderNumber}${order.notesInternal ? ` — ${order.notesInternal}` : ""}`,
        items: ficItems,
      });

      // Salva riferimento proforma sull'ordine
      await db
        .update(orders)
        .set({
          ficProformaId: proforma.id,
          ficProformaNumber: proforma.number,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, input.orderId));

      return {
        ficProformaId: proforma.id,
        ficProformaNumber: proforma.number,
      };
    }),

  /**
   * 8. Rigenera proforma FiC (reset + ricrea)
   */
  regenerateProforma: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Reset ficProformaId e ficProformaNumber
      await db
        .update(orders)
        .set({
          ficProformaId: null,
          ficProformaNumber: null,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, input.orderId));

      // Riusa la logica di generateProforma
      // Fetch order
      const [order] = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          retailerId: orders.retailerId,
          totalGross: orders.totalGross,
          notesInternal: orders.notesInternal,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

      // Verifica retailer ha ficClientId
      const [retailer] = await db
        .select({ ficClientId: retailers.ficClientId, name: retailers.name })
        .from(retailers)
        .where(eq(retailers.id, order.retailerId!))
        .limit(1);

      if (!retailer?.ficClientId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Retailer non ha ficClientId associato",
        });
      }

      // Carica items con product description e batch info
      const items = await db
        .select({
          id: orderItems.id,
          productSku: orderItems.productSku,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          unitPriceFinal: orderItems.unitPriceFinal,
          vatRate: orderItems.vatRate,
          batchId: orderItems.batchId,
          productDescription: products.description,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
        })
        .from(orderItems)
        .leftJoin(products, eq(orderItems.productId, products.id))
        .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
        .where(eq(orderItems.orderId, input.orderId));

      if (items.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Ordine senza righe" });
      }

      // Crea proforma su FiC — name (grassetto) + description (lotto/scad, normale)
      const ficItems = items.map((it) => {
        let description = "";
        if (it.batchId && it.batchNumber) {
          const expDate = it.expirationDate
            ? new Date(it.expirationDate).toLocaleDateString("it-IT")
            : "N/D";
          description = `Lotto: ${it.batchNumber} - Scadenza: ${expDate}`;
        }
        return {
          name: it.productName,       // ← solo nome prodotto (grassetto su FiC)
          description,                 // ← lotto + scadenza (testo normale su FiC)
          qty: it.quantity,
          unitPriceFinal: it.unitPriceFinal,
          vatRate: it.vatRate,
        };
      });

      const proforma = await createFicProforma({
        ficClientId: retailer.ficClientId,
        date: new Date().toISOString().split("T")[0],
        orderNumber: order.orderNumber ?? undefined,
        totalGross: order.totalGross ? parseFloat(order.totalGross) : undefined,
        notesInternal: `Ordine ${order.orderNumber} (rigenerata)${order.notesInternal ? ` — ${order.notesInternal}` : ""}`,
        items: ficItems,
      });

      // Salva nuovi riferimenti proforma
      await db
        .update(orders)
        .set({
          ficProformaId: proforma.id,
          ficProformaNumber: proforma.number,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, input.orderId));

      return {
        ficProformaId: proforma.id,
        ficProformaNumber: proforma.number,
      };
    }),

  // ===== M6.2.B — New admin procedures via state machine =====

  /**
   * 9. Confirm payment (pending → paid)
   * For advance_transfer / credit_card / manual payment terms.
   */
  confirmPayment: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      return transitionOrder({
        orderId: input.orderId,
        toStatus: "paid",
        actorUserId: ctx.user.id,
      });
    }),

  /**
   * 10. Approve for shipping (pending → approved_for_shipping)
   * For on_delivery payment terms.
   */
  approveForShipping: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      return transitionOrder({
        orderId: input.orderId,
        toStatus: "approved_for_shipping",
        actorUserId: ctx.user.id,
      });
    }),

  /**
   * 11. Start transfer (paid/approved_for_shipping → transferring)
   * Validates all items have batch assigned.
   * BUG-4 FIX: After transition, decrement stock + create TRANSFER movements.
   */
  startTransfer: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // 1. Transition state (validates batch assignment)
      const result = await transitionOrder({
        orderId: input.orderId,
        toStatus: "transferring",
        actorUserId: ctx.user.id,
      });

      // 2. Execute stock movements for each order item with batch
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Get order retailerId
      const [order] = await db
        .select({ retailerId: orders.retailerId })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

      // Get all items with batch assigned
      const items = await db
        .select({
          id: orderItems.id,
          productId: orderItems.productId,
          batchId: orderItems.batchId,
          quantity: orderItems.quantity,
          productName: orderItems.productName,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, input.orderId));

      // Import transferBatchToRetailer from db.ts
      const { transferBatchToRetailer } = await import("./db");

      // Execute TRANSFER for each item with batch
      const transferResults: string[] = [];
      for (const item of items) {
        if (!item.batchId) continue; // should not happen (validated by state machine)
        try {
          await transferBatchToRetailer({
            productId: item.productId,
            batchId: item.batchId,
            retailerId: order.retailerId!,
            quantity: item.quantity,
            notes: `Ordine ${input.orderId} — trasferimento automatico`,
            createdBy: ctx.user.id,
          });
          transferResults.push(`${item.productName}: ${item.quantity} conf. trasferite`);
        } catch (e: any) {
          console.error(`[startTransfer] TRANSFER failed for item ${item.id}: ${e.message}`);
          // Don't block the transition — log and continue
          // Admin can manually fix stock later
          transferResults.push(`${item.productName}: ERRORE — ${e.message}`);
        }
      }

      console.log(`[startTransfer] orderId=${input.orderId} transfers completed:`, transferResults);
      return { ...result, transfers: transferResults };
    }),

  /**
   * 12. Mark shipped (transferring → shipped)
   */
  markShipped: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      return transitionOrder({
        orderId: input.orderId,
        toStatus: "shipped",
        actorUserId: ctx.user.id,
      });
    }),

  /**
   * 13. Mark delivered (shipped → delivered)
   * Triggers proforma → invoice transform on FiC.
   */
  markDelivered: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      return transitionOrder({
        orderId: input.orderId,
        toStatus: "delivered",
        actorUserId: ctx.user.id,
      });
    }),

  /**
   * 14. Confirm payment on delivery (delivered → paid_on_delivery)
   */
  confirmPaymentOnDelivery: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      return transitionOrder({
        orderId: input.orderId,
        toStatus: "paid_on_delivery",
        actorUserId: ctx.user.id,
      });
    }),

  /**
   * 15. Cancel order (from pending/paid/approved_for_shipping)
   * Deletes proforma from FiC if exists.
   */
  cancelOrder: staffProcedure
    .input(z.object({
      orderId: z.string().uuid(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return transitionOrder({
        orderId: input.orderId,
        toStatus: "cancelled",
        actorUserId: ctx.user.id,
        reason: input.reason,
      });
    }),

  /**
   * 15b. Get product pricing for a retailer (helper for edit items UI)
   * Returns list/discounted price for a product given the retailer's pricingPackage.
   */
  getProductPricingForRetailer: staffProcedure
    .input(z.object({
      productId: z.string().uuid(),
      retailerId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [product] = await db
        .select({
          id: products.id,
          name: products.name,
          sku: products.sku,
          unitPrice: products.unitPrice,
          vatRate: products.vatRate,
        })
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);

      if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "Prodotto non trovato" });

      const [retailer] = await db
        .select({
          pricingPackageId: retailers.pricingPackageId,
        })
        .from(retailers)
        .where(eq(retailers.id, input.retailerId))
        .limit(1);

      if (!retailer) throw new TRPCError({ code: "NOT_FOUND", message: "Retailer non trovato" });

      let discountPercent = 0;
      if (retailer.pricingPackageId) {
        const { pricingPackages } = await import("../drizzle/schema");
        const [pkg] = await db
          .select({ discountPercent: pricingPackages.discountPercent })
          .from(pricingPackages)
          .where(eq(pricingPackages.id, retailer.pricingPackageId))
          .limit(1);
        if (pkg) discountPercent = parseFloat(pkg.discountPercent);
      }

      const listPrice = parseFloat(product.unitPrice || "0");
      const discountedPrice = +(listPrice * (1 - discountPercent / 100)).toFixed(2);
      const vatRate = parseFloat(product.vatRate);

      return {
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        listPrice,
        discountedPrice,
        discountPercent,
        vatRate,
      };
    }),

  /**
   * 16. Modify order items (supports pending/paid/approved_for_shipping)
   * Full replacement: delete old items, insert new ones with recalculated pricing.
   * NO stock check (backorder allowed). FiC + commission updated if status >= paid.
   */
  modifyOrderItems: staffProcedure
    .input(z.object({
      orderId: z.string().uuid(),
      items: z.array(z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
      })).min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      const { modifyOrderItems } = await import("./services/orderStateMachine");
      return await modifyOrderItems({
        orderId: input.orderId,
        actorUserId: ctx.user.id,
        items: input.items,
      });
    }),

  /**
   * 17. Create event order (no retailer)
   */
  createEventOrder: staffProcedure
    .input(
      z.object({
        eventType: z.enum(["fair", "event", "gift", "internal", "other"]),
        eventName: z.string().min(1).max(255),
        eventDate: z.string().optional(),
        fiscalReceiptRef: z.string().max(50).optional(),
        notes: z.string().optional(),
        notesInternal: z.string().optional(),
        items: z.array(orderItemInput).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
      const pricing = await calculateEventOrderPricing(input.items);
      // FEFO allocation
      const [warehouse] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.type, "central_warehouse"))
        .limit(1);
      type BatchAllocation = { productId: string; batchId: string; quantity: number; batchNumber: string; expirationDate: string; };
      const allAllocations: (typeof pricing.items[0] & { allocations: BatchAllocation[] })[] = [];
      const fefoWarnings: string[] = [];
      for (const pi of pricing.items) {
        const allocations: BatchAllocation[] = [];
        let remaining = pi.quantity;
        if (warehouse) {
          const availableBatches = await db
            .select({
              batchId: productBatches.id,
              batchNumber: productBatches.batchNumber,
              expirationDate: productBatches.expirationDate,
              centralStock: inventoryByBatch.quantity,
            })
            .from(productBatches)
            .innerJoin(inventoryByBatch, and(eq(inventoryByBatch.batchId, productBatches.id), eq(inventoryByBatch.locationId, warehouse.id)))
            .where(and(eq(productBatches.productId, pi.productId), gt(inventoryByBatch.quantity, 0)))
            .orderBy(asc(productBatches.expirationDate));
          for (const batch of availableBatches) {
            if (remaining <= 0) break;
            const allocQty = Math.min(remaining, batch.centralStock);
            allocations.push({ productId: pi.productId, batchId: batch.batchId, quantity: allocQty, batchNumber: batch.batchNumber, expirationDate: batch.expirationDate });
            remaining -= allocQty;
          }
        }
        if (remaining > 0) fefoWarnings.push(`${pi.productSku}: stock insufficiente per ${remaining} conf`);
        allAllocations.push({ ...pi, allocations });
      }
      const result = await db.transaction(async (tx) => {
        const [order] = await tx.insert(orders).values({
          retailerId: null,
          eventType: input.eventType,
          eventName: input.eventName,
          eventDate: input.eventDate ?? null,
          fiscalReceiptRef: input.fiscalReceiptRef ?? null,
          status: "pending",
          paymentTerms: "manual",
          subtotalNet: pricing.subtotalNet,
          vatAmount: pricing.vatAmount,
          totalGross: pricing.totalGross,
          discountPercent: "0.00",
          notes: input.notes ?? null,
          notesInternal: input.notesInternal ?? null,
          createdBy: ctx.user.id,
        }).returning();
        const itemValues: Array<{ orderId: string; productId: string; quantity: number; unitPriceBase: string; discountPercent: string; unitPriceFinal: string; vatRate: string; lineTotalNet: string; lineTotalGross: string; productSku: string; productName: string; batchId: string | null; }> = [];
        for (const pi of allAllocations) {
          if (pi.allocations.length === 0) {
            itemValues.push({ orderId: order.id, productId: pi.productId, quantity: pi.quantity, unitPriceBase: pi.unitPriceBase, discountPercent: pi.discountPercent, unitPriceFinal: pi.unitPriceFinal, vatRate: pi.vatRate, lineTotalNet: pi.lineTotalNet, lineTotalGross: pi.lineTotalGross, productSku: pi.productSku, productName: pi.productName, batchId: null });
          } else {
            for (const alloc of pi.allocations) {
              const ratio = alloc.quantity / pi.quantity;
              itemValues.push({ orderId: order.id, productId: pi.productId, quantity: alloc.quantity, unitPriceBase: pi.unitPriceBase, discountPercent: pi.discountPercent, unitPriceFinal: pi.unitPriceFinal, vatRate: pi.vatRate, lineTotalNet: (parseFloat(pi.lineTotalNet) * ratio).toFixed(2), lineTotalGross: (parseFloat(pi.lineTotalGross) * ratio).toFixed(2), productSku: pi.productSku, productName: pi.productName, batchId: alloc.batchId });
            }
            const allocatedTotal = pi.allocations.reduce((s, a) => s + a.quantity, 0);
            const unallocated = pi.quantity - allocatedTotal;
            if (unallocated > 0) {
              const ratio = unallocated / pi.quantity;
              itemValues.push({ orderId: order.id, productId: pi.productId, quantity: unallocated, unitPriceBase: pi.unitPriceBase, discountPercent: pi.discountPercent, unitPriceFinal: pi.unitPriceFinal, vatRate: pi.vatRate, lineTotalNet: (parseFloat(pi.lineTotalNet) * ratio).toFixed(2), lineTotalGross: (parseFloat(pi.lineTotalGross) * ratio).toFixed(2), productSku: pi.productSku, productName: pi.productName, batchId: null });
            }
          }
        }
        if (itemValues.length > 0) await tx.insert(orderItems).values(itemValues);
        return order;
      });
      return { id: result.id, orderNumber: result.orderNumber, totalGross: pricing.totalGross, fefoWarnings };
    }),

  /**
   * 18. Deliver event order (pending → delivered, decrement stock)
   */
  deliverEventOrder: staffProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (!order.eventType) throw new TRPCError({ code: "BAD_REQUEST", message: "Non è un ordine evento" });
      if (order.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "Solo ordini pending possono essere consegnati" });
      const items = await db.select({ id: orderItems.id, productId: orderItems.productId, batchId: orderItems.batchId, quantity: orderItems.quantity, productName: orderItems.productName }).from(orderItems).where(eq(orderItems.orderId, input.orderId));
      const [warehouse] = await db.select({ id: locations.id }).from(locations).where(eq(locations.type, "central_warehouse")).limit(1);
      if (!warehouse) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Magazzino centrale non configurato" });
      const results: string[] = [];
      await db.transaction(async (tx) => {
        for (const item of items) {
          if (!item.batchId) { results.push(`${item.productName}: nessun lotto, stock non decrementato`); continue; }
          const centralRows = await tx.select().from(inventoryByBatch).where(and(eq(inventoryByBatch.locationId, warehouse.id), eq(inventoryByBatch.batchId, item.batchId))).for("update");
          const central = centralRows[0];
          if (!central || central.quantity < item.quantity) { results.push(`${item.productName}: stock insufficiente (${central?.quantity ?? 0} < ${item.quantity})`); continue; }
          await tx.update(inventoryByBatch).set({ quantity: central.quantity - item.quantity, updatedAt: new Date() }).where(eq(inventoryByBatch.id, central.id));
          const { stockMovements } = await import("../drizzle/schema");
          await tx.insert(stockMovements).values({ productId: item.productId, type: "OUT", quantity: item.quantity, previousQuantity: central.quantity, newQuantity: central.quantity - item.quantity, batchId: item.batchId, fromLocationId: warehouse.id, notes: `Ordine evento ${order.orderNumber} — ${order.eventName}`, createdBy: ctx.user.id });
          results.push(`${item.productName}: ${item.quantity} conf. scaricate`);
        }
        await tx.update(orders).set({ status: "delivered", deliveredAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, input.orderId));
      });
      return { success: true, results };
    }),

  /**
   * 19. Get available stock for products (admin helper)
   */
  getAvailableStock: staffProcedure
    .input(z.object({
      productIds: z.array(z.string().uuid()).min(1).max(50),
    }))
    .query(async ({ input }) => {
      const stockMap = await getAvailableStock(input.productIds);
      return Array.from(stockMap.values());
    }),
});
