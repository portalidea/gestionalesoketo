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
import {
  createProspectInvitation,
  listProspectInvitations,
  regenerateProspectInvitation,
  resendProspectInvitation,
  resolvePublicInvitation,
  revokeProspectInvitation,
  submitInvitedProspectOrder,
} from "./services/prospectInvitationService";
import { sendProspectInvitationNotification } from "./services/prospectNotificationService";
import { convertProspectSimulation, previewProspectConversion } from "./services/prospectOrderConversionService";

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

const tokenInput = z.object({ token: z.string().trim().min(1).max(128) });
export const prospectInvitationInput = z.object({
  legalName: z.string().trim().min(1).max(250),
  contactName: z.string().trim().min(1).max(250),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50),
  origin: z.string().url().max(500),
}).strict();
const invitedOrderInput = contactInput.extend({
  token: z.string().trim().min(1).max(128),
  address: z.string().trim().min(1).max(500),
  postalCode: z.string().trim().min(1).max(10),
  province: z.string().trim().length(2),
  notes: z.string().trim().max(3000).optional(),
});

function clientIp(ctx: { req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } } }) {
  return requestIp(ctx.req.headers, ctx.req.socket?.remoteAddress);
}

async function requireDatabase() {
  const database = await getDb();
  if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });
  return database;
}

async function getInvitationConfigOrNull(database: Awaited<ReturnType<typeof requireDatabase>>, companyId: string) {
  try {
    return await getProspectSimulatorConfig(database, companyId);
  } catch (error) {
    if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") return null;
    throw error;
  }
}

/** Modulo pubblico separato dal pricing e dai tier dei rivenditori attivi. */
export const prospectSimulatorRouter = router({
  /** Il catalogo viene esposto solo dopo risoluzione server-side dell'invito. */
  getInvitationPublicData: publicProcedure.input(tokenInput).query(async ({ ctx, input }) => {
    enforceProspectRateLimit(`prospect:invite-open:${clientIp(ctx as never)}`, 30, 10 * 60_000);
    const database = await requireDatabase();
    const tokenState = await resolvePublicInvitation(database, input.token);
    if (!tokenState.available) return { available: false as const };
    const config = await getInvitationConfigOrNull(database, tokenState.invitation.companyId);
    if (!config) return { available: false as const };
    const catalog = await getPublicProspectCatalog(database);
    return {
      available: true as const,
      invitation: tokenState.invitation,
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

  calculateInvitation: publicProcedure.input(z.object({ token: tokenInput.shape.token, items: cartItemsInput })).query(async ({ ctx, input }) => {
    enforceProspectRateLimit(`prospect:invite-calculate:${clientIp(ctx as never)}`, 120, 10 * 60_000);
    const database = await requireDatabase();
    const tokenState = await resolvePublicInvitation(database, input.token);
    if (!tokenState.available) throw new TRPCError({ code: "NOT_FOUND", message: "Link non valido" });
    const config = await getInvitationConfigOrNull(database, tokenState.invitation.companyId);
    if (!config) throw new TRPCError({ code: "NOT_FOUND", message: "Link non valido" });
    const catalog = await getPublicProspectCatalog(database);
    return calculateProspectSimulation(config, catalog, input.items);
  }),

  submitInvitationOrder: publicProcedure.input(invitedOrderInput).mutation(async ({ ctx, input }) => {
    enforceProspectRateLimit(`prospect:invite-submit:${clientIp(ctx as never)}`, 5, 60 * 60_000);
    return submitInvitedProspectOrder(await requireDatabase(), input);
  }),

  /** Legacy public endpoints retained only for a neutral unavailable response. */
  getPublicData: publicProcedure.query(() => { throw new TRPCError({ code: "NOT_FOUND", message: "Accesso disponibile solo tramite invito personale." }); }),
  calculate: publicProcedure.input(z.object({ items: cartItemsInput })).query(() => { throw new TRPCError({ code: "NOT_FOUND", message: "Accesso disponibile solo tramite invito personale." }); }),
  submit: publicProcedure.input(contactInput).mutation(() => { throw new TRPCError({ code: "NOT_FOUND", message: "Accesso disponibile solo tramite invito personale." }); }),

  adminList: adminProcedure.query(async ({ ctx }) => {
    const database = await requireDatabase();
    return listProspectSimulations(database, ctx.activeCompanyId);
  }),

  adminGetById: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const database = await requireDatabase();
    return getProspectSimulationDetail(database, ctx.activeCompanyId, input.id);
  }),

  adminPreviewConversion: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    return previewProspectConversion(await requireDatabase(), ctx.activeCompanyId, input.id);
  }),

  adminConvertToOrder: adminProcedure.input(z.object({
    id: z.string().uuid(),
    useExistingRetailer: z.boolean().default(false),
  })).mutation(async ({ ctx, input }) => {
    return convertProspectSimulation(await requireDatabase(), {
      companyId: ctx.activeCompanyId,
      simulationId: input.id,
      actorId: ctx.user!.id,
      useExistingRetailer: input.useExistingRetailer,
    });
  }),

  adminInvitationList: adminProcedure.query(async ({ ctx }) => {
    return listProspectInvitations(await requireDatabase(), ctx.activeCompanyId);
  }),

  adminCreateInvitation: adminProcedure.input(prospectInvitationInput).mutation(async ({ ctx, input }) => {
    return createProspectInvitation(
      await requireDatabase(),
      { ...input, companyId: ctx.activeCompanyId, actorId: ctx.user!.id },
      sendProspectInvitationNotification,
    );
  }),

  adminResendInvitation: adminProcedure.input(z.object({ id: z.string().uuid(), origin: z.string().url().max(500) })).mutation(async ({ ctx, input }) => {
    return resendProspectInvitation(await requireDatabase(), input.id, ctx.activeCompanyId, input.origin, sendProspectInvitationNotification);
  }),

  adminRegenerateInvitation: adminProcedure.input(z.object({ id: z.string().uuid(), origin: z.string().url().max(500) })).mutation(async ({ ctx, input }) => {
    return regenerateProspectInvitation(await requireDatabase(), input.id, ctx.activeCompanyId, input.origin, sendProspectInvitationNotification);
  }),

  adminRevokeInvitation: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    return revokeProspectInvitation(await requireDatabase(), input.id, ctx.activeCompanyId, ctx.user!.id);
  }),
});
