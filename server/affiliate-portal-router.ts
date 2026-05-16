/**
 * M7-B — Affiliate Portal Router
 * Self-service portal for affiliates: dashboard, commissions, profile.
 * All procedures use affiliateProcedure (hard-filtered by ctx.affiliateId).
 */
import { router } from "./_core/trpc";
import { affiliateProcedure } from "./_core/trpc";
import { z } from "zod";
import { getDb } from "./db";
import {
  affiliates,
  affiliateCommissions,
  orders,
  retailers,
  orderItems,
  products,
} from "../drizzle/schema";
import { eq, and, gte, lt, desc, asc, count, sql, inArray } from "drizzle-orm";

export const affiliatePortalRouter = router({
  // ═══════════════════════════════════════════════════════════════
  // Dashboard
  // ═══════════════════════════════════════════════════════════════

  dashboardStats: affiliateProcedure.query(async ({ ctx }) => {
    const db = (await getDb())!;
    const affiliateId = ctx.affiliateId;

    // Aggregate commission amounts by status
    const [stats] = await db
      .select({
        totalEarned: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'paid' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
        totalPending: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
        totalVoided: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'voided' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
        pendingCount: sql<number>`SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN 1 ELSE 0 END)::int`,
        paidCount: sql<number>`SUM(CASE WHEN ${affiliateCommissions.status} = 'paid' THEN 1 ELSE 0 END)::int`,
        voidedCount: sql<number>`SUM(CASE WHEN ${affiliateCommissions.status} = 'voided' THEN 1 ELSE 0 END)::int`,
      })
      .from(affiliateCommissions)
      .where(eq(affiliateCommissions.affiliateId, affiliateId));

    // Retailers count
    const [retailersResult] = await db
      .select({ count: count() })
      .from(retailers)
      .where(eq(retailers.affiliateId, affiliateId));

    // Last payment
    const lastPayment = await db
      .select({
        paidAt: affiliateCommissions.paidAt,
        commissionAmount: affiliateCommissions.commissionAmount,
      })
      .from(affiliateCommissions)
      .where(
        and(
          eq(affiliateCommissions.affiliateId, affiliateId),
          eq(affiliateCommissions.status, "paid"),
        ),
      )
      .orderBy(desc(affiliateCommissions.paidAt))
      .limit(1)
      .then((r) => r[0] ?? null);

    return {
      totalEarned: parseFloat(stats.totalEarned || "0"),
      totalPending: parseFloat(stats.totalPending || "0"),
      totalVoided: parseFloat(stats.totalVoided || "0"),
      retailersCount: retailersResult.count,
      commissionsCount: {
        pending: stats.pendingCount ?? 0,
        paid: stats.paidCount ?? 0,
        voided: stats.voidedCount ?? 0,
      },
      lastPaymentDate: lastPayment?.paidAt ?? null,
      lastPaymentAmount: lastPayment
        ? parseFloat(String(lastPayment.commissionAmount))
        : null,
    };
  }),

  dashboardMonthlyChart: affiliateProcedure
    .input(z.object({ months: z.number().min(1).max(24).default(12) }).optional())
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const affiliateId = ctx.affiliateId;
      const monthsBack = input?.months ?? 12;

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - monthsBack + 1);
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);

      const rawData = await db
        .select({
          month: sql<string>`to_char(${affiliateCommissions.pendingAt}, 'YYYY-MM')`,
          paidAmount: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'paid' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          pendingAmount: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          commissionsCount: count(),
        })
        .from(affiliateCommissions)
        .where(
          and(
            eq(affiliateCommissions.affiliateId, affiliateId),
            gte(affiliateCommissions.pendingAt, startDate),
          ),
        )
        .groupBy(sql`to_char(${affiliateCommissions.pendingAt}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${affiliateCommissions.pendingAt}, 'YYYY-MM')`);

      // Fill missing months with zeros
      const result: Array<{
        month: string;
        paidAmount: number;
        pendingAmount: number;
        commissionsCount: number;
      }> = [];

      const now = new Date();
      for (let i = 0; i < monthsBack; i++) {
        const d = new Date(startDate);
        d.setMonth(startDate.getMonth() + i);
        if (d > now) break;
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const existing = rawData.find((r) => r.month === monthKey);
        result.push({
          month: monthKey,
          paidAmount: existing ? parseFloat(existing.paidAmount) : 0,
          pendingAmount: existing ? parseFloat(existing.pendingAmount) : 0,
          commissionsCount: existing ? existing.commissionsCount : 0,
        });
      }

      return result;
    }),

  dashboardRetailersBreakdown: affiliateProcedure.query(async ({ ctx }) => {
    const db = (await getDb())!;
    const affiliateId = ctx.affiliateId;

    const breakdown = await db
      .select({
        retailerId: retailers.id,
        retailerName: retailers.name,
        affiliateAssignedAt: retailers.affiliateAssignedAt,
        totalOrders: sql<number>`COUNT(DISTINCT ${affiliateCommissions.orderId})::int`,
        totalCommissionAmount: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} != 'voided' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
        lastOrderDate: sql<Date | null>`MAX(${affiliateCommissions.pendingAt})`,
      })
      .from(retailers)
      .leftJoin(
        affiliateCommissions,
        and(
          eq(affiliateCommissions.retailerId, retailers.id),
          eq(affiliateCommissions.affiliateId, affiliateId),
        ),
      )
      .where(eq(retailers.affiliateId, affiliateId))
      .groupBy(retailers.id, retailers.name, retailers.affiliateAssignedAt);

    return breakdown.map((r) => ({
      retailerId: r.retailerId,
      retailerName: r.retailerName,
      affiliateAssignedAt: r.affiliateAssignedAt,
      totalOrders: r.totalOrders ?? 0,
      totalCommissionAmount: parseFloat(String(r.totalCommissionAmount) || "0"),
      lastOrderDate: r.lastOrderDate,
    }));
  }),

  // ═══════════════════════════════════════════════════════════════
  // Commissions
  // ═══════════════════════════════════════════════════════════════

  commissionsList: affiliateProcedure
    .input(
      z.object({
        status: z.array(z.enum(["pending", "paid", "voided"])).optional(),
        retailerId: z.string().uuid().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        sortBy: z.enum(["date", "amount"]).default("date"),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().min(1).max(100).default(30),
        offset: z.number().min(0).default(0),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const affiliateId = ctx.affiliateId;
      const {
        status,
        retailerId,
        dateFrom,
        dateTo,
        sortBy = "date",
        sortOrder = "desc",
        limit = 30,
        offset = 0,
      } = input ?? {};

      const conditions: any[] = [eq(affiliateCommissions.affiliateId, affiliateId)];
      if (status && status.length > 0) {
        conditions.push(inArray(affiliateCommissions.status, status));
      }
      if (retailerId) {
        conditions.push(eq(affiliateCommissions.retailerId, retailerId));
      }
      if (dateFrom) {
        conditions.push(gte(affiliateCommissions.pendingAt, new Date(dateFrom)));
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setDate(toDate.getDate() + 1);
        conditions.push(lt(affiliateCommissions.pendingAt, toDate));
      }

      const whereClause = and(...conditions);

      const orderByCol =
        sortBy === "amount" ? affiliateCommissions.commissionAmount : affiliateCommissions.pendingAt;
      const orderByDir = sortOrder === "asc" ? asc(orderByCol) : desc(orderByCol);

      const [items, [{ totalCount }], [{ totalAmount }]] = await Promise.all([
        db
          .select({
            id: affiliateCommissions.id,
            retailerName: retailers.name,
            retailerId: affiliateCommissions.retailerId,
            orderNumber: orders.orderNumber,
            orderDate: orders.createdAt,
            orderTotal: affiliateCommissions.orderTotal,
            commissionRate: affiliateCommissions.commissionRate,
            commissionAmount: affiliateCommissions.commissionAmount,
            isFirstOrder: affiliateCommissions.isFirstOrder,
            status: affiliateCommissions.status,
            pendingAt: affiliateCommissions.pendingAt,
            paidAt: affiliateCommissions.paidAt,
            paymentReference: affiliateCommissions.paymentReference,
            voidedAt: affiliateCommissions.voidedAt,
            voidedReason: affiliateCommissions.voidedReason,
          })
          .from(affiliateCommissions)
          .innerJoin(retailers, eq(affiliateCommissions.retailerId, retailers.id))
          .innerJoin(orders, eq(affiliateCommissions.orderId, orders.id))
          .where(whereClause)
          .orderBy(orderByDir)
          .limit(limit)
          .offset(offset),
        db
          .select({ totalCount: count() })
          .from(affiliateCommissions)
          .where(whereClause),
        db
          .select({
            totalAmount: sql<string>`COALESCE(SUM(${affiliateCommissions.commissionAmount}::numeric), 0)`,
          })
          .from(affiliateCommissions)
          .where(whereClause),
      ]);

      return {
        items,
        totalCount: totalCount,
        totalAmount: parseFloat(totalAmount || "0"),
      };
    }),

  commissionsGetById: affiliateProcedure
    .input(z.object({ commissionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const affiliateId = ctx.affiliateId;

      const [commission] = await db
        .select({
          id: affiliateCommissions.id,
          affiliateId: affiliateCommissions.affiliateId,
          retailerId: affiliateCommissions.retailerId,
          retailerName: retailers.name,
          orderId: affiliateCommissions.orderId,
          orderNumber: orders.orderNumber,
          orderDate: orders.createdAt,
          orderTotal: affiliateCommissions.orderTotal,
          commissionRate: affiliateCommissions.commissionRate,
          commissionAmount: affiliateCommissions.commissionAmount,
          isFirstOrder: affiliateCommissions.isFirstOrder,
          status: affiliateCommissions.status,
          pendingAt: affiliateCommissions.pendingAt,
          paidAt: affiliateCommissions.paidAt,
          paymentReference: affiliateCommissions.paymentReference,
          voidedAt: affiliateCommissions.voidedAt,
          voidedReason: affiliateCommissions.voidedReason,
        })
        .from(affiliateCommissions)
        .innerJoin(retailers, eq(affiliateCommissions.retailerId, retailers.id))
        .innerJoin(orders, eq(affiliateCommissions.orderId, orders.id))
        .where(
          and(
            eq(affiliateCommissions.id, input.commissionId),
            eq(affiliateCommissions.affiliateId, affiliateId),
          ),
        )
        .limit(1);

      if (!commission) {
        const { TRPCError } = await import("@trpc/server");
        throw new TRPCError({ code: "NOT_FOUND", message: "Commissione non trovata" });
      }

      // Get order items
      const items = await db
        .select({
          productName: products.name,
          quantity: orderItems.quantity,
          unitPrice: orderItems.unitPriceFinal,
          totalPrice: orderItems.lineTotalNet,
        })
        .from(orderItems)
        .innerJoin(products, eq(orderItems.productId, products.id))
        .where(eq(orderItems.orderId, commission.orderId));

      return {
        ...commission,
        order: {
          id: commission.orderId,
          number: commission.orderNumber,
          date: commission.orderDate,
          totalNet: commission.orderTotal,
          items,
        },
        retailer: {
          id: commission.retailerId,
          name: commission.retailerName,
        },
      };
    }),

  commissionsExportCSV: affiliateProcedure
    .input(
      z.object({
        status: z.array(z.enum(["pending", "paid", "voided"])).optional(),
        retailerId: z.string().uuid().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      }).optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const affiliateId = ctx.affiliateId;

      const conditions: any[] = [eq(affiliateCommissions.affiliateId, affiliateId)];
      if (input?.status && input.status.length > 0) {
        conditions.push(inArray(affiliateCommissions.status, input.status));
      }
      if (input?.retailerId) {
        conditions.push(eq(affiliateCommissions.retailerId, input.retailerId));
      }
      if (input?.dateFrom) {
        conditions.push(gte(affiliateCommissions.pendingAt, new Date(input.dateFrom)));
      }
      if (input?.dateTo) {
        const toDate = new Date(input.dateTo);
        toDate.setDate(toDate.getDate() + 1);
        conditions.push(lt(affiliateCommissions.pendingAt, toDate));
      }

      const items = await db
        .select({
          pendingAt: affiliateCommissions.pendingAt,
          orderNumber: orders.orderNumber,
          retailerName: retailers.name,
          orderTotal: affiliateCommissions.orderTotal,
          commissionRate: affiliateCommissions.commissionRate,
          commissionAmount: affiliateCommissions.commissionAmount,
          status: affiliateCommissions.status,
          paymentReference: affiliateCommissions.paymentReference,
        })
        .from(affiliateCommissions)
        .innerJoin(retailers, eq(affiliateCommissions.retailerId, retailers.id))
        .innerJoin(orders, eq(affiliateCommissions.orderId, orders.id))
        .where(and(...conditions))
        .orderBy(desc(affiliateCommissions.pendingAt));

      const statusLabel = (s: string) => {
        switch (s) {
          case "pending": return "In attesa";
          case "paid": return "Pagata";
          case "voided": return "Annullata";
          default: return s;
        }
      };

      const header = "Data,Ordine,Rivenditore,Totale Ordine,Tasso %,Importo,Stato,Riferimento Pagamento";
      const rows = items.map((i) =>
        [
          i.pendingAt ? new Date(i.pendingAt).toLocaleDateString("it-IT") : "",
          i.orderNumber || "",
          `"${(i.retailerName || "").replace(/"/g, '""')}"`,
          Number(i.orderTotal).toFixed(2),
          i.commissionRate,
          Number(i.commissionAmount).toFixed(2),
          statusLabel(i.status),
          `"${(i.paymentReference || "").replace(/"/g, '""')}"`,
        ].join(","),
      );

      const csvContent = [header, ...rows].join("\n");
      const now = new Date();
      const filename = `commissioni_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}.csv`;

      return { csvContent, filename };
    }),

  // ═══════════════════════════════════════════════════════════════
  // Profile
  // ═══════════════════════════════════════════════════════════════

  profileGet: affiliateProcedure.query(async ({ ctx }) => {
    const db = (await getDb())!;
    const affiliateId = ctx.affiliateId;

    const [affiliate] = await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.id, affiliateId))
      .limit(1);

    if (!affiliate) {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "NOT_FOUND", message: "Profilo affiliato non trovato" });
    }

    return {
      name: affiliate.name,
      email: affiliate.email,
      phone: affiliate.phone,
      iban: affiliate.iban,
      referralCode: affiliate.referralCode,
      firstOrderRate: affiliate.firstOrderRate,
      recurringRate: affiliate.recurringRate,
      taxCode: affiliate.taxCode,
      vatNumber: affiliate.vatNumber,
      status: affiliate.status,
      createdAt: affiliate.createdAt,
    };
  }),

  profileUpdateContact: affiliateProcedure
    .input(
      z.object({
        phone: z.string().max(50).optional(),
        iban: z.string().max(34).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const affiliateId = ctx.affiliateId;

      // IBAN validation (basic EU format)
      if (input.iban && input.iban.length > 0) {
        const ibanClean = input.iban.replace(/\s/g, "").toUpperCase();
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(ibanClean)) {
          const { TRPCError } = await import("@trpc/server");
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Formato IBAN non valido. Esempio: IT60X0542811101000000123456",
          });
        }
        input.iban = ibanClean;
      }

      // Phone validation (basic)
      if (input.phone && input.phone.length > 0) {
        const phoneClean = input.phone.replace(/\s/g, "");
        if (!/^\+?[\d\s\-()]{6,20}$/.test(phoneClean)) {
          const { TRPCError } = await import("@trpc/server");
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Formato telefono non valido.",
          });
        }
      }

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (input.phone !== undefined) updateData.phone = input.phone || null;
      if (input.iban !== undefined) updateData.iban = input.iban || null;

      await db.update(affiliates).set(updateData).where(eq(affiliates.id, affiliateId));

      // Audit log for IBAN change
      if (input.iban !== undefined) {
        console.log(
          `[affiliatePortal.profileUpdateContact] IBAN updated for affiliate=${affiliateId} by user=${ctx.user.id}`,
        );
      }

      return { success: true };
    }),
});
