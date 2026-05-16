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
import * as db from "./db";
import { supabaseAdmin } from "./_core/supabase";
import { ENV } from "./_core/env";
import { sendEmail } from "./email";
import {
  affiliates,
  affiliateCommissions,
  retailers,
  orders,
  users,
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

  // --- Invite / Users Management (M7-B) ---

  inviteUser: adminProcedure
    .input(
      z.object({
        affiliateId: z.string().uuid(),
        email: z.string().email(),
        name: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const database = (await getDb())!;

      // Verify affiliate exists and is active
      const [affiliate] = await database
        .select()
        .from(affiliates)
        .where(eq(affiliates.id, input.affiliateId))
        .limit(1);

      if (!affiliate) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Affiliato non trovato" });
      }
      if (affiliate.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Affiliato non attivo" });
      }

      // Check if email already taken by another affiliate user
      const existingUsers = await database
        .select()
        .from(users)
        .where(eq(users.email, input.email.toLowerCase()))
        .limit(1);

      if (existingUsers.length > 0) {
        const existing = existingUsers[0];
        if (existing.affiliateId === input.affiliateId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Utente già invitato per questo affiliato. Usa 'Rinvia invito'.",
          });
        } else {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Email già associata ad altro account.",
          });
        }
      }

      // Create auth user in Supabase
      let authUserId: string | null = null;
      try {
        console.log('[affiliateInvite] creating supabase auth user');
        const { data: authData, error: authError } =
          await supabaseAdmin.auth.admin.createUser({
            email: input.email,
            email_confirm: false,
            user_metadata: {
              affiliate_id: input.affiliateId,
              role: "affiliate_user",
              name: input.name || null,
            },
          });

        if (authError && !authError.message.includes('already')) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Errore nella creazione dell'account.",
          });
        }

        if (authError && authError.message.includes('already')) {
          const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
          const existing = listData?.users?.find(
            (u) => u.email?.toLowerCase() === input.email.toLowerCase(),
          );
          if (!existing) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Utente auth esistente ma non trovato.",
            });
          }
          authUserId = existing.id;
        } else {
          authUserId = authData?.user?.id ?? null;
          if (!authUserId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Errore nella creazione dell'account: ID non disponibile.",
            });
          }
        }

        // Upsert in public.users
        const upsertedUser = await db.createAffiliateUser({
          id: authUserId,
          email: input.email,
          name: input.name || null,
          role: "affiliate_user",
          affiliateId: input.affiliateId,
        });

        // Generate magic link
        console.log('[affiliateInvite] generating magic link');
        const { data: linkData, error: linkError } =
          await supabaseAdmin.auth.admin.generateLink({
            type: "magiclink",
            email: input.email,
          });

        let customMagicUrl = "";
        if (!linkError && linkData?.properties?.hashed_token) {
          const tokenHash = linkData.properties.hashed_token;
          const baseUrl = ENV.publicAppUrl;
          customMagicUrl = `${baseUrl}/auth/verify` +
            `?token_hash=${encodeURIComponent(tokenHash)}` +
            `&type=magiclink` +
            `&email=${encodeURIComponent(input.email)}`;
        } else {
          console.warn('[affiliateInvite] generateLink failed', linkError?.message);
        }

        // Send invite email
        if (customMagicUrl) {
          await sendEmail({
            to: input.email,
            subject: "Sei stato invitato al portale Affiliati SoKeto",
            html: buildAffiliateInviteEmailHtml({
              affiliateName: affiliate.name,
              userName: input.name || "Affiliato",
              referralCode: affiliate.referralCode,
              firstOrderRate: affiliate.firstOrderRate,
              recurringRate: affiliate.recurringRate,
              magicLink: customMagicUrl,
            }),
            from: "SoKeto Partner <partner@sm.soketo.it>",
          });
        }

        return {
          userId: authUserId,
          magicLinkSent: Boolean(customMagicUrl),
        };
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        console.error('[affiliateInvite] unexpected error', error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Errore durante l'invito. Riprova.",
        });
      }
    }),

  resendInvite: adminProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = (await getDb())!;

      const [user] = await database
        .select()
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);

      if (!user || !user.affiliateId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Utente affiliato non trovato" });
      }

      const [affiliate] = await database
        .select()
        .from(affiliates)
        .where(eq(affiliates.id, user.affiliateId))
        .limit(1);

      // Generate new magic link
      const { data: linkData, error: linkError } =
        await supabaseAdmin.auth.admin.generateLink({
          type: "magiclink",
          email: user.email,
        });

      let customMagicUrl = "";
      if (!linkError && linkData?.properties?.hashed_token) {
        const tokenHash = linkData.properties.hashed_token;
        const baseUrl = ENV.publicAppUrl;
        customMagicUrl = `${baseUrl}/auth/verify` +
          `?token_hash=${encodeURIComponent(tokenHash)}` +
          `&type=magiclink` +
          `&email=${encodeURIComponent(user.email)}`;
      }

      if (customMagicUrl) {
        await sendEmail({
          to: user.email,
          subject: "Accedi al portale Affiliati SoKeto",
          html: buildAffiliateInviteEmailHtml({
            affiliateName: affiliate?.name || "Affiliato",
            userName: user.name || "Affiliato",
            referralCode: affiliate?.referralCode || "",
            firstOrderRate: affiliate?.firstOrderRate || "10.00",
            recurringRate: affiliate?.recurringRate || "5.00",
            magicLink: customMagicUrl,
          }),
          from: "SoKeto Partner <partner@sm.soketo.it>",
        });
      }

      return { magicLinkSent: Boolean(customMagicUrl) };
    }),

  listUsers: staffProcedure
    .input(z.object({ affiliateId: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = (await getDb())!;

      const affiliateUsers = await database
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.affiliateId, input.affiliateId))
        .orderBy(users.createdAt);

      // Get last sign in from Supabase Auth for each user
      const result = await Promise.all(
        affiliateUsers.map(async (u) => {
          let lastSignInAt: Date | null = null;
          try {
            const { data } = await supabaseAdmin.auth.admin.getUserById(u.userId);
            lastSignInAt = data?.user?.last_sign_in_at
              ? new Date(data.user.last_sign_in_at)
              : null;
          } catch { /* ignore */ }
          return {
            userId: u.userId,
            email: u.email,
            name: u.name,
            lastSignInAt,
            createdAt: u.createdAt,
            status: lastSignInAt ? ("active" as const) : ("invited" as const),
          };
        }),
      );

      return result;
    }),
});

// ═══════════════════════════════════════════════════════════════
// Email template helper
// ═══════════════════════════════════════════════════════════════

function buildAffiliateInviteEmailHtml(opts: {
  affiliateName: string;
  userName: string;
  referralCode: string;
  firstOrderRate: string;
  recurringRate: string;
  magicLink: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #16a34a; font-size: 24px; margin: 0;">SoKeto</h1>
    <p style="color: #666; margin: 5px 0 0;">Programma Affiliati</p>
  </div>
  
  <p>Ciao <strong>${opts.userName}</strong>,</p>
  
  <p>Sei stato invitato a entrare nel <strong>Programma Affiliati SoKeto</strong>. 
  Attraverso il portale dedicato potrai monitorare le tue commissioni, 
  visualizzare i retailer associati e gestire i tuoi dati di contatto.</p>
  
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #f8faf8; border-radius: 8px;">
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Codice Referral</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb;">${opts.referralCode}</td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Commissione primo ordine</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb;">${opts.firstOrderRate}%</td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; font-weight: 600;">Commissione ordini successivi</td>
      <td style="padding: 12px 16px;">${opts.recurringRate}%</td>
    </tr>
  </table>
  
  <div style="text-align: center; margin: 30px 0;">
    <a href="${opts.magicLink}" 
       style="display: inline-block; padding: 14px 32px; background: #16a34a; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
      Accedi al Portale
    </a>
  </div>
  
  <p style="color: #666; font-size: 13px;">
    Se il pulsante non funziona, copia e incolla questo link nel browser:<br>
    <a href="${opts.magicLink}" style="color: #16a34a; word-break: break-all;">${opts.magicLink}</a>
  </p>
  
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
  
  <p style="color: #999; font-size: 12px; text-align: center;">
    SoKeto S.r.l. — Programma Affiliati<br>
    Per assistenza: partner@sm.soketo.it
  </p>
</body>
</html>`;
}
