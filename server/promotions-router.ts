/**
 * F16 Admin — Promotions CRUD Router
 *
 * Admin panel for creating, editing, and managing promotional banners
 * visible in the retailer Partner Portal.
 */
import { z } from "zod";
import { eq, and, sql, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { promotions, products } from "../drizzle/schema";

export const promotionsRouter = router({
  /** List all promotions for the active company */
  list: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

    const rows = await db.execute<{
      id: string;
      title: string;
      description: string;
      discountPercent: string | null;
      productId: string | null;
      productName: string | null;
      validFrom: string;
      validTo: string;
      isActive: boolean;
      bannerColor: string | null;
      createdAt: string;
    }>(sql`
      SELECT pr.id, pr.title, pr.description,
             pr.discount_percent::text AS "discountPercent",
             pr."productId", p.name AS "productName",
             pr.valid_from::text AS "validFrom",
             pr.valid_to::text AS "validTo",
             pr.is_active AS "isActive",
             pr.banner_color AS "bannerColor",
             pr."createdAt"::text
      FROM promotions pr
      LEFT JOIN products p ON p.id = pr."productId"
      WHERE pr.company_id = ${ctx.activeCompanyId}
      ORDER BY pr."createdAt" DESC
    `);

    return rows;
  }),

  /** Create a new promotion */
  create: adminProcedure
    .input(z.object({
      title: z.string().min(1).max(255),
      description: z.string().default(""),
      discountPercent: z.number().min(0).max(100).nullable().optional(),
      productId: z.string().uuid().nullable().optional(),
      validFrom: z.string(), // ISO date string
      validTo: z.string(),   // ISO date string
      isActive: z.boolean().default(true),
      bannerColor: z.string().max(20).default("#7AB648"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [row] = await db.insert(promotions).values({
        companyId: ctx.activeCompanyId,
        title: input.title,
        description: input.description,
        discountPercent: input.discountPercent != null ? String(input.discountPercent) : null,
        productId: input.productId ?? null,
        validFrom: new Date(input.validFrom),
        validTo: new Date(input.validTo),
        isActive: input.isActive,
        bannerColor: input.bannerColor,
      }).returning();

      return row;
    }),

  /** Update an existing promotion */
  update: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      title: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      discountPercent: z.number().min(0).max(100).nullable().optional(),
      productId: z.string().uuid().nullable().optional(),
      validFrom: z.string().optional(),
      validTo: z.string().optional(),
      isActive: z.boolean().optional(),
      bannerColor: z.string().max(20).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description;
      if (input.discountPercent !== undefined) updates.discountPercent = input.discountPercent != null ? String(input.discountPercent) : null;
      if (input.productId !== undefined) updates.productId = input.productId;
      if (input.validFrom !== undefined) updates.validFrom = new Date(input.validFrom);
      if (input.validTo !== undefined) updates.validTo = new Date(input.validTo);
      if (input.isActive !== undefined) updates.isActive = input.isActive;
      if (input.bannerColor !== undefined) updates.bannerColor = input.bannerColor;

      await db.update(promotions).set(updates).where(eq(promotions.id, input.id));

      return { success: true };
    }),

  /** Delete a promotion */
  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      await db.delete(promotions).where(eq(promotions.id, input.id));

      return { success: true };
    }),

  /** Toggle active status */
  toggleActive: adminProcedure
    .input(z.object({ id: z.string().uuid(), isActive: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      await db.update(promotions).set({ isActive: input.isActive, updatedAt: new Date() }).where(eq(promotions.id, input.id));

      return { success: true };
    }),
});
