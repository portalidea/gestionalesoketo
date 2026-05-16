/**
 * M7-A — Affiliates Router
 * CRUD affiliati + gestione commissioni + report mensile
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, desc, asc, sql, gte, lt, inArray, like, or, count } from "drizzle-orm";
import { router } from "./_core/trpc";
import { staffProcedure, adminProcedure } from "./_core/trpc";
import { getDb } from "./db";
import {
  affiliates,
  affiliateCommissions,
  retailers,
  orders,
} from "../drizzle/schema";

export const affiliatesRouter = router({
  // --- CRUD Affiliates ---

  list: staffProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        search: z.string().optional(),
        status: z.enum(["active", "inactive"]).optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const { page = 1, limit = 20, search, status } = input ?? {};
      const db = (await getDb())!;
      const offset = (page - 1) * limit;

      const conditions: any[] = [];
      if (status) conditions.push(eq(affiliates.status, status));
      if (search) {
        conditions.push(
          or(
            like(affiliates.name, `%${search}%`),
            like(affiliates.email, `%${search}%`),
            like(affiliates.referralCode, `%${search}%`),
          ),
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, [{ total }]] = await Promise.all([
        db
          .select()
          .from(affiliates)
          .where(whereClause)
          .orderBy(desc(affiliates.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(affiliates).where(whereClause),
      ]);

      // For each affiliate, get summary stats
      const itemsWithStats = await Promise.all(
        items.map(async (aff) => {
          const [{ retailerCount }] = await db
            .select({ retailerCount: count() })
            .from(retailers)
            .where(eq(retailers.affiliateId, aff.id));

          const [{ totalCommissions, pendingAmount }] = await db
            .select({
              totalCommissions: count(),
              pendingAmount: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
            })
            .from(affiliateCommissions)
            .where(eq(affiliateCommissions.affiliateId, aff.id));

          return {
            ...aff,
            retailerCount,
            totalCommissions,
            pendingAmount: parseFloat(pendingAmount || "0"),
          };
        }),
      );

      return { items: itemsWithStats, total, page, limit };
    }),

  getById: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const affiliate = await db.select().from(affiliates).where(eq(affiliates.id, input.id)).limit(1).then(r => r[0]);
      if (!affiliate) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Affiliato non trovato" });
      }

      // Get retailers assigned
      const assignedRetailers = await db
        .select({ id: retailers.id, name: retailers.name, city: retailers.city, createdAt: retailers.createdAt })
        .from(retailers)
        .where(eq(retailers.affiliateId, input.id))
        .orderBy(desc(retailers.createdAt));

      // Get commission stats
      const [stats] = await db
        .select({
          totalEarned: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} != 'voided' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          totalPending: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          totalPaid: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'paid' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          totalVoided: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'voided' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          commissionsCount: count(),
        })
        .from(affiliateCommissions)
        .where(eq(affiliateCommissions.affiliateId, input.id));

      return {
        ...affiliate,
        retailers: assignedRetailers,
        stats: {
          totalEarned: parseFloat(stats.totalEarned || "0"),
          totalPending: parseFloat(stats.totalPending || "0"),
          totalPaid: parseFloat(stats.totalPaid || "0"),
          totalVoided: parseFloat(stats.totalVoided || "0"),
          commissionsCount: stats.commissionsCount,
          retailersCount: assignedRetailers.length,
        },
      };
    }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(2),
        email: z.string().email(),
        phone: z.string().optional(),
        taxCode: z.string().optional(),
        vatNumber: z.string().optional(),
        iban: z.string().optional(),
        referralCode: z.string().min(3).max(50),
        firstOrderRate: z.number().min(0).max(100).default(10),
        recurringRate: z.number().min(0).max(100).default(5),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = (await getDb())!;

      // Check referralCode uniqueness
      const existing = await db.select().from(affiliates).where(eq(affiliates.referralCode, input.referralCode)).limit(1).then(r => r[0]);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Codice referral "${input.referralCode}" già in uso`,
        });
      }

      const [created] = await db
        .insert(affiliates)
        .values({
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          taxCode: input.taxCode ?? null,
          vatNumber: input.vatNumber ?? null,
          iban: input.iban ?? null,
          referralCode: input.referralCode,
          firstOrderRate: input.firstOrderRate.toFixed(2),
          recurringRate: input.recurringRate.toFixed(2),
          notes: input.notes ?? null,
        })
        .returning();

      return created;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(2).optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        taxCode: z.string().optional(),
        vatNumber: z.string().optional(),
        iban: z.string().optional(),
        referralCode: z.string().min(3).max(50).optional(),
        firstOrderRate: z.number().min(0).max(100).optional(),
        recurringRate: z.number().min(0).max(100).optional(),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const { id, ...data } = input;

      // Check referralCode uniqueness if changing
      if (data.referralCode) {
        const existing = await db.select().from(affiliates).where(and(eq(affiliates.referralCode, data.referralCode), sql`${affiliates.id} != ${id}`)).limit(1).then(r => r[0]);
        if (existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Codice referral "${data.referralCode}" già in uso`,
          });
        }
      }

      const updateValues: Record<string, any> = { updatedAt: new Date() };
      if (data.name !== undefined) updateValues.name = data.name;
      if (data.email !== undefined) updateValues.email = data.email;
      if (data.phone !== undefined) updateValues.phone = data.phone;
      if (data.taxCode !== undefined) updateValues.taxCode = data.taxCode;
      if (data.vatNumber !== undefined) updateValues.vatNumber = data.vatNumber;
      if (data.iban !== undefined) updateValues.iban = data.iban;
      if (data.referralCode !== undefined) updateValues.referralCode = data.referralCode;
      if (data.firstOrderRate !== undefined) updateValues.firstOrderRate = data.firstOrderRate.toFixed(2);
      if (data.recurringRate !== undefined) updateValues.recurringRate = data.recurringRate.toFixed(2);
      if (data.notes !== undefined) updateValues.notes = data.notes;

      const [updated] = await db
        .update(affiliates)
        .set(updateValues)
        .where(eq(affiliates.id, id))
        .returning();

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Affiliato non trovato" });
      }
      return updated;
    }),

  toggleStatus: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const affiliate = await db.select().from(affiliates).where(eq(affiliates.id, input.id)).limit(1).then(r => r[0]);
      if (!affiliate) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Affiliato non trovato" });
      }

      const newStatus = affiliate.status === "active" ? "inactive" : "active";
      const [updated] = await db
        .update(affiliates)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(affiliates.id, input.id))
        .returning();

      return updated;
    }),

  // --- Commissions ---

  commissionsList: staffProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(30),
        affiliateId: z.string().uuid().optional(),
        retailerId: z.string().uuid().optional(),
        status: z.enum(["pending", "paid", "voided"]).optional(),
        month: z.string().optional(), // "2026-05" format
      }).optional(),
    )
    .query(async ({ input }) => {
      const { page = 1, limit = 30, affiliateId, retailerId, status, month } = input ?? {};
      const db = (await getDb())!;
      const offset = (page - 1) * limit;

      const conditions: any[] = [];
      if (affiliateId) conditions.push(eq(affiliateCommissions.affiliateId, affiliateId));
      if (retailerId) conditions.push(eq(affiliateCommissions.retailerId, retailerId));
      if (status) conditions.push(eq(affiliateCommissions.status, status));
      if (month) {
        const startDate = new Date(`${month}-01T00:00:00Z`);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1);
        conditions.push(gte(affiliateCommissions.pendingAt, startDate));
        conditions.push(lt(affiliateCommissions.pendingAt, endDate));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, [{ total }]] = await Promise.all([
        db
          .select({
            id: affiliateCommissions.id,
            affiliateId: affiliateCommissions.affiliateId,
            affiliateName: affiliates.name,
            orderId: affiliateCommissions.orderId,
            orderNumber: orders.orderNumber,
            retailerId: affiliateCommissions.retailerId,
            retailerName: retailers.name,
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
          .innerJoin(affiliates, eq(affiliateCommissions.affiliateId, affiliates.id))
          .innerJoin(orders, eq(affiliateCommissions.orderId, orders.id))
          .innerJoin(retailers, eq(affiliateCommissions.retailerId, retailers.id))
          .where(whereClause)
          .orderBy(desc(affiliateCommissions.pendingAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(affiliateCommissions).where(whereClause),
      ]);

      return { items, total, page, limit };
    }),

  markPaid: adminProcedure
    .input(
      z.object({
        commissionIds: z.array(z.string().uuid()).min(1),
        paymentReference: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = (await getDb())!;

      const result = await db
        .update(affiliateCommissions)
        .set({
          status: "paid",
          paidAt: new Date(),
          paymentReference: input.paymentReference,
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(affiliateCommissions.id, input.commissionIds),
            eq(affiliateCommissions.status, "pending"),
          ),
        );

      return { updated: input.commissionIds.length };
    }),

  monthlyReport: staffProcedure
    .input(
      z.object({
        month: z.string(), // "2026-05" format
      }),
    )
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const startDate = new Date(`${input.month}-01T00:00:00Z`);
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);

      // Aggregate by affiliate
      const report = await db
        .select({
          affiliateId: affiliateCommissions.affiliateId,
          affiliateName: affiliates.name,
          affiliateIban: affiliates.iban,
          totalPending: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          totalPaid: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'paid' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          totalVoided: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'voided' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          commissionsCount: count(),
          firstOrderCount: sql<number>`SUM(CASE WHEN ${affiliateCommissions.isFirstOrder} = true THEN 1 ELSE 0 END)::int`,
          recurringCount: sql<number>`SUM(CASE WHEN ${affiliateCommissions.isFirstOrder} = false THEN 1 ELSE 0 END)::int`,
        })
        .from(affiliateCommissions)
        .innerJoin(affiliates, eq(affiliateCommissions.affiliateId, affiliates.id))
        .where(
          and(
            gte(affiliateCommissions.pendingAt, startDate),
            lt(affiliateCommissions.pendingAt, endDate),
          ),
        )
        .groupBy(affiliateCommissions.affiliateId, affiliates.name, affiliates.iban);

      // Grand totals
      const [totals] = await db
        .select({
          grandTotalPending: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          grandTotalPaid: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'paid' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          grandTotalVoided: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'voided' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          grandTotal: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} != 'voided' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
          totalOrders: count(),
        })
        .from(affiliateCommissions)
        .where(
          and(
            gte(affiliateCommissions.pendingAt, startDate),
            lt(affiliateCommissions.pendingAt, endDate),
          ),
        );

      return {
        month: input.month,
        affiliates: report.map((r) => ({
          ...r,
          totalPending: parseFloat(r.totalPending || "0"),
          totalPaid: parseFloat(r.totalPaid || "0"),
          totalVoided: parseFloat(r.totalVoided || "0"),
        })),
        totals: {
          grandTotalPending: parseFloat(totals.grandTotalPending || "0"),
          grandTotalPaid: parseFloat(totals.grandTotalPaid || "0"),
          grandTotalVoided: parseFloat(totals.grandTotalVoided || "0"),
          grandTotal: parseFloat(totals.grandTotal || "0"),
          totalOrders: totals.totalOrders,
        },
      };
    }),
});
