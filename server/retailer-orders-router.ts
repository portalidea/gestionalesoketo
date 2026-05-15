/**
 * M6.2.B — Retailer Orders Router
 *
 * Procedure retailer per gestione ordini propri:
 * - list: lista ordini del retailer
 * - getById: dettaglio ordine con items, lotti, timeline
 * - updateItems: modifica ordine pending (re-FEFO + rigenera proforma)
 * - cancel: cancella ordine pending (release lotti)
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { retailerProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { calculateOrderPricing } from "./pricing";
import {
  inventoryByBatch,
  locations,
  orderItems,
  orders,
  productBatches,
  products,
  retailers,
} from "../drizzle/schema";
import { createFicProforma } from "./fic-integration";
import { sendEmail } from "./email";

export const retailerOrdersRouter = router({
  /**
   * 1. list — lista ordini del retailer corrente
   */
  list: retailerProcedure
    .input(
      z.object({
        status: z.enum(["pending", "paid", "transferring", "shipped", "delivered", "cancelled"]).optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const conditions = [eq(orders.retailerId, ctx.retailerId)];
      if (input.status) {
        conditions.push(eq(orders.status, input.status));
      }
      const whereClause = and(...conditions);

      // Count
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(whereClause);
      const total = countRow?.count ?? 0;

      // Ordini paginati
      const offset = (input.page - 1) * input.pageSize;
      const orderRows = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          status: orders.status,
          subtotalNet: orders.subtotalNet,
          vatAmount: orders.vatAmount,
          totalGross: orders.totalGross,
          discountPercent: orders.discountPercent,
          ficProformaNumber: orders.ficProformaNumber,
          createdAt: orders.createdAt,
          paidAt: orders.paidAt,
          shippedAt: orders.shippedAt,
          deliveredAt: orders.deliveredAt,
          cancelledAt: orders.cancelledAt,
        })
        .from(orders)
        .where(whereClause)
        .orderBy(desc(orders.createdAt))
        .limit(input.pageSize)
        .offset(offset);

      // Count items per ordine
      if (orderRows.length === 0) return { orders: [], total };

      const orderIds = orderRows.map((o) => o.id);
      const itemCountRows = await db.execute<{ orderId: string; itemCount: number }>(sql`
        SELECT "orderId" AS "orderId", COUNT(*)::int AS "itemCount"
        FROM "orderItems"
        WHERE "orderId" IN (${sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `)})
        GROUP BY "orderId"
      `);
      const itemCountMap = new Map(
        (itemCountRows as unknown as Array<{ orderId: string; itemCount: number }>).map((r) => [
          r.orderId,
          r.itemCount,
        ]),
      );

      return {
        orders: orderRows.map((o) => ({
          ...o,
          itemCount: itemCountMap.get(o.id) ?? 0,
        })),
        total,
      };
    }),

  /**
   * 2. getById — dettaglio ordine con items, lotti, timeline
   */
  getById: retailerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, input.id))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (order.retailerId !== ctx.retailerId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Non autorizzato a visualizzare questo ordine" });
      }

      // Items con lotti
      const items = await db
        .select({
          id: orderItems.id,
          productId: orderItems.productId,
          productSku: orderItems.productSku,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          unitPriceBase: orderItems.unitPriceBase,
          discountPercent: orderItems.discountPercent,
          unitPriceFinal: orderItems.unitPriceFinal,
          vatRate: orderItems.vatRate,
          lineTotalNet: orderItems.lineTotalNet,
          lineTotalGross: orderItems.lineTotalGross,
          batchId: orderItems.batchId,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
        })
        .from(orderItems)
        .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
        .where(eq(orderItems.orderId, input.id))
        .orderBy(asc(orderItems.productName));

      // Timeline
      const timeline = [
        { status: "pending", label: "Creato", date: order.createdAt },
        { status: "paid", label: "Pagato", date: order.paidAt },
        { status: "transferring", label: "In preparazione", date: order.transferringAt },
        { status: "shipped", label: "Spedito", date: order.shippedAt },
        { status: "delivered", label: "Consegnato", date: order.deliveredAt },
      ];
      if (order.cancelledAt) {
        timeline.push({ status: "cancelled", label: "Cancellato", date: order.cancelledAt });
      }

      return {
        order,
        items,
        timeline,
      };
    }),

  /**
   * 3. updateItems — modifica ordine pending
   *    - Verifica ownership + status pending
   *    - DELETE + INSERT items con re-FEFO
   *    - Ricalcola totali
   *    - Rigenera proforma FiC
   */
  updateItems: retailerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Verifica ownership + status
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, input.id))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (order.retailerId !== ctx.retailerId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Non autorizzato" });
      }
      if (order.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Solo ordini in stato 'pending' possono essere modificati" });
      }

      // Ricalcola pricing
      const pricing = await calculateOrderPricing(ctx.retailerId, input.items);

      // Verifica stock
      const stockErrors: string[] = [];
      for (const pi of pricing.items) {
        if (pi.stockWarning) {
          stockErrors.push(
            `${pi.productName}: richieste ${pi.quantity} conf, disponibili ${pi.stockAvailableConfezioni} conf`,
          );
        }
      }
      if (stockErrors.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Stock insufficiente:\n${stockErrors.join("\n")}`,
        });
      }

      // Auto-FEFO
      const [warehouse] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.type, "central_warehouse"))
        .limit(1);

      type BatchAllocation = {
        productId: string;
        batchId: string;
        quantity: number;
        batchNumber: string;
        expirationDate: string;
      };
      const allAllocations: (typeof pricing.items[0] & { allocations: BatchAllocation[] })[] = [];

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

        allAllocations.push({ ...pi, allocations });
      }

      // Transazione: delete old items + insert new + update totali
      await db.transaction(async (tx) => {
        // Delete vecchi items
        await tx.delete(orderItems).where(eq(orderItems.orderId, input.id));

        // Insert nuovi items
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
            itemValues.push({
              orderId: input.id,
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
            for (const alloc of pi.allocations) {
              const ratio = alloc.quantity / pi.quantity;
              itemValues.push({
                orderId: input.id,
                productId: pi.productId,
                quantity: alloc.quantity,
                unitPriceBase: pi.unitPriceBase,
                discountPercent: pi.discountPercent,
                unitPriceFinal: pi.unitPriceFinal,
                vatRate: pi.vatRate,
                lineTotalNet: (parseFloat(pi.lineTotalNet) * ratio).toFixed(2),
                lineTotalGross: (parseFloat(pi.lineTotalGross) * ratio).toFixed(2),
                productSku: pi.productSku,
                productName: pi.productName,
                batchId: alloc.batchId,
              });
            }
            const allocatedTotal = pi.allocations.reduce((s, a) => s + a.quantity, 0);
            const unallocated = pi.quantity - allocatedTotal;
            if (unallocated > 0) {
              const ratio = unallocated / pi.quantity;
              itemValues.push({
                orderId: input.id,
                productId: pi.productId,
                quantity: unallocated,
                unitPriceBase: pi.unitPriceBase,
                discountPercent: pi.discountPercent,
                unitPriceFinal: pi.unitPriceFinal,
                vatRate: pi.vatRate,
                lineTotalNet: (parseFloat(pi.lineTotalNet) * ratio).toFixed(2),
                lineTotalGross: (parseFloat(pi.lineTotalGross) * ratio).toFixed(2),
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

        // Update totali ordine
        await tx
          .update(orders)
          .set({
            subtotalNet: pricing.subtotalNet,
            vatAmount: pricing.vatAmount,
            totalGross: pricing.totalGross,
            discountPercent: pricing.discountPercent,
            notes: input.notes !== undefined ? input.notes : order.notes,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, input.id));
      });

      // Rigenera proforma FiC (non bloccante)
      try {
        const [retailer] = await db
          .select({ ficClientId: retailers.ficClientId, name: retailers.name })
          .from(retailers)
          .where(eq(retailers.id, ctx.retailerId))
          .limit(1);

        if (retailer?.ficClientId) {
          const items = await db
            .select({
              productName: orderItems.productName,
              quantity: orderItems.quantity,
              unitPriceFinal: orderItems.unitPriceFinal,
              vatRate: orderItems.vatRate,
              batchId: orderItems.batchId,
              batchNumber: productBatches.batchNumber,
              expirationDate: productBatches.expirationDate,
            })
            .from(orderItems)
            .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
            .where(eq(orderItems.orderId, input.id));

          const ficItems = items.map((it) => {
            let description = "";
            if (it.batchId && it.batchNumber) {
              const expDate = it.expirationDate
                ? new Date(it.expirationDate).toLocaleDateString("it-IT")
                : "N/D";
              description = `Lotto: ${it.batchNumber} - Scadenza: ${expDate}`;
            }
            return {
              name: it.productName,
              description,
              qty: it.quantity,
              unitPriceFinal: it.unitPriceFinal,
              vatRate: it.vatRate,
            };
          });

          // Reset proforma precedente
          await db
            .update(orders)
            .set({ ficProformaId: null, ficProformaNumber: null, updatedAt: new Date() })
            .where(eq(orders.id, input.id));

          const proforma = await createFicProforma({
            ficClientId: retailer.ficClientId,
            date: new Date().toISOString().split("T")[0],
            orderNumber: order.orderNumber ?? undefined,
            totalGross: parseFloat(pricing.totalGross),
            notesInternal: `Ordine ${order.orderNumber} (modificato) — portale partner`,
            items: ficItems,
          });

          await db
            .update(orders)
            .set({
              ficProformaId: proforma.id,
              ficProformaNumber: proforma.number,
              updatedAt: new Date(),
            })
            .where(eq(orders.id, input.id));
        }
      } catch (err) {
        console.error("[retailerOrders.updateItems] Errore rigenerazione proforma:", err);
      }

      return { success: true };
    }),

  /**
   * 4. cancel — cancella ordine pending
   */
  cancel: retailerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, input.id))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (order.retailerId !== ctx.retailerId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Non autorizzato" });
      }
      if (order.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Solo ordini in stato 'pending' possono essere cancellati" });
      }

      // Release lotti (set batchId = NULL su orderItems)
      await db
        .update(orderItems)
        .set({ batchId: null })
        .where(eq(orderItems.orderId, input.id));

      // Update status
      await db
        .update(orders)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, input.id));

      // Email notifica admin
      try {
        const [retailer] = await db
          .select({ name: retailers.name })
          .from(retailers)
          .where(eq(retailers.id, ctx.retailerId))
          .limit(1);

        await sendEmail({
          to: "alessandro@soketo.it",
          subject: `Ordine ${order.orderNumber} cancellato da ${retailer?.name ?? "retailer"}`,
          html: `<p>L'ordine <strong>${order.orderNumber}</strong> è stato cancellato dal rivenditore <strong>${retailer?.name ?? "N/D"}</strong>.</p>`,
        });
      } catch (err) {
        console.error("[retailerOrders.cancel] Errore email admin:", err);
      }

      return { success: true };
    }),
});
