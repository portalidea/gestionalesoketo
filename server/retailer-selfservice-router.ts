/**
 * M6.2.B Parte B — Retailer Self-Service Router
 *
 * Procedure tRPC per il portale retailer self-service:
 * - catalog.list: catalogo prodotti con prezzi scontati e stock
 * - cart.preview: anteprima totali carrello
 * - cart.checkout: crea ordine + email IBAN
 * - orders.list: lista ordini retailer
 * - orders.getById: dettaglio ordine
 * - orders.modifyItems: modifica ordine pending
 * - orders.cancel: cancella ordine pending
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, ilike, sql, and, inArray, desc, asc, gte, lte } from "drizzle-orm";
import { retailerProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  products,
  retailers,
  pricingPackages,
  orders,
  orderItems,
  productBatches,
} from "../drizzle/schema";
import { getAvailableStock } from "./services/stockService";
import { calculateOrderPricing, PricingItemInput } from "./pricing";
import { transitionOrder } from "./services/orderStateMachine";
import { sendEmail } from "./email";
import { ENV } from "./_core/env";

export const retailerSelfServiceRouter = router({
  // ============= CATALOGO =============

  /**
   * Lista catalogo prodotti con prezzi scontati e stock disponibile.
   */
  catalogList: retailerProcedure
    .input(
      z.object({
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      console.log(
        `[retailerPortal.catalogList] retailerId=${ctx.retailerId} search=${input.search ?? ""} offset=${input.offset}`,
      );
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Get retailer + pricing package
      const [retailer] = await database
        .select({
          pricingPackageId: retailers.pricingPackageId,
          paymentTerms: retailers.paymentTerms,
        })
        .from(retailers)
        .where(eq(retailers.id, ctx.retailerId))
        .limit(1);

      if (!retailer) throw new TRPCError({ code: "NOT_FOUND", message: "Retailer non trovato" });

      let discountPercent = 0;
      let packageName: string | null = null;
      if (retailer.pricingPackageId) {
        const [pkg] = await database
          .select({ discountPercent: pricingPackages.discountPercent, name: pricingPackages.name })
          .from(pricingPackages)
          .where(eq(pricingPackages.id, retailer.pricingPackageId))
          .limit(1);
        if (pkg) {
          discountPercent = parseFloat(pkg.discountPercent);
          packageName = pkg.name;
        }
      }

      // Build conditions
      const conditions = [];
      if (input.search) {
        conditions.push(ilike(products.name, `%${input.search}%`));
      }

      // Count total
      const countResult = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      const totalCount = countResult[0]?.count ?? 0;

      // Get products
      const productRows = await database
        .select({
          id: products.id,
          name: products.name,
          sku: products.sku,
          category: products.category,
          imageUrl: products.imageUrl,
          unitPrice: products.unitPrice,
          vatRate: products.vatRate,
          piecesPerUnit: products.piecesPerUnit,
          sellableUnitLabel: products.sellableUnitLabel,
          description: products.description,
        })
        .from(products)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .limit(input.limit)
        .offset(input.offset)
        .orderBy(products.name);

      if (productRows.length === 0) return { products: [], packageName, discountPercent, totalCount };

      // Get available stock
      const productIds = productRows.map((p) => p.id);
      const stockMap = await getAvailableStock(productIds);

      // Map results
      const catalogProducts = productRows.map((p) => {
        const listPrice = parseFloat(p.unitPrice ?? "0");
        const discountedPrice = +(listPrice * (1 - discountPercent / 100)).toFixed(2);
        const stock = stockMap.get(p.id);
        return {
          productId: p.id,
          name: p.name,
          sku: p.sku,
          category: p.category,
          imageUrl: p.imageUrl,
          listPrice,
          discountedPrice,
          discountPercentage: discountPercent,
          vatRate: parseFloat(p.vatRate),
          availableStock: stock?.availableQty ?? 0,
          piecesPerUnit: p.piecesPerUnit,
          sellableUnitLabel: p.sellableUnitLabel,
          description: p.description,
        };
      });

      console.log(`[retailerPortal.catalogList] DONE: ${catalogProducts.length} products, totalCount=${totalCount}`);
      return { products: catalogProducts, packageName, discountPercent, totalCount };
    }),

  // ============= CARRELLO =============

  /**
   * Preview carrello: calcola totali senza salvare.
   */
  cartPreview: retailerProcedure
    .input(
      z.object({
        items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      console.log(`[retailerPortal.cartPreview] retailerId=${ctx.retailerId} items=${input.items.length}`);

      // Use calculateOrderPricing for consistent pricing
      const pricing = await calculateOrderPricing(ctx.retailerId, input.items);

      // Get retailer payment terms
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [retailer] = await database
        .select({ paymentTerms: retailers.paymentTerms })
        .from(retailers)
        .where(eq(retailers.id, ctx.retailerId))
        .limit(1);

      const paymentTerms = retailer?.paymentTerms ?? "advance_transfer";
      const paymentTermsLabels: Record<string, string> = {
        advance_transfer: "Bonifico bancario anticipato",
        on_delivery: "Pagamento alla consegna",
        credit_card: "Carta di credito",
        manual: "Manuale",
      };

      // Check stock warnings
      const productIds = input.items.map((i) => i.productId);
      const stockMap = await getAvailableStock(productIds);
      const warnings: Array<{ productId: string; message: string }> = [];
      for (const item of input.items) {
        const stock = stockMap.get(item.productId);
        const available = stock?.availableQty ?? 0;
        if (item.quantity > available) {
          const pricingItem = pricing.items.find((pi) => pi.productId === item.productId);
          warnings.push({
            productId: item.productId,
            message: `Solo ${available} disponibili per "${pricingItem?.productName ?? item.productId}", richiesti ${item.quantity}`,
          });
        }
      }

      return {
        items: pricing.items.map((pi) => ({
          productId: pi.productId,
          productName: pi.productName,
          productSku: pi.productSku,
          quantity: pi.quantity,
          unitPriceBase: pi.unitPriceBase,
          discountPercent: pi.discountPercent,
          unitPriceFinal: pi.unitPriceFinal,
          vatRate: pi.vatRate,
          lineTotalNet: pi.lineTotalNet,
          lineTotalGross: pi.lineTotalGross,
        })),
        subtotalNet: pricing.subtotalNet,
        vatAmount: pricing.vatAmount,
        totalGross: pricing.totalGross,
        discountPercent: pricing.discountPercent,
        packageName: pricing.packageName,
        paymentTerms,
        paymentTermsLabel: paymentTermsLabels[paymentTerms] ?? paymentTerms,
        warnings,
      };
    }),

  /**
   * Checkout: crea ordine + email riepilogo con IBAN.
   */
  cartCheckout: retailerProcedure
    .input(
      z.object({
        items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      console.log(`[retailerPortal.cartCheckout] retailerId=${ctx.retailerId} items=${input.items.length}`);

      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Validate stock (hard fail)
      const productIds = input.items.map((i) => i.productId);
      const stockMap = await getAvailableStock(productIds);
      const insufficientItems: string[] = [];
      for (const item of input.items) {
        const stock = stockMap.get(item.productId);
        if (!stock || item.quantity > stock.availableQty) {
          insufficientItems.push(item.productId);
        }
      }
      if (insufficientItems.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Stock insufficiente per ${insufficientItems.length} prodotto/i. Aggiorna le quantità.`,
        });
      }

      // Get retailer info for order
      const [retailer] = await database
        .select({
          paymentTerms: retailers.paymentTerms,
          name: retailers.name,
          email: retailers.email,
        })
        .from(retailers)
        .where(eq(retailers.id, ctx.retailerId))
        .limit(1);

      if (!retailer) throw new TRPCError({ code: "NOT_FOUND", message: "Retailer non trovato" });

      // Calculate pricing
      const pricing = await calculateOrderPricing(ctx.retailerId, input.items);

      // Create order in transaction (same logic as orders.create but for retailer)
      const result = await database.transaction(async (tx) => {
        const [order] = await tx
          .insert(orders)
          .values({
            retailerId: ctx.retailerId,
            status: "pending",
            paymentTerms: retailer.paymentTerms,
            subtotalNet: pricing.subtotalNet,
            vatAmount: pricing.vatAmount,
            totalGross: pricing.totalGross,
            discountPercent: pricing.discountPercent,
            notes: input.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning();

        // Insert items
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
          batchId: null,
        }));

        if (itemValues.length > 0) {
          await tx.insert(orderItems).values(itemValues);
        }

        return order;
      });

      // Send order summary email to retailer
      const orderShortId = result.id.slice(0, 8).toUpperCase();
      if (retailer.email) {
        try {
          const emailHtml = buildCheckoutEmailHtml({
            retailerName: retailer.name,
            orderShortId,
            items: pricing.items,
            subtotalNet: pricing.subtotalNet,
            vatAmount: pricing.vatAmount,
            totalGross: pricing.totalGross,
            discountPercent: pricing.discountPercent,
            packageName: pricing.packageName,
            paymentTerms: retailer.paymentTerms,
            orderId: result.id,
          });
          await sendEmail({
            to: retailer.email,
            subject: `Riepilogo ordine SoKeto #${orderShortId}`,
            html: emailHtml,
          });
        } catch (e: any) {
          console.error(`[retailerPortal.cartCheckout] email send failed: ${e.message}`);
        }
      }

      // Notify admin
      try {
        await sendEmail({
          to: "info@soketo.it",
          subject: `Nuovo ordine #${orderShortId} da ${retailer.name}`,
          html: `<p>Nuovo ordine ricevuto dal portale self-service.</p>
<p><strong>Retailer:</strong> ${retailer.name}<br/>
<strong>Ordine:</strong> #${orderShortId}<br/>
<strong>Totale:</strong> €${pricing.totalGross}<br/>
<strong>Pagamento:</strong> ${retailer.paymentTerms === "on_delivery" ? "Alla consegna" : "Bonifico anticipato"}</p>`,
        });
      } catch (e: any) {
        console.error(`[retailerPortal.cartCheckout] admin email failed: ${e.message}`);
      }

      console.log(`[retailerPortal.cartCheckout] DONE: orderId=${result.id} orderNumber=${result.orderNumber}`);
      return { orderId: result.id, orderNumber: result.orderNumber };
    }),

  // ============= ORDINI =============

  /**
   * Lista ordini del retailer con filtri.
   */
  ordersList: retailerProcedure
    .input(
      z.object({
        status: z.array(z.enum(["pending", "paid", "approved_for_shipping", "transferring", "shipped", "delivered", "paid_on_delivery", "cancelled"])).optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        search: z.string().optional(),
        sortBy: z.enum(["date", "total"]).default("date"),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      console.log(`[retailerPortal.ordersList] retailerId=${ctx.retailerId}`);
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Build conditions
      const conditions = [eq(orders.retailerId, ctx.retailerId)];
      if (input.status && input.status.length > 0) {
        conditions.push(inArray(orders.status, input.status));
      }
      if (input.dateFrom) {
        conditions.push(gte(orders.createdAt, new Date(input.dateFrom)));
      }
      if (input.dateTo) {
        conditions.push(lte(orders.createdAt, new Date(input.dateTo)));
      }
      if (input.search) {
        conditions.push(ilike(orders.orderNumber, `%${input.search}%`));
      }

      const whereClause = and(...conditions);

      // Count
      const countResult = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(whereClause);
      const totalCount = countResult[0]?.count ?? 0;

      // Sort
      const sortColumn = input.sortBy === "total" ? orders.totalGross : orders.createdAt;
      const orderDirection = input.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);

      // Query
      const orderRows = await database
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          createdAt: orders.createdAt,
          status: orders.status,
          paymentTerms: orders.paymentTerms,
          totalGross: orders.totalGross,
          paidAt: orders.paidAt,
        })
        .from(orders)
        .where(whereClause)
        .orderBy(orderDirection)
        .limit(input.limit)
        .offset(input.offset);

      // Get item counts
      const orderIds = orderRows.map((o) => o.id);
      let itemCounts = new Map<string, number>();
      if (orderIds.length > 0) {
        const counts = await database
          .select({
            orderId: orderItems.orderId,
            count: sql<number>`count(*)::int`,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, orderIds))
          .groupBy(orderItems.orderId);
        itemCounts = new Map(counts.map((c) => [c.orderId, c.count]));
      }

      const result = orderRows.map((o) => {
        let paymentStatus: string;
        if (o.status === "paid" || o.status === "paid_on_delivery") paymentStatus = "Pagato";
        else if (o.status === "cancelled") paymentStatus = "Annullato";
        else if (o.status === "delivered" && o.paymentTerms === "on_delivery") paymentStatus = "Da pagare";
        else if (o.paidAt) paymentStatus = "Pagato";
        else paymentStatus = "Da pagare";

        return {
          id: o.id,
          orderNumber: o.orderNumber,
          createdAt: o.createdAt,
          status: o.status,
          paymentStatus,
          totalAmount: o.totalGross,
          itemCount: itemCounts.get(o.id) ?? 0,
        };
      });

      return { orders: result, totalCount };
    }),

  /**
   * Dettaglio ordine singolo (security: solo ordini del retailer corrente).
   */
  ordersGetById: retailerProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      console.log(`[retailerPortal.ordersGetById] retailerId=${ctx.retailerId} orderId=${input.orderId}`);
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [order] = await database
        .select()
        .from(orders)
        .where(and(eq(orders.id, input.orderId), eq(orders.retailerId, ctx.retailerId)))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

      // Get items with optional batch info
      const showBatchInfo = ["paid", "approved_for_shipping", "transferring", "shipped", "delivered", "paid_on_delivery"].includes(order.status);

      const items = await database
        .select({
          id: orderItems.id,
          productId: orderItems.productId,
          productName: orderItems.productName,
          productSku: orderItems.productSku,
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
        .where(eq(orderItems.orderId, input.orderId));

      // Build status history from timestamps
      const statusHistory: Array<{ status: string; timestamp: Date | null }> = [];
      statusHistory.push({ status: "pending", timestamp: order.createdAt });
      if (order.paidAt) statusHistory.push({ status: "paid", timestamp: order.paidAt });
      if (order.approvedForShippingAt) statusHistory.push({ status: "approved_for_shipping", timestamp: order.approvedForShippingAt });
      if (order.transferringAt) statusHistory.push({ status: "transferring", timestamp: order.transferringAt });
      if (order.shippedAt) statusHistory.push({ status: "shipped", timestamp: order.shippedAt });
      if (order.deliveredAt) statusHistory.push({ status: "delivered", timestamp: order.deliveredAt });
      if (order.cancelledAt) statusHistory.push({ status: "cancelled", timestamp: order.cancelledAt });

      return {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          createdAt: order.createdAt,
          status: order.status,
          paymentTerms: order.paymentTerms,
          subtotalNet: order.subtotalNet,
          vatAmount: order.vatAmount,
          totalGross: order.totalGross,
          discountPercent: order.discountPercent,
          notes: order.notes,
          ficProformaId: order.ficProformaId,
          ficProformaNumber: order.ficProformaNumber,
          ficInvoiceId: order.ficInvoiceId,
          ficInvoiceNumber: order.ficInvoiceNumber,
          paidAt: order.paidAt,
          shippedAt: order.shippedAt,
          deliveredAt: order.deliveredAt,
          cancelledAt: order.cancelledAt,
          cancelledReason: order.cancelledReason,
        },
        items: items.map((it) => ({
          ...it,
          batchNumber: showBatchInfo ? it.batchNumber : null,
          expirationDate: showBatchInfo ? it.expirationDate : null,
        })),
        statusHistory,
        canModify: order.status === "pending",
        canCancel: order.status === "pending",
      };
    }),

  /**
   * Modifica items ordine pending (retailer).
   */
  ordersModifyItems: retailerProcedure
    .input(
      z.object({
        orderId: z.string().uuid(),
        items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      console.log(`[retailerPortal.ordersModifyItems] retailerId=${ctx.retailerId} orderId=${input.orderId}`);
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Verify ownership + status
      const [order] = await database
        .select({ id: orders.id, status: orders.status, retailerId: orders.retailerId })
        .from(orders)
        .where(and(eq(orders.id, input.orderId), eq(orders.retailerId, ctx.retailerId)))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (order.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Solo ordini in stato 'pending' possono essere modificati" });
      }

      // Validate stock (excluding current order from reserved)
      const productIds = input.items.map((i) => i.productId);
      const stockMap = await getAvailableStock(productIds);

      // Get current order items to "free" their reserved stock
      const currentItems = await database
        .select({ productId: orderItems.productId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, input.orderId));
      const currentReserved = new Map<string, number>();
      for (const ci of currentItems) {
        currentReserved.set(ci.productId, (currentReserved.get(ci.productId) ?? 0) + ci.quantity);
      }

      for (const item of input.items) {
        const stock = stockMap.get(item.productId);
        const available = (stock?.availableQty ?? 0) + (currentReserved.get(item.productId) ?? 0);
        if (item.quantity > available) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Stock insufficiente per prodotto ${item.productId}: disponibili ${available}, richiesti ${item.quantity}`,
          });
        }
      }

      // Recalculate pricing
      const pricing = await calculateOrderPricing(ctx.retailerId, input.items);

      // Update in transaction
      await database.transaction(async (tx) => {
        await tx.delete(orderItems).where(eq(orderItems.orderId, input.orderId));
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
          batchId: null,
        }));
        await tx.insert(orderItems).values(itemValues);
      });

      // Send email notification
      const [retailer] = await database
        .select({ email: retailers.email, name: retailers.name })
        .from(retailers)
        .where(eq(retailers.id, ctx.retailerId))
        .limit(1);

      if (retailer?.email) {
        try {
          await sendEmail({
            to: retailer.email,
            subject: `Ordine SoKeto #${order.id.slice(0, 8).toUpperCase()} modificato`,
            html: `<p>Il tuo ordine è stato aggiornato con successo.</p><p><strong>Nuovo totale:</strong> €${pricing.totalGross}</p>`,
          });
        } catch (e: any) {
          console.error(`[retailerPortal.ordersModifyItems] email failed: ${e.message}`);
        }
      }

      return { success: true, updatedOrderId: input.orderId, totalGross: pricing.totalGross };
    }),

  /**
   * Cancella ordine pending (retailer).
   */
  ordersCancel: retailerProcedure
    .input(z.object({ orderId: z.string().uuid(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      console.log(`[retailerPortal.ordersCancel] retailerId=${ctx.retailerId} orderId=${input.orderId}`);
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Verify ownership + status
      const [order] = await database
        .select({ id: orders.id, status: orders.status, retailerId: orders.retailerId })
        .from(orders)
        .where(and(eq(orders.id, input.orderId), eq(orders.retailerId, ctx.retailerId)))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
      if (order.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Solo ordini in stato 'pending' possono essere annullati" });
      }

      // Use state machine for transition
      await transitionOrder({
        orderId: input.orderId,
        toStatus: "cancelled",
        actorUserId: ctx.user.id,
        reason: input.reason,
      });

      return { success: true };
    }),
});

// ============= EMAIL TEMPLATE =============

function buildCheckoutEmailHtml(params: {
  retailerName: string;
  orderShortId: string;
  items: Array<{ productName: string; quantity: number; unitPriceFinal: string; lineTotalGross: string }>;
  subtotalNet: string;
  vatAmount: string;
  totalGross: string;
  discountPercent: string;
  packageName: string | null;
  paymentTerms: string;
  orderId: string;
}): string {
  const portalUrl = ENV.publicAppUrl ?? "https://gestionale.soketo.it";
  const orderUrl = `${portalUrl}/partner-portal/orders/${params.orderId}`;

  const itemsHtml = params.items
    .map(
      (it) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.productName}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${it.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">€${it.unitPriceFinal}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">€${it.lineTotalGross}</td>
    </tr>`,
    )
    .join("");

  const paymentBlock =
    params.paymentTerms === "on_delivery"
      ? `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:20px 0;">
      <h3 style="margin:0 0 8px;color:#166534;">Pagamento alla consegna</h3>
      <p style="margin:0;color:#15803d;">Il pagamento verrà effettuato al momento della consegna. Stiamo valutando l'ordine, riceverai conferma a breve.</p>
    </div>`
      : `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:20px;margin:20px 0;">
      <h3 style="margin:0 0 12px;color:#1e40af;">Effettua il bonifico per completare l'ordine</h3>
      <table style="width:100%;font-size:14px;">
        <tr><td style="padding:4px 0;color:#6b7280;width:120px;">Beneficiario</td><td style="font-weight:600;">E-Keto Food Srls</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">IBAN</td><td style="font-weight:600;font-family:monospace;">IT17F3609201600552767813646</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">BIC/SWIFT</td><td style="font-weight:600;">QNTOITM2XXX</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Causale</td><td style="font-weight:600;">Ordine SoKeto #${params.orderShortId}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Importo</td><td style="font-weight:600;color:#1e40af;">€${params.totalGross}</td></tr>
      </table>
    </div>`;

  return `
<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:linear-gradient(135deg,#2D5A27 0%,#3a7a32 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">SoKeto</h1>
            <p style="margin:8px 0 0;color:#a8d5a2;font-size:14px;">Riepilogo Ordine</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 16px;font-size:16px;">Ciao <strong>${params.retailerName}</strong>,</p>
            <p style="margin:0 0 24px;color:#4b5563;">Abbiamo ricevuto il tuo ordine <strong>#${params.orderShortId}</strong>. Ecco il riepilogo:</p>
            
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px;">
              <tr style="background:#f9fafb;">
                <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6b7280;">Prodotto</th>
                <th style="padding:10px 12px;text-align:center;font-size:13px;color:#6b7280;">Qtà</th>
                <th style="padding:10px 12px;text-align:right;font-size:13px;color:#6b7280;">Prezzo</th>
                <th style="padding:10px 12px;text-align:right;font-size:13px;color:#6b7280;">Totale</th>
              </tr>
              ${itemsHtml}
            </table>

            <table width="100%" style="margin-bottom:20px;">
              <tr><td style="padding:4px 0;color:#6b7280;">Subtotale netto</td><td style="text-align:right;">€${params.subtotalNet}</td></tr>
              ${params.packageName ? `<tr><td style="padding:4px 0;color:#6b7280;">Sconto ${params.packageName} (${params.discountPercent}%)</td><td style="text-align:right;color:#dc2626;">incluso</td></tr>` : ""}
              <tr><td style="padding:4px 0;color:#6b7280;">IVA</td><td style="text-align:right;">€${params.vatAmount}</td></tr>
              <tr><td style="padding:8px 0;font-weight:700;font-size:16px;border-top:2px solid #e5e7eb;">Totale</td><td style="text-align:right;font-weight:700;font-size:16px;border-top:2px solid #e5e7eb;">€${params.totalGross}</td></tr>
            </table>

            ${paymentBlock}

            <div style="text-align:center;margin-top:24px;">
              <a href="${orderUrl}" style="display:inline-block;background:#2D5A27;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Vedi ordine sul portale</a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">SoKeto — E-Keto Food Srls</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
