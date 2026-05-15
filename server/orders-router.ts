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
} from "../drizzle/schema";
import { eq, desc, and, gte, lte, sql, inArray } from "drizzle-orm";
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

        // Insert items con snapshot
        const itemValues = pricing.items.map((pi) => ({
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
        }));

        await tx.insert(orderItems).values(itemValues);

        return order;
      });

      return {
        id: result.id,
        orderNumber: result.orderNumber,
        totalGross: pricing.totalGross,
        warnings: pricing.warnings,
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

      // Carica items
      const items = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, input.orderId));

      if (items.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Ordine senza righe" });
      }

      // Crea proforma su FiC
      const ficItems = items.map((it) => ({
        code: it.productSku,
        description: `${it.productSku} — ${it.productName}`,
        qty: it.quantity,
        unitPriceFinal: it.unitPriceFinal,
        vatRate: it.vatRate,
      }));

      const proforma = await createFicProforma({
        ficClientId: retailer.ficClientId,
        date: new Date().toISOString().split("T")[0],
        orderNumber: order.orderNumber ?? undefined,
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
