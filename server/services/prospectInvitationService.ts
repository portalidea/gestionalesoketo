import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  products,
  prospectCompositionSessions,
  prospectInvitations,
  prospectSimulationItems,
  prospectSimulations,
  prospectSimulatorConfig,
  type ProspectCompositionSession,
} from "../../drizzle/schema";
import { calculateProspectSimulation, getPublicProspectCatalog, normalizeProspectTiers, type ProspectCartItemInput } from "./prospectSimulationService";
import { sendProspectSimulationNotification } from "./prospectNotificationService";

type Database = any;

export type InvitationPublicState =
  | { available: true; invitation: { id: string; legalName: string; contactName: string; email: string; phone: string; companyId: string; tokenExpiresAt: Date } }
  | { available: false };

export type InvitationNotificationResult = { sent: true } | { sent: false; errorMessage: string };
export type ProspectCompositionCartItem = { productId: string; quantity: number };

const TOKEN_LENGTH = 32;
const TOKEN_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const TOKEN_COMPARE_PLACEHOLDER = "0".repeat(TOKEN_LENGTH);
const COMPOSITION_SESSION_INACTIVITY_MS = 30 * 60 * 1000;

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

function compositionMetrics(calculation: Awaited<ReturnType<typeof calculateProspectSimulation>>) {
  return {
    cartSnapshot: calculation.items.map((item) => ({ productId: item.id, quantity: item.quantity })),
    listTotal: calculation.listSubtotalNet,
    discountedNet: calculation.currentTierMerchandiseNet,
    reachedTier: calculation.reachedTier.code,
    nextTierDistanceEur: calculation.nextTier?.additionalMerchandiseNet ?? null,
  };
}

function emptyCompositionMetrics() {
  return {
    cartSnapshot: [] as ProspectCompositionCartItem[],
    listTotal: "0.00",
    discountedNet: "0.00",
    reachedTier: null,
    nextTierDistanceEur: null,
  };
}

function sessionIsInactive(lastActivityAt: Date, now: Date) {
  return now.getTime() - lastActivityAt.getTime() > COMPOSITION_SESSION_INACTIVITY_MS;
}

async function findActiveInvitationForToken(tx: Database, token: string, now: Date) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
    timingSafeTokenEquals(token, TOKEN_COMPARE_PLACEHOLDER);
    return null;
  }
  const [candidate] = await tx.select().from(prospectInvitations).where(eq(prospectInvitations.token, token)).limit(1);
  const tokenMatches = timingSafeTokenEquals(token, candidate?.token ?? TOKEN_COMPARE_PLACEHOLDER);
  if (!candidate || !tokenMatches) return null;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${candidate.id}))`);
  const [lockedInvitation] = await tx.select().from(prospectInvitations).where(eq(prospectInvitations.id, candidate.id)).limit(1);
  const lockedTokenMatches = timingSafeTokenEquals(token, lockedInvitation?.token ?? TOKEN_COMPARE_PLACEHOLDER);
  if (!lockedInvitation || !lockedTokenMatches || isUnavailable(lockedInvitation, now)) return null;
  return lockedInvitation;
}

/** Crea una sessione all'apertura o riprende quella non inviata ancora attiva entro 30 minuti. */
export async function openProspectCompositionSession(database: Database, token: string, now = new Date()) {
  return database.transaction(async (tx: Database) => {
    const invitation = await findActiveInvitationForToken(tx, token, now);
    if (!invitation) return null;
    const [latest] = await tx.select().from(prospectCompositionSessions)
      .where(and(
        eq(prospectCompositionSessions.invitationId, invitation.id),
        eq(prospectCompositionSessions.companyId, invitation.companyId),
        eq(prospectCompositionSessions.submitted, false),
      ))
      .orderBy(desc(prospectCompositionSessions.lastActivityAt))
      .limit(1);
    if (latest && !sessionIsInactive(latest.lastActivityAt, now)) {
      const [resumed] = await tx.update(prospectCompositionSessions)
        .set({ lastActivityAt: now })
        .where(eq(prospectCompositionSessions.id, latest.id))
        .returning();
      return resumed;
    }
    const [created] = await tx.insert(prospectCompositionSessions).values({
      invitationId: invitation.id,
      companyId: invitation.companyId,
      startedAt: now,
      lastActivityAt: now,
      ...emptyCompositionMetrics(),
    }).returning();
    return created;
  });
}

/** Salva un carrello ricalcolato dal server; un session ID non valido non genera nuove scritture. */
export async function saveProspectCompositionSession(
  database: Database,
  input: { token: string; sessionId: string; items: ProspectCartItemInput[] },
  now = new Date(),
) {
  return database.transaction(async (tx: Database) => {
    const invitation = await findActiveInvitationForToken(tx, input.token, now);
    if (!invitation) return { persisted: false as const, sessionId: null };
    const [session] = await tx.select().from(prospectCompositionSessions).where(and(
      eq(prospectCompositionSessions.id, input.sessionId),
      eq(prospectCompositionSessions.invitationId, invitation.id),
      eq(prospectCompositionSessions.companyId, invitation.companyId),
      eq(prospectCompositionSessions.submitted, false),
    )).limit(1);
    if (!session) return { persisted: false as const, sessionId: null };
    const metrics = input.items.length === 0
      ? emptyCompositionMetrics()
      : compositionMetrics(calculateProspectSimulation(
        (await tx.select().from(prospectSimulatorConfig).where(eq(prospectSimulatorConfig.companyId, invitation.companyId)).limit(1))[0]
          ?? (() => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Modulo non disponibile" }); })(),
        await getPublicProspectCatalog(tx),
        input.items,
      ));
    const values = { lastActivityAt: now, ...metrics };
    if (sessionIsInactive(session.lastActivityAt, now)) {
      const [created] = await tx.insert(prospectCompositionSessions).values({
        invitationId: invitation.id,
        companyId: invitation.companyId,
        startedAt: now,
        ...values,
      }).returning();
      return { persisted: true as const, sessionId: created.id };
    }
    const [updated] = await tx.update(prospectCompositionSessions).set(values)
      .where(eq(prospectCompositionSessions.id, session.id)).returning();
    return { persisted: true as const, sessionId: updated.id };
  });
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
    hasComposedWithoutSubmitting: sql<boolean>`EXISTS (
      SELECT 1
      FROM prospect_composition_sessions pcs
      WHERE pcs.invitation_id = ${prospectInvitations.id}
        AND pcs.company_id = ${prospectInvitations.companyId}
        AND pcs.submitted = false
        AND jsonb_array_length(pcs.cart_snapshot) > 0
    )`,
    lastCompositionAt: sql<Date | null>`(
      SELECT MAX(pcs.last_activity_at)
      FROM prospect_composition_sessions pcs
      WHERE pcs.invitation_id = ${prospectInvitations.id}
        AND pcs.company_id = ${prospectInvitations.companyId}
    )`,
  }).from(prospectInvitations)
    .leftJoin(prospectSimulations, eq(prospectSimulations.invitationId, prospectInvitations.id))
    .where(eq(prospectInvitations.companyId, companyId))
    .orderBy(desc(prospectInvitations.createdAt));
  return rows;
}

function compositionCartItems(snapshot: unknown): ProspectCompositionCartItem[] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { productId?: unknown; quantity?: unknown };
    if (typeof candidate.productId !== "string" || typeof candidate.quantity !== "number" || !Number.isInteger(candidate.quantity) || candidate.quantity <= 0) return [];
    return [{ productId: candidate.productId, quantity: candidate.quantity }];
  });
}

/** Dettaglio staff dell'attività invito, filtrato dalla company attiva. */
export async function getProspectInvitationCompositionDetail(database: Database, invitationId: string, companyId: string) {
  const [invitation] = await database.select({
    id: prospectInvitations.id,
    legalName: prospectInvitations.legalName,
    contactName: prospectInvitations.contactName,
    status: prospectInvitations.status,
  }).from(prospectInvitations).where(and(
    eq(prospectInvitations.id, invitationId),
    eq(prospectInvitations.companyId, companyId),
  )).limit(1);
  if (!invitation) throw new TRPCError({ code: "NOT_FOUND", message: "Invito non trovato" });
  const sessions = await database.select().from(prospectCompositionSessions).where(and(
    eq(prospectCompositionSessions.invitationId, invitationId),
    eq(prospectCompositionSessions.companyId, companyId),
  )).orderBy(desc(prospectCompositionSessions.lastActivityAt)) as ProspectCompositionSession[];
  const cartItems = sessions.flatMap((session) => compositionCartItems(session.cartSnapshot));
  const productIds = Array.from(new Set(cartItems.map((item) => item.productId)));
  const productRows: Array<{ id: string; sku: string; name: string }> = productIds.length === 0 ? [] : await database.select({
    id: products.id,
    sku: products.sku,
    name: products.name,
  }).from(products).where(inArray(products.id, productIds));
  const productById = new Map(productRows.map((product) => [product.id, product]));
  return {
    invitation,
    sessions: sessions.map((session) => ({
      ...session,
      cartItems: compositionCartItems(session.cartSnapshot).map((item) => ({
        ...item,
        product: productById.get(item.productId) ?? null,
      })),
    })),
  };
}

/** Persistenza pubblica con token monouso; le righe e lo snapshot sono sempre calcolati server-side. */
export async function submitInvitedProspectOrder(
  database: Database,
  input: {
    token: string; legalName: string; contactName: string; email: string; phone: string;
    businessType: string; address: string; postalCode: string; city: string; province: string;
    vatNumber: string; notes?: string; privacyAccepted: true; website?: string; items: ProspectCartItemInput[]; compositionSessionId?: string;
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
    // Il riferimento è opzionale e non può bloccare l'ordine esistente: viene
    // marcato solo se la sessione appartiene allo stesso invito e alla company.
    if (input.compositionSessionId) {
      await tx.update(prospectCompositionSessions).set({
        ...compositionMetrics(calculation),
        lastActivityAt: new Date(),
        submitted: true,
      }).where(and(
        eq(prospectCompositionSessions.id, input.compositionSessionId),
        eq(prospectCompositionSessions.invitationId, lockedInvitation.id),
        eq(prospectCompositionSessions.companyId, lockedInvitation.companyId),
        eq(prospectCompositionSessions.submitted, false),
      ));
    }
    await tx.update(prospectInvitations).set({ status: "submitted" }).where(eq(prospectInvitations.id, lockedInvitation.id));
    return { created, calculation };
  });
  const notification = await sendProspectSimulationNotification({
    simulationId: simulation.created.id, legalName: simulation.created.legalName, contactName: simulation.created.contactName, email: simulation.created.email,
    phone: simulation.created.phone, businessType: simulation.created.businessType, city: simulation.created.city, vatNumber: simulation.created.vatNumber,
    listSubtotalNet: simulation.calculation.listSubtotalNet, reachedTierName: simulation.calculation.reachedTier.name,
    reachedTierDiscountPercent: String(simulation.calculation.reachedTier.discount_percent), itemCount: simulation.calculation.items.length,
  });
  await database.update(prospectSimulations).set(notification.sent
    ? { notificationStatus: "sent", notificationSentAt: new Date(), notificationError: null }
    : { notificationStatus: "failed", notificationError: notification.errorMessage },
  ).where(eq(prospectSimulations.id, simulation.created.id));
  return { id: simulation.created.id, calculation: simulation.calculation, notificationStatus: notification.sent ? "sent" : "failed" };
}
