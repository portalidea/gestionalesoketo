import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  calculateProspectSimulation,
  createProspectSimulation,
  enforceProspectRateLimit,
  getProspectSimulatorConfig,
  getPublicProspectCatalog,
  getProspectSimulationDetail,
  listProspectSimulations,
  requestIp,
} from "./services/prospectSimulationService";

const cartItemsInput = z.array(z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
})).min(1).max(100);

const contactInput = z.object({
  legalName: z.string().trim().min(1).max(250),
  contactName: z.string().trim().min(1).max(250),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50),
  businessType: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  vatNumber: z.string().trim().min(1).max(20),
  privacyAccepted: z.literal(true),
  website: z.string().max(200).optional().default(""),
  items: cartItemsInput,
});

function clientIp(ctx: { req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } } }) {
  return requestIp(ctx.req.headers, ctx.req.socket?.remoteAddress);
}

async function requireDatabase() {
  const database = await getDb();
  if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });
  return database;
}

/** Modulo pubblico separato dal pricing e dai tier dei rivenditori attivi. */
export const prospectSimulatorRouter = router({
  getPublicData: publicProcedure.query(async ({ ctx }) => {
    enforceProspectRateLimit(`prospect:catalog:${clientIp(ctx as never)}`, 60, 10 * 60_000);
    const database = await requireDatabase();
    const [config, catalog] = await Promise.all([
      getProspectSimulatorConfig(database),
      getPublicProspectCatalog(database),
    ]);
    return {
      config: {
        minimumOrderNet: config.minimumOrderNet,
        shippingFeeNet: config.shippingFeeNet,
        freeShippingThresholdNet: config.freeShippingThresholdNet,
        recommendedPublicDiscountPercent: config.recommendedPublicDiscountPercent,
        displayStandThreshold: config.displayStandThreshold,
        privacyPolicyUrl: config.privacyPolicyUrl,
        tiers: config.tiers,
      },
      products: catalog,
    };
  }),

  calculate: publicProcedure.input(z.object({ items: cartItemsInput })).query(async ({ ctx, input }) => {
    enforceProspectRateLimit(`prospect:calculate:${clientIp(ctx as never)}`, 120, 10 * 60_000);
    const database = await requireDatabase();
    const [config, catalog] = await Promise.all([
      getProspectSimulatorConfig(database),
      getPublicProspectCatalog(database),
    ]);
    return calculateProspectSimulation(config, catalog, input.items);
  }),

  submit: publicProcedure.input(contactInput).mutation(async ({ ctx, input }) => {
    enforceProspectRateLimit(`prospect:submit:${clientIp(ctx as never)}`, 5, 60 * 60_000);
    const database = await requireDatabase();
    return createProspectSimulation(database, input);
  }),

  adminList: adminProcedure.query(async ({ ctx }) => {
    const database = await requireDatabase();
    return listProspectSimulations(database, ctx.activeCompanyId);
  }),

  adminGetById: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const database = await requireDatabase();
    return getProspectSimulationDetail(database, ctx.activeCompanyId, input.id);
  }),
});
