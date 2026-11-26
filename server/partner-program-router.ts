/**
 * Programma Partner SoKeto — API (migration 0053).
 * - rivenditore: borsellino, estratti mensili e dettaglio convalide (sola lettura)
 * - staff: riepilogo, abbinamento negozio app ↔ rivenditore, sync e chiusura manuale
 */
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { partnerProgramSettings, retailers } from "../drizzle/schema";
import { adminProcedure, retailerProcedure, router, staffProcedure, staffProcedureLongRunning } from "./_core/trpc";
import { getDb } from "./db";
import {
  addMonths,
  closePartnerProgramMonth,
  exportConfig,
  fetchFoodappsStores,
  getPartnerProgramAdminOverview,
  getPartnerProgramSettings,
  getRetailerPartnerProgramEvents,
  getRetailerPartnerProgramOverview,
  romeMonthStart,
  syncPartnerProgramEvents,
} from "./services/partnerProgramService";
import { uuidSchema } from "../shared/schemas";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
  return db;
}

function requireAdminRole(role: string | undefined) {
  if (role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Solo gli amministratori" });
}

const vatRateSchema = z.enum(["4.00", "5.00", "10.00", "22.00"]);

export const partnerProgramRouter = router({
  // ───────── Rivenditore ─────────
  myOverview: retailerProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return getRetailerPartnerProgramOverview(db, ctx.retailerId);
  }),

  myEvents: retailerProcedure
    .input(z.object({ statementId: uuidSchema.optional() }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      return getRetailerPartnerProgramEvents(db, ctx.retailerId, { statementId: input.statementId });
    }),

  // ───────── Staff ─────────
  adminOverview: staffProcedure.query(async () => {
    const db = await requireDb();
    return getPartnerProgramAdminOverview(db);
  }),

  retailerOverview: staffProcedure
    .input(z.object({ retailerId: uuidSchema }))
    .query(async ({ input }) => {
      const db = await requireDb();
      return getRetailerPartnerProgramOverview(db, input.retailerId);
    }),

  retailerEvents: staffProcedure
    .input(z.object({ retailerId: uuidSchema, statementId: uuidSchema.optional() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      return getRetailerPartnerProgramEvents(db, input.retailerId, { statementId: input.statementId });
    }),

  /** Punti vendita letti in diretta da FoodApps4All. */
  foodappsStores: staffProcedureLongRunning.query(async () => {
    if (!exportConfig()) return { configured: false as const, stores: [] };
    try {
      return { configured: true as const, stores: await fetchFoodappsStores() };
    } catch (err: any) {
      throw new TRPCError({ code: "BAD_GATEWAY", message: `FoodApps4All non raggiungibile: ${err?.message ?? err}` });
    }
  }),

  setRetailerStore: adminProcedure
    .input(z.object({ retailerId: uuidSchema, storeId: z.number().int().positive().nullable() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const settings = await getPartnerProgramSettings(db);
      const [retailer] = await db.select({ id: retailers.id, companyId: retailers.companyId })
        .from(retailers).where(eq(retailers.id, input.retailerId)).limit(1);
      if (!retailer) throw new TRPCError({ code: "NOT_FOUND", message: "Rivenditore non trovato" });
      if (input.storeId != null) {
        if (retailer.companyId !== settings.billingCompanyId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Il negozio app va abbinato all'anagrafica E-Keto del rivenditore: il credito si scala sugli ordini E-Keto.",
          });
        }
        const [taken] = await db.select({ id: retailers.id, name: retailers.name }).from(retailers)
          .where(and(eq(retailers.foodappsStoreId, input.storeId), ne(retailers.id, input.retailerId))).limit(1);
        if (taken) throw new TRPCError({ code: "CONFLICT", message: `Negozio già abbinato a ${taken.name}` });
      }
      await db.update(retailers)
        .set({ foodappsStoreId: input.storeId, updatedAt: new Date() })
        .where(eq(retailers.id, input.retailerId));
      return { success: true };
    }),

  syncNow: staffProcedureLongRunning.mutation(async ({ ctx }) => {
    requireAdminRole(ctx.user?.role);
    if (!exportConfig()) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Collegamento FoodApps4All non configurato (variabili Vercel mancanti)" });
    }
    return syncPartnerProgramEvents();
  }),

  /** Chiude (idempotente) il mese precedente o un mese indicato. */
  closeMonth: staffProcedureLongRunning
    .input(z.object({ periodMonth: z.string().regex(/^\d{4}-\d{2}-01$/).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireAdminRole(ctx.user?.role);
      const periodMonth = input.periodMonth ?? addMonths(romeMonthStart(new Date()), -1);
      try {
        const result = await closePartnerProgramMonth({ periodMonth });
        return { periodMonth, created: result.created.length };
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? String(err) });
      }
    }),

  updateSettings: adminProcedure
    .input(z.object({ creditVatRate: vatRateSchema, contributionVatRate: vatRateSchema }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await db.update(partnerProgramSettings)
        .set({ creditVatRate: input.creditVatRate, contributionVatRate: input.contributionVatRate, updatedAt: new Date() })
        .where(eq(partnerProgramSettings.id, 1));
      return { success: true };
    }),
});
