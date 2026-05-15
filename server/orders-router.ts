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
import { protectedProcedure, router } from "./_core/trpc";
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
import { calculateOrderPricing, type PricingItemInput } from "./pricing";
import { createFicProforma } from "./fic-integration";

// --- Zod Schemas ---

const orderItemInput = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

const statusEnum = z.enum([
  "pending",
  "paid",
  "transferring",
  "shipped",
  "delivered",
  "cancelled",
]);

// FSM: allowed transitions
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ["paid", "cancelled"],
  paid: ["transferring", "cancelled"],
  transferring: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

// --- Router ---

export const ordersRouter = router({
  /**
   * 1. Lista ordini con filtri
   */
  list: protectedProcedure
    .input(
      z.object({
        status: statusEnum.optional(),
        retailerId: z.string().uuid().optional(),
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
            createdAt: orders.createdAt,
            updatedAt: orders.updatedAt,
          })
          .from(orders)
          .innerJoin(retailers, eq(orders.retailerId, retailers.id))
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
  getById: protectedProcedure
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
          paidAt: orders.paidAt,
          transferringAt: orders.transferringAt,
          shippedAt: orders.shippedAt,
          deliveredAt: orders.deliveredAt,
          cancelledAt: orders.cancelledAt,
          createdBy: orders.createdBy,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .innerJoin(retailers, eq(orders.retailerId, retailers.id))
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
  preview: protectedProcedure
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
  create: protectedProcedure
    .input(
      z.object({
        retailerId: z.string().uuid(),
        items: z.array(orderItemInput).min(1),
        notes: z.string().optional(),
        notesInternal: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

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
  updateItems: protectedProcedure
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
      const pricing = await calculateOrderPricing(order.retailerId, input.items);

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

  /**
   * 6. Transizione status con validazione FSM
   */
  updateStatus: protectedProcedure
    .input(
      z.object({
        orderId: z.string().uuid(),
        newStatus: statusEnum,
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [order] = await db
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

      const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(input.newStatus)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Transizione non valida: ${order.status} → ${input.newStatus}. Consentite: ${allowed.join(", ") || "nessuna"}`,
        });
      }

      // Validazione pre-shipped: tutti gli items devono avere batchId assegnato
      if (input.newStatus === "shipped") {
        const items = await db
          .select({ id: orderItems.id, batchId: orderItems.batchId, productName: orderItems.productName })
          .from(orderItems)
          .where(eq(orderItems.orderId, input.orderId));
        const unassigned = items.filter((it) => !it.batchId);
        if (unassigned.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Impossibile spedire: ${unassigned.length} item(s) senza lotto assegnato (${unassigned.map((u) => u.productName).join(", ")})`,
          });
        }
      }

      // Timestamp per lo status
      const timestampMap: Record<string, string> = {
        paid: "paidAt",
        transferring: "transferringAt",
        shipped: "shippedAt",
        delivered: "deliveredAt",
        cancelled: "cancelledAt",
      };
      const timestampField = timestampMap[input.newStatus];

      const updateData: Record<string, any> = {
        status: input.newStatus,
        updatedAt: new Date(),
      };
      if (timestampField) {
        updateData[timestampField] = new Date();
      }

      await db.update(orders).set(updateData).where(eq(orders.id, input.orderId));

      return { status: input.newStatus };
    }),

  /**
   * 7. Genera proforma FiC e salva riferimento
   */
  /**
   * 8. Assegna/rimuovi lotto su un orderItem
   */
  assignBatch: protectedProcedure
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
        })
        .from(orderItems)
        .where(eq(orderItems.id, input.orderItemId))
        .limit(1);

      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item ordine non trovato" });

      // Verifica ordine non è in stato finale
      const [order] = await db
        .select({ status: orders.status })
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

        await db
          .update(orderItems)
          .set({ batchId: input.batchId })
          .where(eq(orderItems.id, input.orderItemId));

        return { batchId: input.batchId, batchNumber: batch.batchNumber, expirationDate: batch.expirationDate };
      } else {
        // Rimuovi assegnazione
        await db
          .update(orderItems)
          .set({ batchId: null })
          .where(eq(orderItems.id, input.orderItemId));

        return { batchId: null, batchNumber: null, expirationDate: null };
      }
    }),

  /**
   * 9. Lista lotti disponibili per un prodotto (per dropdown assegnazione)
   */
  batchesForProduct: protectedProcedure
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
   * 10. Genera proforma FiC e salva riferimento
   */
  generateProforma: protectedProcedure
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
        .where(eq(retailers.id, order.retailerId))
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

      // Crea proforma su FiC — name multi-riga, no code
      const ficItems = items.map((it) => {
        const lines: string[] = [it.productName];
        if (it.productDescription?.trim()) {
          lines.push(it.productDescription.trim());
        }
        if (it.batchId && it.batchNumber) {
          const expDate = it.expirationDate
            ? new Date(it.expirationDate).toLocaleDateString("it-IT")
            : null;
          lines.push(
            expDate
              ? `Lotto: ${it.batchNumber} - Scadenza: ${expDate}`
              : `Lotto: ${it.batchNumber}`,
          );
        }
        return {
          description: lines.join("\n"),
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
});
