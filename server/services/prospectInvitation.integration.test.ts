import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { companies, orders, prospectCompositionSessions, prospectInvitations, prospectOrderCommercialTerms, prospectPromotions, prospectSimulations, retailers, userCompanyAccess } from "../../drizzle/schema";
import { EKETO_COMPANY_ID, SOKETO_COMPANY_ID } from "../../shared/const";
import { prospectInvitationInput, prospectSimulatorRouter } from "../prospect-simulator-router";
import type { TrpcContext } from "../_core/context";
import {
  createProspectInvitation,
  getProspectInvitationCompositionDetail,
  normalizeVatNumber,
  openProspectCompositionSession,
  regenerateProspectInvitation,
  resolvePublicInvitation,
  revokeProspectInvitation,
  saveProspectCompositionSession,
  submitInvitedProspectOrder,
} from "./prospectInvitationService";
import { convertProspectSimulation, previewProspectConversion } from "./prospectOrderConversionService";
import { createProspectTierUpgradePromotion, getActiveProspectTierUpgradePromotion } from "./prospectPromotionService";
import { calculateProspectSimulation, getProspectSimulatorConfig, getPublicProspectCatalog } from "./prospectSimulationService";
import { modifyOrderItems } from "./orderStateMachine";
import { ordersRouter } from "../orders-router";

const ACTOR_ID = "10000000-0000-0000-0000-000000000001";
const PRODUCT_ID = "20000000-0000-0000-0000-000000000001";
const STARTER_ID = "30000000-0000-0000-0000-000000000001";
const PARTNER_ID = "30000000-0000-0000-0000-000000000002";
const PREMIUM_ID = "30000000-0000-0000-0000-000000000003";
const ELITE_ID = "30000000-0000-0000-0000-000000000004";
const fakeEmail = async () => ({ sent: false as const, errorMessage: "email test disabilitata" });

function contact(suffix: string, vatNumber = `IT 123.45${suffix}`, quantity = 9) {
  return {
    legalName: `Prospect ${suffix}`,
    contactName: `Referente ${suffix}`,
    email: `prospect-${suffix}@example.test`,
    phone: "3331234567",
    businessType: "Negozio",
    address: "Via Roma 10",
    postalCode: "20100",
    city: "Milano",
    province: "MI",
    vatNumber,
    privacyAccepted: true as const,
    website: "",
    items: [{ productId: PRODUCT_ID, quantity }],
  };
}

async function invite(database: any, suffix: string, companyId = EKETO_COMPANY_ID) {
  return createProspectInvitation(database, {
    legalName: `Prospect ${suffix}`,
    contactName: `Referente ${suffix}`,
    email: `prospect-${suffix}@example.test`,
    phone: "3331234567",
    companyId,
    actorId: ACTOR_ID,
    origin: "https://gestionale.example.test",
  }, fakeEmail);
}

async function submit(database: any, suffix: string, vatNumber?: string, companyId = EKETO_COMPANY_ID) {
  const invitation = await invite(database, suffix, companyId);
  const result = await submitInvitedProspectOrder(database, { token: invitation.token, ...contact(suffix, vatNumber) });
  return { invitation, simulationId: result.id };
}

beforeAll(async () => {
  const database = await getDb();
  if (!database) throw new Error("DATABASE_URL isolato obbligatorio per questa suite");
  await database.execute(sql`TRUNCATE TABLE prospect_composition_sessions, "prospect_simulation_items", prospect_simulations, prospect_invitations, "orderItems", orders, locations, retailers, "pricingPackages", products, prospect_simulator_config, users, companies CASCADE`);
  // Il catalogo di produzione è già riallineato con 0033; la migration non è
  // versionata nel branch, quindi questa fixture locale rende esplicita la lacuna.
  await database.execute(sql`DO $$ BEGIN CREATE TYPE payment_status_enum AS ENUM ('unpaid', 'paid', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await database.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "paymentStatus" payment_status_enum NOT NULL DEFAULT 'unpaid'::payment_status_enum`);
  await database.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "paymentMethod" varchar(50)`);
  await database.execute(sql`DELETE FROM auth.users`);
  await database.execute(sql`INSERT INTO companies (id, name) VALUES (${EKETO_COMPANY_ID}::uuid, 'E-Keto Food Srls'), (${SOKETO_COMPANY_ID}::uuid, 'SoKeto Srl')`);
  await database.execute(sql`INSERT INTO auth.users (id, email) VALUES (${ACTOR_ID}::uuid, 'admin@example.test')`);
  await database.insert(userCompanyAccess).values({ userId: ACTOR_ID, companyId: EKETO_COMPANY_ID, isDefault: true });
  await database.execute(sql`INSERT INTO products (id, sku, name, "unitPrice", "vatRate", "piecesPerUnit", "showInSimulator", "simulatorOrder", "costPrice") VALUES (${PRODUCT_ID}::uuid, 'TEST-PROSPECT', 'Prodotto prospect test', 100.00, 10.00, 1, true, 1, 25.00)`);
  await database.execute(sql`
    INSERT INTO prospect_simulator_config (company_id, minimum_order_net, shipping_fee_net, free_shipping_threshold_net, recommended_public_discount_percent, display_stand_threshold, privacy_policy_url, tiers)
    VALUES
      (${EKETO_COMPANY_ID}::uuid, 290.00, 18.00, 500.00, 10.00, 790.00, 'https://example.test/privacy',
        '[{"code":"starter","name":"Starter","discount_percent":38.50,"minimum_list_net":0},{"code":"partner","name":"Partner","discount_percent":41.40,"minimum_list_net":500},{"code":"premium","name":"Premium","discount_percent":44.05,"minimum_list_net":790},{"code":"elite","name":"Elite","discount_percent":46.50,"minimum_list_net":1005}]'::jsonb),
      (${SOKETO_COMPANY_ID}::uuid, 290.00, 18.00, 500.00, 10.00, 790.00, 'https://example.test/privacy',
        '[{"code":"starter","name":"Starter","discount_percent":38.50,"minimum_list_net":0},{"code":"partner","name":"Partner","discount_percent":41.40,"minimum_list_net":500},{"code":"premium","name":"Premium","discount_percent":44.05,"minimum_list_net":790},{"code":"elite","name":"Elite","discount_percent":46.50,"minimum_list_net":1005}]'::jsonb)
  `);
  await database.execute(sql`INSERT INTO "pricingPackages" (id, name, "discountPercent", "sortOrder") VALUES (${STARTER_ID}::uuid, 'Starter', 38.50, 1), (${PARTNER_ID}::uuid, 'Partner', 41.40, 2), (${PREMIUM_ID}::uuid, 'Premium', 44.05, 3), (${ELITE_ID}::uuid, 'Elite', 46.50, 4)`);
});

describe("prospect invitations and conversion — PostgreSQL isolato", () => {
  it("T1: token valido restituisce solo l'invito corretto; token inesistente è neutro", async () => {
    const database = await getDb();
    const created = await invite(database, "valid");
    expect(created.notificationStatus).toBe("failed");
    expect((await resolvePublicInvitation(database, created.token)).available).toBe(true);
    expect(await resolvePublicInvitation(database, "x".repeat(32))).toEqual({ available: false });
  });

  it("T2: token scaduto, revocato e rigenerato restano sotto controllo", async () => {
    const database = await getDb();
    const expired = await invite(database, "expired");
    await database.execute(sql`UPDATE prospect_invitations SET created_at = now() - interval '16 days', token_expires_at = now() - interval '1 second' WHERE id = ${expired.id}::uuid`);
    expect(await resolvePublicInvitation(database, expired.token)).toEqual({ available: false });
    const regenerated = await regenerateProspectInvitation(database, expired.id, EKETO_COMPANY_ID, "https://gestionale.example.test", fakeEmail);
    expect(regenerated.token).not.toBe(expired.token);
    expect(regenerated.notificationStatus).toBe("failed");
    expect((await resolvePublicInvitation(database, regenerated.token)).available).toBe(true);
    const revoked = await invite(database, "revoked");
    await revokeProspectInvitation(database, revoked.id, EKETO_COMPANY_ID, ACTOR_ID);
    expect(await resolvePublicInvitation(database, revoked.token)).toEqual({ available: false });
  });

  it("T3: submit tokenizzato è monouso e salva P.IVA normalizzata", async () => {
    const database = await getDb();
    const created = await invite(database, "single");
    const first = await submitInvitedProspectOrder(database, { token: created.token, ...contact("single", "IT 123.456.789 01") });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(submitInvitedProspectOrder(database, { token: created.token, ...contact("single", "IT 123.456.789 01") })).rejects.toThrow("Link non valido");
    const [stored] = await database.select({ vatNumber: sql<string>`vat_number` }).from(sql`prospect_simulations`).where(sql`id = ${first.id}::uuid`);
    expect(stored.vatNumber).toBe("12345678901");
  });

  it("T4: conversione crea una sola coppia retailer/ordine anche con doppia conferma concorrente", async () => {
    const database = await getDb();
    const { simulationId } = await submit(database, "concurrent", "IT 555.444.333 22");
    const results = await Promise.all([
      convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId, actorId: ACTOR_ID, useExistingRetailer: false }),
      convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId, actorId: ACTOR_ID, useExistingRetailer: false }),
    ]);
    expect(results.filter((result) => result.alreadyConverted).length).toBe(1);
    const [retailerCount] = await database.select({ total: sql<number>`count(*)::int` }).from(retailers).where(eq(retailers.vatNumber, "55544433322"));
    const [orderCount] = await database.select({ total: sql<number>`count(*)::int` }).from(orders).where(sql`"notesInternal" = ${`Creato dalla richiesta prospect ${simulationId}`}`);
    expect(retailerCount.total).toBe(1);
    expect(orderCount.total).toBe(1);
  });

  it("T5: P.IVA esistente blocca senza conferma e riusa l'anagrafica soltanto dopo conferma", async () => {
    const database = await getDb();
    await database.execute(sql`INSERT INTO retailers (name, "companyId", "vatNumber", "pricingPackageId") VALUES ('Retailer già esistente', ${EKETO_COMPANY_ID}::uuid, '77788899900', ${PARTNER_ID}::uuid)`);
    const { simulationId } = await submit(database, "reuse", "IT 777.888.999 00");
    const preview = await previewProspectConversion(database, EKETO_COMPANY_ID, simulationId);
    expect(preview.requiresExistingRetailerConfirmation).toBe(true);
    expect(preview.pricing.packageName).toBe("Partner");
    await expect(convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId, actorId: ACTOR_ID, useExistingRetailer: false })).rejects.toThrow("stessa P.IVA");
    const converted = await convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId, actorId: ACTOR_ID, useExistingRetailer: true });
    const [count] = await database.select({ total: sql<number>`count(*)::int` }).from(retailers).where(eq(retailers.vatNumber, "77788899900"));
    expect(count.total).toBe(1);
    expect(converted.alreadyConverted).toBe(false);
  });

  it("T6: normalizzazione P.IVA e package non risolto bloccano in modo esplicito", async () => {
    const database = await getDb();
    expect(normalizeVatNumber(" IT 123.456 789-01 ")).toBe("12345678901");
    const { simulationId } = await submit(database, "missing-package", "IT 11122233344");
    await database.execute(sql`DELETE FROM "pricingPackages" WHERE id = ${PARTNER_ID}::uuid`);
    await expect(previewProspectConversion(database, EKETO_COMPANY_ID, simulationId)).rejects.toThrow('Pricing package "Partner"');
    await database.execute(sql`INSERT INTO "pricingPackages" (id, name, "discountPercent", "sortOrder") VALUES (${PARTNER_ID}::uuid, 'Partner', 41.40, 2)`);
  });

  it("T7: sotto il minimo commerciale la conversione richiede una motivazione e traccia la deroga", async () => {
    const database = await getDb();
    const invitation = await invite(database, "minimum");
    const submitted = await submitInvitedProspectOrder(database, { token: invitation.token, ...contact("minimum", "IT 99988877766", 3) });
    const preview = await previewProspectConversion(database, EKETO_COMPANY_ID, submitted.id);
    expect(preview.meetsMinimumOrder).toBe(false);
    await expect(convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId: submitted.id, actorId: ACTOR_ID, useExistingRetailer: false })).rejects.toThrow("Ordine non approvabile");
    await expect(convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId: submitted.id, actorId: ACTOR_ID, useExistingRetailer: false, minimumOrderOverrideReason: "Ordine campione per il punto vendita" })).resolves.toMatchObject({ alreadyConverted: false });
    const [stored] = await database.select({
      applied: prospectSimulations.minimumOrderOverrideApplied,
      reason: prospectSimulations.minimumOrderOverrideReason,
      overriddenBy: prospectSimulations.minimumOrderOverriddenBy,
      overriddenAt: prospectSimulations.minimumOrderOverriddenAt,
    }).from(prospectSimulations).where(eq(prospectSimulations.id, submitted.id));
    expect(stored).toMatchObject({ applied: true, reason: "Ordine campione per il punto vendita", overriddenBy: ACTOR_ID });
    expect(stored.overriddenAt).toBeInstanceOf(Date);
  });

  it("T8: la preview evidenzia il delta quando il listino normale cambia dopo l'invio prospect", async () => {
    const database = await getDb();
    const { simulationId } = await submit(database, "price-change", "IT 55566677788");
    await database.execute(sql`UPDATE products SET "unitPrice" = 120.00 WHERE id = ${PRODUCT_ID}::uuid`);
    const preview = await previewProspectConversion(database, EKETO_COMPANY_ID, simulationId);
    expect(preview.simulationTierNet).toBe("527.40");
    expect(preview.pricing.subtotalNet).toBe("632.88");
    expect(preview.pricingDifferenceNet).toBe("105.48");
  });

  it.each([
    ["E-Keto", EKETO_COMPANY_ID, "eketo-multicompany", "11122233344"],
    ["SoKeto", SOKETO_COMPANY_ID, "soketo-multicompany", "55566677788"],
  ])("T9: invito %s propaga la company a richiesta, retailer e ordine", async (_companyName, companyId, suffix, vatNumber) => {
    const database = await getDb();
    const invitation = await invite(database, suffix, companyId);
    const opened = await resolvePublicInvitation(database, invitation.token);
    expect(opened).toMatchObject({ available: true, invitation: { companyId } });
    const submitted = await submitInvitedProspectOrder(database, { token: invitation.token, ...contact(suffix, `IT ${vatNumber}`) });
    const [simulation] = await database.select({ companyId: prospectSimulations.companyId }).from(prospectSimulations).where(eq(prospectSimulations.id, submitted.id));
    expect(simulation.companyId).toBe(companyId);
    const converted = await convertProspectSimulation(database, { companyId, simulationId: submitted.id, actorId: ACTOR_ID, useExistingRetailer: false });
    const [retailer] = await database.select({ companyId: retailers.companyId }).from(retailers).where(eq(retailers.id, converted.retailerId));
    const [order] = await database.select({ companyId: orders.companyId }).from(orders).where(eq(orders.id, converted.orderId));
    expect(retailer.companyId).toBe(companyId);
    expect(order.companyId).toBe(companyId);
  });

  it("T10: il payload admin non ammette la scelta o l'iniezione di una company", () => {
    const result = prospectInvitationInput.safeParse({
      legalName: "Prospect", contactName: "Referente", email: "prospect@example.test", phone: "3331234567",
      origin: "https://gestionale.example.test", companyId: SOKETO_COMPANY_ID,
    });
    expect(result.success).toBe(false);
  });

  it("T11: invito di una company senza configurazione risponde in modo neutro", async () => {
    const database = await getDb();
    const invitation = await invite(database, "missing-soketo-config", SOKETO_COMPANY_ID);
    await database.execute(sql`DELETE FROM prospect_simulator_config WHERE company_id = ${SOKETO_COMPANY_ID}::uuid`);
    const caller = prospectSimulatorRouter.createCaller({
      req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as TrpcContext["req"],
      res: {} as TrpcContext["res"],
      user: null,
    });
    await expect(caller.getInvitationPublicData({ token: invitation.token })).resolves.toEqual({ available: false });
    await database.execute(sql`
      INSERT INTO prospect_simulator_config (company_id, minimum_order_net, shipping_fee_net, free_shipping_threshold_net, recommended_public_discount_percent, display_stand_threshold, privacy_policy_url, tiers)
      VALUES (${SOKETO_COMPANY_ID}::uuid, 290.00, 18.00, 500.00, 10.00, 790.00, 'https://example.test/privacy',
        '[{"code":"starter","name":"Starter","discount_percent":38.50,"minimum_list_net":0},{"code":"partner","name":"Partner","discount_percent":41.40,"minimum_list_net":500},{"code":"premium","name":"Premium","discount_percent":44.05,"minimum_list_net":790},{"code":"elite","name":"Elite","discount_percent":46.50,"minimum_list_net":1005}]'::jsonb)
    `);
  });

  it("S1: l'apertura valida crea una sessione vuota legata esclusivamente all'invito e alla sua company", async () => {
    const database = await getDb();
    const invitation = await invite(database, "composition-open", EKETO_COMPANY_ID);
    const session = await openProspectCompositionSession(database, invitation.token);
    expect(session).toMatchObject({ invitationId: invitation.id, companyId: EKETO_COMPANY_ID, submitted: false, cartSnapshot: [], listTotal: "0.00", discountedNet: "0.00", reachedTier: null });
  });

  it("S2: un ritorno entro 30 minuti riapre la stessa sessione e ne aggiorna l'attività", async () => {
    const database = await getDb();
    const invitation = await invite(database, "composition-resume");
    const base = new Date();
    const first = await openProspectCompositionSession(database, invitation.token, base);
    const resumed = await openProspectCompositionSession(database, invitation.token, new Date(base.getTime() + (29 * 60 + 59) * 1000));
    expect(resumed?.id).toBe(first?.id);
    expect(resumed?.lastActivityAt.getTime()).toBeGreaterThan(first?.lastActivityAt.getTime() ?? 0);
  });

  it("S3: oltre 30 minuti di inattività viene creata una nuova sessione e la precedente resta storica", async () => {
    const database = await getDb();
    const invitation = await invite(database, "composition-new-session");
    const base = new Date();
    const first = await openProspectCompositionSession(database, invitation.token, base);
    const second = await openProspectCompositionSession(database, invitation.token, new Date(base.getTime() + 30 * 60 * 1000 + 1));
    expect(second?.id).not.toBe(first?.id);
    const rows = await database.select().from(prospectCompositionSessions).where(eq(prospectCompositionSessions.invitationId, invitation.id));
    expect(rows).toHaveLength(2);
  });

  it("S4: il salvataggio conserva solo ID/quantità e totali autorevoli ricalcolati dal server", async () => {
    const database = await getDb();
    await database.execute(sql`UPDATE products SET "unitPrice" = 100.00 WHERE id = ${PRODUCT_ID}::uuid`);
    const invitation = await invite(database, "composition-calculation");
    const session = await openProspectCompositionSession(database, invitation.token);
    const saved = await saveProspectCompositionSession(database, { token: invitation.token, sessionId: session!.id, items: [{ productId: PRODUCT_ID, quantity: 9 }] });
    expect(saved).toEqual({ persisted: true, sessionId: session!.id });
    const [stored] = await database.select().from(prospectCompositionSessions).where(eq(prospectCompositionSessions.id, session!.id));
    expect(stored.cartSnapshot).toEqual([{ productId: PRODUCT_ID, quantity: 9 }]);
    expect(Object.keys((stored.cartSnapshot as Array<object>)[0]!).sort()).toEqual(["productId", "quantity"]);
    expect(stored).toMatchObject({ listTotal: "900.00", discountedNet: "527.40", reachedTier: "partner" });
  });

  it("S5: token scaduto, revocato o inesistente non scrive nuove sessioni e conserva lo storico esistente", async () => {
    const database = await getDb();
    const revoked = await invite(database, "composition-revoked");
    const session = await openProspectCompositionSession(database, revoked.token);
    await revokeProspectInvitation(database, revoked.id, EKETO_COMPANY_ID, ACTOR_ID);
    await expect(saveProspectCompositionSession(database, { token: revoked.token, sessionId: session!.id, items: [{ productId: PRODUCT_ID, quantity: 1 }] })).resolves.toEqual({ persisted: false, sessionId: null });
    const [historicalCount] = await database.select({ total: sql<number>`count(*)::int` }).from(prospectCompositionSessions).where(eq(prospectCompositionSessions.invitationId, revoked.id));
    expect(historicalCount.total).toBe(1);
    expect(await openProspectCompositionSession(database, "x".repeat(32))).toBeNull();
  });

  it("S6: il submit marca nella medesima transazione la sessione che ha prodotto l'ordine", async () => {
    const database = await getDb();
    const invitation = await invite(database, "composition-submitted");
    const session = await openProspectCompositionSession(database, invitation.token);
    await saveProspectCompositionSession(database, { token: invitation.token, sessionId: session!.id, items: [{ productId: PRODUCT_ID, quantity: 9 }] });
    await submitInvitedProspectOrder(database, { token: invitation.token, ...contact("composition-submitted"), compositionSessionId: session!.id });
    const [stored] = await database.select().from(prospectCompositionSessions).where(eq(prospectCompositionSessions.id, session!.id));
    expect(stored).toMatchObject({ submitted: true, cartSnapshot: [{ productId: PRODUCT_ID, quantity: 9 }], reachedTier: "partner" });
  });

  it("S7: un riferimento sessione estraneo non blocca il submit e non può marcare l'attività di un altro invito", async () => {
    const database = await getDb();
    const first = await invite(database, "composition-safe-submit");
    const other = await invite(database, "composition-other");
    const otherSession = await openProspectCompositionSession(database, other.token);
    await expect(submitInvitedProspectOrder(database, { token: first.token, ...contact("composition-safe-submit"), compositionSessionId: otherSession!.id })).resolves.toMatchObject({ id: expect.any(String) });
    const [unchanged] = await database.select().from(prospectCompositionSessions).where(eq(prospectCompositionSessions.id, otherSession!.id));
    expect(unchanged.submitted).toBe(false);
  });

  it("S8: la lista inviti segnala solo un carrello non vuoto ancora non inviato come prospect da richiamare", async () => {
    const database = await getDb();
    const invitation = await invite(database, "composition-follow-up");
    const session = await openProspectCompositionSession(database, invitation.token);
    await saveProspectCompositionSession(database, { token: invitation.token, sessionId: session!.id, items: [{ productId: PRODUCT_ID, quantity: 1 }] });
    const caller = prospectSimulatorRouter.createCaller({
      req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as TrpcContext["req"], res: {} as TrpcContext["res"],
      user: { id: ACTOR_ID, role: "admin" }, activeCompanyId: EKETO_COMPANY_ID,
    } as TrpcContext);
    const row = (await caller.adminInvitationList()).find((candidate) => candidate.id === invitation.id);
    expect(row).toMatchObject({ hasComposedWithoutSubmitting: true });
  });

  it("S9: il dettaglio sessioni non oltrepassa mai lo scope della company attiva", async () => {
    const database = await getDb();
    const invitation = await invite(database, "composition-company-scope", SOKETO_COMPANY_ID);
    const session = await openProspectCompositionSession(database, invitation.token);
    await saveProspectCompositionSession(database, { token: invitation.token, sessionId: session!.id, items: [{ productId: PRODUCT_ID, quantity: 1 }] });
    await expect(getProspectInvitationCompositionDetail(database, invitation.id, EKETO_COMPANY_ID)).rejects.toThrow("Invito non trovato");
    await expect(getProspectInvitationCompositionDetail(database, invitation.id, SOKETO_COMPANY_ID)).resolves.toMatchObject({ sessions: [{ id: session!.id }] });
  });

  it("P1: upgrade Partner → Premium conserva il tier reale Partner e calcola prezzi Premium", async () => {
    const database = await getDb();
    await database.execute(sql`UPDATE products SET "unitPrice" = 100.00 WHERE id = ${PRODUCT_ID}::uuid`);
    const now = new Date();
    const promotion = await createProspectTierUpgradePromotion(database, EKETO_COMPANY_ID, ACTOR_ID, {
      title: "Benvenuto Premium",
      publicDescription: "Raggiungi Partner e ottieni i prezzi Premium sul primo ordine.",
      validFrom: new Date(now.getTime() - 60_000),
      validTo: new Date(now.getTime() + 86_400_000),
      qualifyingTierCode: "partner",
      grantedTierCode: "premium",
      isActive: true,
    });
    const active = await getActiveProspectTierUpgradePromotion(database, EKETO_COMPANY_ID, now);
    const calculation = calculateProspectSimulation(
      await getProspectSimulatorConfig(database, EKETO_COMPANY_ID),
      await getPublicProspectCatalog(database),
      [{ productId: PRODUCT_ID, quantity: 9 }],
      active,
    );
    expect(promotion.id).toBe(active?.promotionId);
    expect(calculation.reachedTier.code).toBe("partner");
    expect(calculation.pricingTier.code).toBe("premium");
    expect(calculation.realTierMerchandiseNet).toBe("527.40");
    expect(calculation.currentTierMerchandiseNet).toBe("503.55");
    expect(calculation.appliedTierUpgrade).toMatchObject({ qualifyingTierCode: "partner", grantedTierCode: "premium" });
  });

  it("P2: submit congela il contratto e conversione mantiene prezzi Premium ma assegna il package Partner", async () => {
    const database = await getDb();
    const now = new Date();
    const existingPromotion = await getActiveProspectTierUpgradePromotion(database, EKETO_COMPANY_ID, now);
    if (!existingPromotion) {
      await createProspectTierUpgradePromotion(database, EKETO_COMPANY_ID, ACTOR_ID, {
        title: "Benvenuto Premium P2", publicDescription: "Prezzi Premium sul primo ordine.", validFrom: new Date(now.getTime() - 60_000), validTo: new Date(now.getTime() + 86_400_000), qualifyingTierCode: "partner", grantedTierCode: "premium", isActive: true,
      });
    }
    await database.execute(sql`UPDATE products SET "unitPrice" = 100.00 WHERE id = ${PRODUCT_ID}::uuid`);
    const invitation = await invite(database, "promo-conversion");
    const submitted = await submitInvitedProspectOrder(database, { token: invitation.token, ...contact("promo-conversion", "IT 55667788990") });
    const [terms] = await database.select().from(prospectOrderCommercialTerms).where(eq(prospectOrderCommercialTerms.simulationId, submitted.id));
    expect(terms).toMatchObject({ realTierCode: "partner", pricingTierCode: "premium", merchandiseNet: "503.55" });
    await database.execute(sql`UPDATE products SET "unitPrice" = 120.00 WHERE id = ${PRODUCT_ID}::uuid`);
    const preview = await previewProspectConversion(database, EKETO_COMPANY_ID, submitted.id);
    expect(preview.usesFrozenCommercialTerms).toBe(true);
    expect(preview.pricingTierCode).toBe("premium");
    expect(preview.pricing.subtotalNet).toBe("503.55");
    const converted = await convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId: submitted.id, actorId: ACTOR_ID, useExistingRetailer: false });
    const [retailer] = await database.select({ pricingPackageId: retailers.pricingPackageId }).from(retailers).where(eq(retailers.id, converted.retailerId));
    const [order] = await database.select({ termsId: orders.prospectCommercialTermsId, subtotal: orders.subtotalNet }).from(orders).where(eq(orders.id, converted.orderId));
    expect(retailer.pricingPackageId).toBe(PARTNER_ID);
    expect(order).toMatchObject({ termsId: terms.id, subtotal: "503.55" });
  });

  it("P3: una seconda campagna live sovrapposta è rifiutata e il lock impedisce il ricalcolo finché la rinuncia non è auditata", async () => {
    const database = await getDb();
    const now = new Date();
    const existingPromotion = await getActiveProspectTierUpgradePromotion(database, EKETO_COMPANY_ID, now);
    if (!existingPromotion) {
      await createProspectTierUpgradePromotion(database, EKETO_COMPANY_ID, ACTOR_ID, {
        title: "Benvenuto Premium P3", publicDescription: "Prezzi Premium sul primo ordine.", validFrom: new Date(now.getTime() - 60_000), validTo: new Date(now.getTime() + 86_400_000), qualifyingTierCode: "partner", grantedTierCode: "premium", isActive: true,
      });
      const invitation = await invite(database, "promo-lock");
      const submitted = await submitInvitedProspectOrder(database, { token: invitation.token, ...contact("promo-lock", "IT 44455566677") });
      await convertProspectSimulation(database, { companyId: EKETO_COMPANY_ID, simulationId: submitted.id, actorId: ACTOR_ID, useExistingRetailer: false });
    }
    await expect(createProspectTierUpgradePromotion(database, EKETO_COMPANY_ID, ACTOR_ID, {
      title: "Sovrapposta", publicDescription: "Non deve essere attivabile.", validFrom: new Date(now.getTime() - 30_000), validTo: new Date(now.getTime() + 60_000), qualifyingTierCode: "partner", grantedTierCode: "premium", isActive: true,
    })).rejects.toThrow("sovrapposta");
    const [lockedOrder] = await database.select({ id: orders.id }).from(orders).where(sql`"prospectCommercialTermsId" IS NOT NULL`).limit(1);
    await expect(modifyOrderItems({ orderId: lockedOrder.id, actorUserId: ACTOR_ID, items: [{ productId: PRODUCT_ID, quantity: 9 }] })).rejects.toThrow("condizioni promozionali prospect congelate");
    const caller = ordersRouter.createCaller({ req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as TrpcContext["req"], res: {} as TrpcContext["res"], user: { id: ACTOR_ID, role: "admin" }, activeCompanyId: EKETO_COMPANY_ID } as TrpcContext);
    await expect(caller.releaseProspectCommercialTerms({ orderId: lockedOrder.id, reason: "Quantità rinegoziata con il prospect" })).resolves.toMatchObject({ released: true });
    const [released] = await database.select({ at: orders.prospectCommercialTermsReleasedAt, by: orders.prospectCommercialTermsReleasedBy, reason: orders.prospectCommercialTermsReleaseReason }).from(orders).where(eq(orders.id, lockedOrder.id));
    expect(released).toMatchObject({ by: ACTOR_ID, reason: "Quantità rinegoziata con il prospect" });
    expect(released.at).toBeInstanceOf(Date);
    await expect(modifyOrderItems({ orderId: lockedOrder.id, actorUserId: ACTOR_ID, items: [{ productId: PRODUCT_ID, quantity: 9 }] })).resolves.toMatchObject({ success: true });
  });

  it("P4: una campagna E-Keto non è mai risolta né applicata agli inviti SoKeto", async () => {
    const database = await getDb();
    expect(await getActiveProspectTierUpgradePromotion(database, SOKETO_COMPANY_ID)).toBeNull();
    const invitation = await invite(database, "promo-soketo-isolation", SOKETO_COMPANY_ID);
    const opened = await resolvePublicInvitation(database, invitation.token);
    expect(opened).toMatchObject({ available: true, invitation: { companyId: SOKETO_COMPANY_ID } });
    const submitted = await submitInvitedProspectOrder(database, { token: invitation.token, ...contact("promo-soketo-isolation", "IT 91929394950") });
    const [terms] = await database.select().from(prospectOrderCommercialTerms).where(eq(prospectOrderCommercialTerms.simulationId, submitted.id));
    expect(terms).toBeUndefined();
  });
});
