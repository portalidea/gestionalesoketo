import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  prospectInvitations,
  prospectSimulationItems,
  prospectSimulations,
  prospectSimulatorConfig,
} from "../../drizzle/schema";
import { calculateProspectSimulation, getPublicProspectCatalog, normalizeProspectTiers, type ProspectCartItemInput } from "./prospectSimulationService";
import { sendProspectSimulationNotification } from "./prospectNotificationService";

type Database = any;

export type InvitationPublicState =
  | { available: true; invitation: { id: string; legalName: string; contactName: string; email: string; phone: string; companyId: string; tokenExpiresAt: Date } }
  | { available: false };

export type InvitationNotificationResult = { sent: true } | { sent: false; errorMessage: string };

const TOKEN_LENGTH = 32;
const TOKEN_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const TOKEN_COMPARE_PLACEHOLDER = "0".repeat(TOKEN_LENGTH);

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

/** Confronto uniforme anche quando input e token salvato hanno lunghezza diversa. */
export function timingSafeTokenEquals(input: string, stored: string): boolean {
  return timingSafeEqual(digest(input), digest(stored));
}

export function normalizeVatNumber(value: string): string {
  const trimmed = value.trim().replace(/^IT\s*/i, "");
  const normalized = trimmed.replace(/\D/g, "");
  if (!normalized || normalized.length > 20) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "P.IVA non valida" });
  }
  return normalized;
}

export function createInvitationToken(): string {
  // nanoid genera caratteri URL-safe; il loop preserva la lunghezza contrattuale di 32.
  const token = nanoid(TOKEN_LENGTH);
  if (token.length !== TOKEN_LENGTH) throw new Error("Token invito non valido");
  return token;
}

function neutralUnavailable(): InvitationPublicState {
  return { available: false };
}

function isUnavailable(invitation: { status: string; tokenExpiresAt: Date }, now: Date) {
  return invitation.status === "revoked" || invitation.status === "submitted" || invitation.status === "expired" || invitation.tokenExpiresAt <= now;
}

/**
 * Legge e registra un'apertura valida. Risposte non valide sono volutamente neutrali:
 * nessun listino, fascia o dato dell'invito viene restituito.
 */
export async function resolvePublicInvitation(database: Database, token: string, now = new Date()): Promise<InvitationPublicState> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
    timingSafeTokenEquals(token, TOKEN_COMPARE_PLACEHOLDER);
    return neutralUnavailable();
  }
  const [invitation] = await database.select().from(prospectInvitations).where(eq(prospectInvitations.token, token)).limit(1);
  const tokenMatches = timingSafeTokenEquals(token, invitation?.token ?? TOKEN_COMPARE_PLACEHOLDER);
  if (!invitation || !tokenMatches) return neutralUnavailable();
  if (isUnavailable(invitation, now)) {
    if (invitation.status !== "revoked" && invitation.status !== "submitted" && invitation.status !== "expired" && invitation.tokenExpiresAt <= now) {
      await database.update(prospectInvitations).set({ status: "expired" }).where(eq(prospectInvitations.id, invitation.id));
    }
    return neutralUnavailable();
  }
  await database.update(prospectInvitations).set({ status: "opened", lastOpenedAt: now }).where(eq(prospectInvitations.id, invitation.id));
  return {
    available: true,
    invitation: {
      id: invitation.id,
      legalName: invitation.legalName,
      contactName: invitation.contactName,
      email: invitation.email,
      phone: invitation.phone,
      companyId: invitation.companyId,
      tokenExpiresAt: invitation.tokenExpiresAt,
    },
  };
}

export async function createProspectInvitation(
  database: Database,
  input: { legalName: string; contactName: string; email: string; phone: string; companyId: string; actorId: string; origin: string },
  send: (payload: { legalName: string; contactName: string; email: string; orderUrl: string }) => Promise<InvitationNotificationResult>,
) {
  const token = createInvitationToken();
  const [invitation] = await database.insert(prospectInvitations).values({
    companyId: input.companyId,
    legalName: input.legalName.trim(),
    contactName: input.contactName.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone.trim(),
    token,
    status: "pending",
    tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    createdBy: input.actorId,
    notificationStatus: "pending",
  }).returning();
  const orderUrl = `${input.origin.replace(/\/$/, "")}/ordine-rivenditore/${token}`;
  const notification = await send({ legalName: invitation.legalName, contactName: invitation.contactName, email: invitation.email, orderUrl });
  await database.update(prospectInvitations).set(notification.sent
    ? { notificationStatus: "sent", notificationSentAt: new Date(), notificationError: null }
    : { notificationStatus: "failed", notificationError: notification.errorMessage },
  ).where(eq(prospectInvitations.id, invitation.id));
  return { ...invitation, token, orderUrl, notificationStatus: notification.sent ? "sent" : "failed" };
}

export async function resendProspectInvitation(
  database: Database,
  invitationId: string,
  companyId: string,
  origin: string,
  send: (payload: { legalName: string; contactName: string; email: string; orderUrl: string }) => Promise<InvitationNotificationResult>,
) {
  const [invitation] = await database.select().from(prospectInvitations).where(and(eq(prospectInvitations.id, invitationId), eq(prospectInvitations.companyId, companyId))).limit(1);
  if (!invitation) throw new TRPCError({ code: "NOT_FOUND", message: "Invito non trovato" });
  if (invitation.status === "revoked" || invitation.status === "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Questo invito non può essere reinviato" });
  if (invitation.status === "expired" || invitation.tokenExpiresAt <= new Date()) {
    await database.update(prospectInvitations).set({ status: "expired" }).where(eq(prospectInvitations.id, invitation.id));
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Il token è scaduto: rigenera l’invito prima di inviarlo." });
  }
  const orderUrl = `${origin.replace(/\/$/, "")}/ordine-rivenditore/${invitation.token}`;
  const notification = await send({ legalName: invitation.legalName, contactName: invitation.contactName, email: invitation.email, orderUrl });
  await database.update(prospectInvitations).set(notification.sent
    ? { notificationStatus: "sent", notificationSentAt: new Date(), notificationError: null }
    : { notificationStatus: "failed", notificationError: notification.errorMessage },
  ).where(eq(prospectInvitations.id, invitation.id));
  return { orderUrl, notificationStatus: notification.sent ? "sent" : "failed" };
}

export async function regenerateProspectInvitation(
  database: Database,
  invitationId: string,
  companyId: string,
  origin: string,
  send: (payload: { legalName: string; contactName: string; email: string; orderUrl: string }) => Promise<InvitationNotificationResult>,
) {
  const [invitation] = await database.select().from(prospectInvitations).where(and(eq(prospectInvitations.id, invitationId), eq(prospectInvitations.companyId, companyId))).limit(1);
  if (!invitation) throw new TRPCError({ code: "NOT_FOUND", message: "Invito non trovato" });
  if (invitation.status === "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Un invito con richiesta inviata non può essere rigenerato" });
  const token = createInvitationToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await database.update(prospectInvitations).set({
    token,
    tokenExpiresAt: expiresAt,
    status: "pending",
    lastOpenedAt: null,
    revokedAt: null,
    revokedBy: null,
    notificationStatus: "pending",
    notificationSentAt: null,
    notificationError: null,
  }).where(eq(prospectInvitations.id, invitation.id));
  const orderUrl = `${origin.replace(/\/$/, "")}/ordine-rivenditore/${token}`;
  const notification = await send({ legalName: invitation.legalName, contactName: invitation.contactName, email: invitation.email, orderUrl });
  await database.update(prospectInvitations).set(notification.sent
    ? { notificationStatus: "sent", notificationSentAt: new Date(), notificationError: null }
    : { notificationStatus: "failed", notificationError: notification.errorMessage },
  ).where(eq(prospectInvitations.id, invitation.id));
  return { token, orderUrl, notificationStatus: notification.sent ? "sent" : "failed" };
}

export async function revokeProspectInvitation(database: Database, invitationId: string, companyId: string, actorId: string) {
  const [invitation] = await database.select().from(prospectInvitations).where(and(eq(prospectInvitations.id, invitationId), eq(prospectInvitations.companyId, companyId))).limit(1);
  if (!invitation) throw new TRPCError({ code: "NOT_FOUND", message: "Invito non trovato" });
  if (invitation.status === "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Un invito già inviato non può essere revocato" });
  await database.update(prospectInvitations).set({ status: "revoked", revokedAt: new Date(), revokedBy: actorId }).where(eq(prospectInvitations.id, invitation.id));
  return { revoked: true };
}

export async function listProspectInvitations(database: Database, companyId: string) {
  await database.execute(sql`
    UPDATE prospect_invitations
    SET status = 'expired'
    WHERE company_id = ${companyId}::uuid
      AND status IN ('pending', 'opened')
      AND token_expires_at <= NOW()
  `);
  const rows = await database.select({
    id: prospectInvitations.id,
    legalName: prospectInvitations.legalName,
    contactName: prospectInvitations.contactName,
    email: prospectInvitations.email,
    phone: prospectInvitations.phone,
    token: prospectInvitations.token,
    status: prospectInvitations.status,
    tokenExpiresAt: prospectInvitations.tokenExpiresAt,
    createdAt: prospectInvitations.createdAt,
    lastOpenedAt: prospectInvitations.lastOpenedAt,
    notificationStatus: prospectInvitations.notificationStatus,
    notificationSentAt: prospectInvitations.notificationSentAt,
    notificationError: prospectInvitations.notificationError,
    simulationId: prospectSimulations.id,
  }).from(prospectInvitations)
    .leftJoin(prospectSimulations, eq(prospectSimulations.invitationId, prospectInvitations.id))
    .where(eq(prospectInvitations.companyId, companyId))
    .orderBy(desc(prospectInvitations.createdAt));
  return rows;
}

/** Persistenza pubblica con token monouso; le righe e lo snapshot sono sempre calcolati server-side. */
export async function submitInvitedProspectOrder(
  database: Database,
  input: {
    token: string; legalName: string; contactName: string; email: string; phone: string;
    businessType: string; address: string; postalCode: string; city: string; province: string;
    vatNumber: string; notes?: string; privacyAccepted: true; website?: string; items: ProspectCartItemInput[];
  },
) {
  if (input.website?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Richiesta non valida" });
  if (!/^[A-Za-z0-9_-]{32}$/.test(input.token)) {
    timingSafeTokenEquals(input.token, TOKEN_COMPARE_PLACEHOLDER);
    throw new TRPCError({ code: "NOT_FOUND", message: "Link non valido" });
  }
  const [tokenCandidate] = await database.select({ id: prospectInvitations.id, token: prospectInvitations.token })
    .from(prospectInvitations).where(eq(prospectInvitations.token, input.token)).limit(1);
  const tokenMatches = timingSafeTokenEquals(input.token, tokenCandidate?.token ?? TOKEN_COMPARE_PLACEHOLDER);
  if (!tokenCandidate || !tokenMatches) throw new TRPCError({ code: "NOT_FOUND", message: "Link non valido" });
  const vatNumber = normalizeVatNumber(input.vatNumber);

  const simulation = await database.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tokenCandidate.id}))`);
    const [lockedInvitation] = await tx.select().from(prospectInvitations).where(eq(prospectInvitations.id, tokenCandidate.id)).limit(1);
    const lockedTokenMatches = timingSafeTokenEquals(input.token, lockedInvitation?.token ?? TOKEN_COMPARE_PLACEHOLDER);
    if (!lockedInvitation || !lockedTokenMatches || isUnavailable(lockedInvitation, new Date())) throw new TRPCError({ code: "NOT_FOUND", message: "Link non valido" });
    if (
      input.legalName.trim() !== lockedInvitation.legalName ||
      input.contactName.trim() !== lockedInvitation.contactName ||
      input.email.trim().toLowerCase() !== lockedInvitation.email ||
      input.phone.trim() !== lockedInvitation.phone
    ) throw new TRPCError({ code: "BAD_REQUEST", message: "I dati dell’invito non possono essere modificati." });
    const [config] = await tx.select().from(prospectSimulatorConfig).where(eq(prospectSimulatorConfig.companyId, lockedInvitation.companyId)).limit(1);
    if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Modulo non disponibile" });
    normalizeProspectTiers(config.tiers);
    const catalog = await getPublicProspectCatalog(tx);
    const calculation = calculateProspectSimulation(config, catalog, input.items);
    const [alreadySubmitted] = await tx.select({ id: prospectSimulations.id }).from(prospectSimulations).where(eq(prospectSimulations.invitationId, lockedInvitation.id)).limit(1);
    if (alreadySubmitted) throw new TRPCError({ code: "CONFLICT", message: "Questo invito ha già prodotto un ordine" });
    const [created] = await tx.insert(prospectSimulations).values({
      companyId: lockedInvitation.companyId,
      legalName: input.legalName.trim(), contactName: input.contactName.trim(), email: input.email.trim().toLowerCase(), phone: input.phone.trim(),
      businessType: input.businessType.trim(), city: input.city.trim(), vatNumber,
      address: input.address.trim(), postalCode: input.postalCode.trim(), province: input.province.trim().toUpperCase(), notes: input.notes?.trim() || null,
      invitationId: lockedInvitation.id, privacyAcceptedAt: new Date(), privacyPolicyUrl: config.privacyPolicyUrl,
      listSubtotalNet: calculation.listSubtotalNet, reachedTierCode: calculation.reachedTier.code,
      calculationSnapshot: calculation, status: "new", notificationStatus: "pending",
    }).returning();
    await tx.insert(prospectSimulationItems).values(calculation.items.map((item, sortOrder) => ({
      simulationId: created.id, productId: item.id, productSkuSnapshot: item.sku, productNameSnapshot: item.name,
      quantity: item.quantity, piecesPerUnitSnapshot: item.piecesPerUnit, unitListNetSnapshot: item.unitListNet,
      vatRateSnapshot: item.vatRate, lineListNet: item.lineListNet, sortOrder,
    })));
    await tx.update(prospectInvitations).set({ status: "submitted" }).where(eq(prospectInvitations.id, lockedInvitation.id));
    return { created, calculation };
  });
  const notification = await sendProspectSimulationNotification({
    simulationId: simulation.created.id, legalName: simulation.created.legalName, contactName: simulation.created.contactName, email: simulation.created.email,
    phone: simulation.created.phone, businessType: simulation.created.businessType, city: simulation.created.city, vatNumber: simulation.created.vatNumber,
    listSubtotalNet: simulation.calculation.listSubtotalNet, reachedTierName: simulation.calculation.reachedTier.name, itemCount: simulation.calculation.items.length,
  });
  await database.update(prospectSimulations).set(notification.sent
    ? { notificationStatus: "sent", notificationSentAt: new Date(), notificationError: null }
    : { notificationStatus: "failed", notificationError: notification.errorMessage },
  ).where(eq(prospectSimulations.id, simulation.created.id));
  return { id: simulation.created.id, calculation: simulation.calculation, notificationStatus: notification.sent ? "sent" : "failed" };
}
