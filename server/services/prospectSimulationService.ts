import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  products,
  prospectSimulationItems,
  prospectSimulations,
  prospectSimulatorConfig,
} from "../../drizzle/schema";
import { SOKETO_COMPANY_ID } from "../../shared/const";
import { getDb } from "../db";
import { sendProspectSimulationNotification, type ProspectNotificationResult } from "./prospectNotificationService";

/** Importi interni in diecimillesimi di euro: sconto e margine restano coerenti prima dell'arrotondamento UI. */
const money = (scaled: number) => (Math.round(scaled / 100) / 100).toFixed(2);
const toCents = (value: string | number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Prezzo catalogo non valido" });
  return Math.round(parsed * 10_000);
};
const percentToBasisPoints = (value: string | number) => Math.round(Number(value) * 100);
const applyPercent = (cents: number, percentBasisPoints: number) => Math.round((cents * percentBasisPoints) / 10_000);

const tierSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  discount_percent: z.number().min(0).max(100),
  minimum_list_net: z.number().min(0),
});

export type ProspectTier = z.infer<typeof tierSchema>;
export type ProspectConfig = {
  companyId: string;
  minimumOrderNet: string;
  shippingFeeNet: string;
  freeShippingThresholdNet: string;
  recommendedPublicDiscountPercent: string;
  displayStandThreshold: string;
  privacyPolicyUrl: string;
  tiers: unknown;
};

export type ProspectCatalogProduct = {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  unitListNet: string;
  vatRate: string;
  piecesPerUnit: number;
  unitLabel: string;
  simulatorOrder: number | null;
};

export type ProspectCartItemInput = { productId: string; quantity: number };

export type ProspectSimulationCalculation = {
  listSubtotalNet: string;
  reachedTier: ProspectTier;
  nextTier: (ProspectTier & { additionalListNet: string }) | null;
  recommendedPublicDiscountPercent: string;
  currentTierMerchandiseNet: string;
  minimumOrderNet: string;
  meetsMinimumOrder: boolean;
  shippingNet: string;
  freeShippingApplied: boolean;
  displayStandUnlocked: boolean;
  displayStandThreshold: string;
  tiers: Array<ProspectTier & {
    merchandiseNet: string;
    potentialMarginNet: string;
    potentialMarginPercent: string;
  }>;
  items: Array<ProspectCatalogProduct & {
    quantity: number;
    lineListNet: string;
    recommendedPublicNet: string;
    recommendedPublicGross: string;
    tierPrices: Array<{ tierCode: string; tierName: string; unitNet: string; lineNet: string; potentialMarginNet: string; potentialMarginPercent: string }>;
  }>;
};

export function normalizeProspectTiers(rawTiers: unknown): ProspectTier[] {
  const parsed = z.array(tierSchema).length(4).safeParse(rawTiers);
  if (!parsed.success) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Configurazione fasce prospect non valida" });
  const tiers = [...parsed.data].sort((a, b) => a.minimum_list_net - b.minimum_list_net);
  const codes = new Set(tiers.map((tier) => tier.code));
  if (codes.size !== 4 || tiers[0]?.minimum_list_net !== 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Le fasce prospect devono avere quattro codici univoci e iniziare da soglia 0" });
  }
  if (tiers.some((tier, index) => index > 0 && tier.minimum_list_net <= (tiers[index - 1]?.minimum_list_net ?? -1))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Le soglie delle fasce prospect devono essere strettamente crescenti" });
  }
  return tiers;
}

/** Calcolo autonomo del simulatore: non chiama calculateOrderPricing e non legge tier retailer. */
export function calculateProspectSimulation(
  config: ProspectConfig,
  catalog: ProspectCatalogProduct[],
  requestedItems: ProspectCartItemInput[],
): ProspectSimulationCalculation {
  if (requestedItems.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Inserisci almeno un prodotto" });
  const quantities = new Map<string, number>();
  for (const item of requestedItems) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Le quantità devono essere numeri interi maggiori di zero" });
    }
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }
  const productById = new Map(catalog.map((product) => [product.id, product]));
  if (Array.from(quantities.keys()).some((id) => !productById.has(id))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Uno o più prodotti non sono disponibili nel simulatore" });
  }

  const tiers = normalizeProspectTiers(config.tiers);
  const catalogItems = Array.from(quantities.entries()).map(([productId, quantity]) => {
    const product = productById.get(productId)!;
    const unitListNetCents = toCents(product.unitListNet);
    if (unitListNetCents <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Il prezzo di listino di ${product.name} non è disponibile` });
    return { product, quantity, unitListNetCents, lineListNetCents: unitListNetCents * quantity };
  });
  const listSubtotalCents = catalogItems.reduce((total, item) => total + item.lineListNetCents, 0);
  const reachedTier = [...tiers].reverse().find((tier) => listSubtotalCents >= toCents(tier.minimum_list_net))!;
  const nextTier = tiers.find((tier) => tier.minimum_list_net > listSubtotalCents / 10_000) ?? null;
  const recommendedDiscountBasisPoints = percentToBasisPoints(config.recommendedPublicDiscountPercent);
  const tierTotals = new Map<string, { merchandiseNetCents: number; marginNetCents: number; recommendedNetCents: number }>();

  const items = catalogItems.map(({ product, quantity, unitListNetCents, lineListNetCents }) => {
    const recommendedPublicNetCents = applyPercent(unitListNetCents, 10_000 - recommendedDiscountBasisPoints);
    const recommendedPublicGrossCents = applyPercent(recommendedPublicNetCents, 10_000 + percentToBasisPoints(product.vatRate));
    const tierPrices = tiers.map((tier) => {
      const unitNetCents = applyPercent(unitListNetCents, 10_000 - percentToBasisPoints(tier.discount_percent));
      const lineNetCents = unitNetCents * quantity;
      const potentialMarginNetCents = (recommendedPublicNetCents - unitNetCents) * quantity;
      const previous = tierTotals.get(tier.code) ?? { merchandiseNetCents: 0, marginNetCents: 0, recommendedNetCents: 0 };
      tierTotals.set(tier.code, {
        merchandiseNetCents: previous.merchandiseNetCents + lineNetCents,
        marginNetCents: previous.marginNetCents + potentialMarginNetCents,
        recommendedNetCents: previous.recommendedNetCents + recommendedPublicNetCents * quantity,
      });
      return {
        tierCode: tier.code,
        tierName: tier.name,
        unitNet: money(unitNetCents),
        lineNet: money(lineNetCents),
        potentialMarginNet: money(potentialMarginNetCents),
        potentialMarginPercent: recommendedPublicNetCents > 0 ? ((potentialMarginNetCents / (recommendedPublicNetCents * quantity)) * 100).toFixed(2) : "0.00",
      };
    });
    return {
      ...product,
      quantity,
      lineListNet: money(lineListNetCents),
      recommendedPublicNet: money(recommendedPublicNetCents),
      recommendedPublicGross: money(recommendedPublicGrossCents),
      tierPrices,
    };
  });

  const currentMerchandiseCents = tierTotals.get(reachedTier.code)!.merchandiseNetCents;
  const minimumOrderCents = toCents(config.minimumOrderNet);
  const freeShippingThresholdCents = toCents(config.freeShippingThresholdNet);
  const freeShippingApplied = currentMerchandiseCents > freeShippingThresholdCents;
  const shippingCents = freeShippingApplied ? 0 : toCents(config.shippingFeeNet);

  return {
    listSubtotalNet: money(listSubtotalCents),
    reachedTier,
    nextTier: nextTier ? { ...nextTier, additionalListNet: money(toCents(nextTier.minimum_list_net) - listSubtotalCents) } : null,
    recommendedPublicDiscountPercent: Number(config.recommendedPublicDiscountPercent).toFixed(2),
    currentTierMerchandiseNet: money(currentMerchandiseCents),
    minimumOrderNet: money(minimumOrderCents),
    meetsMinimumOrder: currentMerchandiseCents >= minimumOrderCents,
    shippingNet: money(shippingCents),
    freeShippingApplied,
    displayStandUnlocked: listSubtotalCents > toCents(config.displayStandThreshold),
    displayStandThreshold: money(toCents(config.displayStandThreshold)),
    tiers: tiers.map((tier) => {
      const totals = tierTotals.get(tier.code)!;
      return {
        ...tier,
        merchandiseNet: money(totals.merchandiseNetCents),
        potentialMarginNet: money(totals.marginNetCents),
        potentialMarginPercent: totals.recommendedNetCents > 0 ? ((totals.marginNetCents / totals.recommendedNetCents) * 100).toFixed(2) : "0.00",
      };
    }),
    items,
  };
}

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function getProspectSimulatorConfig(database: Database, companyId = SOKETO_COMPANY_ID): Promise<ProspectConfig> {
  const [config] = await database.select().from(prospectSimulatorConfig).where(eq(prospectSimulatorConfig.companyId, companyId)).limit(1);
  if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Il simulatore non è ancora disponibile" });
  return config;
}

export async function getPublicProspectCatalog(database: Database): Promise<ProspectCatalogProduct[]> {
  const rows = await database.select({
    id: products.id,
    sku: products.sku,
    name: products.name,
    category: products.category,
    unitListNet: products.unitPrice,
    vatRate: products.vatRate,
    piecesPerUnit: products.piecesPerUnit,
    unitLabel: products.sellableUnitLabel,
    simulatorOrder: products.simulatorOrder,
  }).from(products).where(eq(products.showInSimulator, true)).orderBy(products.simulatorOrder, products.name);
  return rows.map((row) => ({ ...row, unitListNet: row.unitListNet ?? "", vatRate: row.vatRate ?? "10.00", piecesPerUnit: row.piecesPerUnit ?? 1, unitLabel: row.unitLabel ?? "PZ" }));
}

export type ProspectContactInput = {
  legalName: string;
  contactName: string;
  email: string;
  phone: string;
  businessType: string;
  city: string;
  vatNumber: string;
  privacyAccepted: true;
  website?: string;
  items: ProspectCartItemInput[];
};

export async function createProspectSimulation(
  database: Database,
  input: ProspectContactInput,
  notify: typeof sendProspectSimulationNotification = sendProspectSimulationNotification,
) {
  if (input.website?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Richiesta non valida" });
  const config = await getProspectSimulatorConfig(database);
  const ids = Array.from(new Set(input.items.map((item) => item.productId)));
  const catalog = await getPublicProspectCatalog(database);
  const calculation = calculateProspectSimulation(config, catalog.filter((product) => ids.includes(product.id)), input.items);
  const [simulation] = await database.transaction(async (tx) => {
    const [created] = await tx.insert(prospectSimulations).values({
      companyId: config.companyId,
      legalName: input.legalName.trim(),
      contactName: input.contactName.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone.trim(),
      businessType: input.businessType.trim(),
      city: input.city.trim(),
      vatNumber: input.vatNumber.trim().toUpperCase(),
      privacyAcceptedAt: new Date(),
      privacyPolicyUrl: config.privacyPolicyUrl,
      listSubtotalNet: calculation.listSubtotalNet,
      reachedTierCode: calculation.reachedTier.code,
      calculationSnapshot: calculation,
      status: "new",
      notificationStatus: "pending",
    }).returning();
    await tx.insert(prospectSimulationItems).values(calculation.items.map((item, sortOrder) => ({
      simulationId: created.id,
      productId: item.id,
      productSkuSnapshot: item.sku,
      productNameSnapshot: item.name,
      quantity: item.quantity,
      piecesPerUnitSnapshot: item.piecesPerUnit,
      unitListNetSnapshot: item.unitListNet,
      vatRateSnapshot: item.vatRate,
      lineListNet: item.lineListNet,
      sortOrder,
    })));
    return [created];
  });

  const notification = await notify({
    simulationId: simulation.id,
    legalName: simulation.legalName,
    contactName: simulation.contactName,
    email: simulation.email,
    phone: simulation.phone,
    businessType: simulation.businessType,
    city: simulation.city,
    vatNumber: simulation.vatNumber,
    listSubtotalNet: calculation.listSubtotalNet,
    reachedTierName: calculation.reachedTier.name,
    itemCount: calculation.items.length,
  });
  await database.update(prospectSimulations).set(
    notification.sent
      ? { notificationStatus: "sent", notificationSentAt: new Date(), notificationError: null }
      : { notificationStatus: "failed", notificationError: notification.errorMessage },
  ).where(eq(prospectSimulations.id, simulation.id));

  return { id: simulation.id, calculation, notificationStatus: notification.sent ? "sent" : "failed" };
}

export async function listProspectSimulations(database: Database, companyId: string) {
  return database.select({
    id: prospectSimulations.id,
    legalName: prospectSimulations.legalName,
    contactName: prospectSimulations.contactName,
    email: prospectSimulations.email,
    city: prospectSimulations.city,
    listSubtotalNet: prospectSimulations.listSubtotalNet,
    reachedTierCode: prospectSimulations.reachedTierCode,
    status: prospectSimulations.status,
    notificationStatus: prospectSimulations.notificationStatus,
    notificationError: prospectSimulations.notificationError,
    createdAt: prospectSimulations.createdAt,
  }).from(prospectSimulations).where(eq(prospectSimulations.companyId, companyId)).orderBy(desc(prospectSimulations.createdAt));
}

export async function getProspectSimulationDetail(database: Database, companyId: string, id: string) {
  const [simulation] = await database.select().from(prospectSimulations).where(and(eq(prospectSimulations.id, id), eq(prospectSimulations.companyId, companyId))).limit(1);
  if (!simulation) throw new TRPCError({ code: "NOT_FOUND", message: "Richiesta prospect non trovata" });
  const items = await database.select().from(prospectSimulationItems).where(eq(prospectSimulationItems.simulationId, id)).orderBy(prospectSimulationItems.sortOrder);
  return { simulation, items };
}

const rateWindows = new Map<string, { count: number; expiresAt: number }>();
export function enforceProspectRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const state = rateWindows.get(key);
  if (!state || state.expiresAt <= now) {
    rateWindows.set(key, { count: 1, expiresAt: now + windowMs });
    return;
  }
  if (state.count >= limit) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Troppe richieste. Riprova più tardi." });
  state.count += 1;
}

export function requestIp(headers: Record<string, string | string[] | undefined>, fallback?: string) {
  const forwarded = headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim() || fallback || "unknown";
}
