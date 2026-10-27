import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  prospectPromotionBenefits,
  prospectPromotions,
  prospectPromotionServicePackages,
} from "../../drizzle/schema";
import {
  getProspectSimulatorConfig,
  normalizeProspectTiers,
  type ProspectSimulationCalculation,
  type ProspectTierUpgradePromotion,
} from "./prospectSimulationService";

type Database = any;

export type TierUpgradePromotionInput = {
  title: string;
  publicDescription: string;
  internalNotes?: string | null;
  validFrom: Date;
  validTo: Date;
  qualifyingTierCode: string;
  grantedTierCode: string;
  isActive: boolean;
};

export type ProspectCommercialOrderItemSnapshot = {
  productId: string;
  productSku: string;
  productName: string;
  quantity: number;
  unitPriceBase: string;
  discountPercent: string;
  unitPriceFinal: string;
  vatRate: string;
  lineTotalNet: string;
  lineTotalGross: string;
};

export type ProspectTierUpgradeTermsValues = {
  promotionId: string;
  realTierCode: string;
  pricingTierCode: string;
  appliedBenefitsSnapshot: Array<{
    type: "tier_upgrade" | "service_package";
    title: string;
    qualifyingTierCode: string;
    grantedTierCode: string;
  }>;
  pricedItemsSnapshot: ProspectCommercialOrderItemSnapshot[];
  merchandiseNet: string;
  shippingNet: string;
  shippingVatRate: string | null;
  shippingVatAmount: string;
  freeShippingApplied: boolean;
  vatAmount: string;
  totalGross: string;
  ruleType: "tier_upgrade" | "service_package";
  serviceLineSnapshot: { serviceCode: string; serviceName: string; unitPriceNet: string; vatRate: string; lineTotalNet: string; lineTotalGross: string } | null;
  bonusSnapshot: { amount: string; paymentDeadline: string } | null;
  serviceNet: string;
  serviceVatRate: string | null;
  serviceVatAmount: string;
};

const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2);

/**
 * Trasforma il calcolo prospect già autorevole nel contratto prezzo del primo
 * ordine. Non contempla spedizione o omaggi: entrambi restano inerti in V1.
 */
export function buildProspectTierUpgradeTerms(
  calculation: ProspectSimulationCalculation,
): ProspectTierUpgradeTermsValues | null {
  const promotion = calculation.appliedTierUpgrade;
  if (!promotion) return null;
  const pricedItemsSnapshot = calculation.items.map((item) => {
    const appliedPrice = item.tierPrices.find((tier) => tier.tierCode === calculation.pricingTier.code);
    if (!appliedPrice) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Prezzo promo non risolto" });
    const lineTotalNet = Number(appliedPrice.lineNet);
    const vatRate = Number(item.vatRate);
    return {
      productId: item.id,
      productSku: item.sku,
      productName: item.name,
      quantity: item.quantity,
      unitPriceBase: item.unitListNet,
      discountPercent: Number(calculation.pricingTier.discount_percent).toFixed(2),
      unitPriceFinal: appliedPrice.unitNet,
      vatRate: money(vatRate),
      lineTotalNet: money(lineTotalNet),
      lineTotalGross: money(lineTotalNet * (1 + vatRate / 100)),
    } satisfies ProspectCommercialOrderItemSnapshot;
  });
  return {
    promotionId: promotion.promotionId,
    realTierCode: calculation.reachedTier.code,
    pricingTierCode: calculation.pricingTier.code,
    appliedBenefitsSnapshot: [{
      type: "tier_upgrade",
      title: promotion.title,
      qualifyingTierCode: promotion.qualifyingTierCode,
      grantedTierCode: promotion.grantedTierCode,
    }],
    pricedItemsSnapshot,
    merchandiseNet: calculation.currentTierMerchandiseNet,
    shippingNet: calculation.shippingNet,
    shippingVatRate: calculation.shippingVatRate,
    shippingVatAmount: calculation.shippingVatAmount,
    freeShippingApplied: calculation.freeShippingApplied,
    vatAmount: calculation.vatAmount,
    totalGross: calculation.totalGross,
    ruleType: "tier_upgrade",
    serviceLineSnapshot: null,
    bonusSnapshot: null,
    serviceNet: "0.00",
    serviceVatRate: null,
    serviceVatAmount: "0.00",
  };
}

export function buildProspectPromotionTerms(calculation: ProspectSimulationCalculation): ProspectTierUpgradeTermsValues | null {
  if (calculation.appliedTierUpgrade) return buildProspectTierUpgradeTerms(calculation);
  const promotion = calculation.appliedServicePackage;
  if (!promotion || !calculation.serviceLine) return null;
  const pricedItemsSnapshot = calculation.items.map((item) => {
    const appliedPrice = item.tierPrices.find((tier) => tier.tierCode === calculation.pricingTier.code);
    if (!appliedPrice) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Prezzo pacchetto non risolto" });
    const lineTotalNet = Number(appliedPrice.lineNet); const vatRate = Number(item.vatRate);
    return { productId: item.id, productSku: item.sku, productName: item.name, quantity: item.quantity, unitPriceBase: item.unitListNet, discountPercent: Number(calculation.pricingTier.discount_percent).toFixed(2), unitPriceFinal: appliedPrice.unitNet, vatRate: money(vatRate), lineTotalNet: money(lineTotalNet), lineTotalGross: money(lineTotalNet * (1 + vatRate / 100)) } satisfies ProspectCommercialOrderItemSnapshot;
  });
  const service = calculation.serviceLine;
  return { promotionId: promotion.promotionId, realTierCode: calculation.reachedTier.code, pricingTierCode: calculation.pricingTier.code,
    appliedBenefitsSnapshot: [{ type: "service_package", title: promotion.title, qualifyingTierCode: calculation.reachedTier.code, grantedTierCode: promotion.assignedTierCode }],
    pricedItemsSnapshot, merchandiseNet: calculation.currentTierMerchandiseNet, shippingNet: calculation.shippingNet, shippingVatRate: calculation.shippingVatRate, shippingVatAmount: calculation.shippingVatAmount, freeShippingApplied: calculation.freeShippingApplied,
    vatAmount: calculation.vatAmount, totalGross: calculation.totalGross, ruleType: "service_package", serviceLineSnapshot: { serviceCode: service.serviceCode, serviceName: service.serviceName, unitPriceNet: service.net, vatRate: service.vatRate, lineTotalNet: service.net, lineTotalGross: service.gross },
    bonusSnapshot: promotion.bonusAmount && promotion.bonusPaymentDeadline ? { amount: promotion.bonusAmount, paymentDeadline: promotion.bonusPaymentDeadline } : null,
    serviceNet: service.net, serviceVatRate: service.vatRate, serviceVatAmount: service.vatAmount,
  };
}

function mapTierUpgradePromotion(row: {
  id: string;
  title: string;
  publicDescription: string;
  validFrom: Date;
  validTo: Date;
  qualifyingTierCode: string | null;
  grantedTierCode: string | null;
}): ProspectTierUpgradePromotion {
  if (!row.qualifyingTierCode || !row.grantedTierCode) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Campagna tier upgrade incompleta" });
  }
  return {
    promotionId: row.id,
    title: row.title,
    publicDescription: row.publicDescription,
    validFrom: row.validFrom,
    validTo: row.validTo,
    qualifyingTierCode: row.qualifyingTierCode,
    grantedTierCode: row.grantedTierCode,
  };
}

/** Risoluzione server-side dell’unica campagna live prevista dalla 0042. */
export async function getActiveProspectTierUpgradePromotion(
  database: Database,
  companyId: string,
  now = new Date(),
): Promise<ProspectTierUpgradePromotion | null> {
  const rows = await database.select({
    id: prospectPromotions.id,
    title: prospectPromotions.title,
    publicDescription: prospectPromotions.publicDescription,
    validFrom: prospectPromotions.validFrom,
    validTo: prospectPromotions.validTo,
    qualifyingTierCode: prospectPromotionBenefits.qualifyingTierCode,
    grantedTierCode: prospectPromotionBenefits.grantedTierCode,
  }).from(prospectPromotions)
    .innerJoin(prospectPromotionBenefits, eq(prospectPromotionBenefits.promotionId, prospectPromotions.id))
    .where(and(
      eq(prospectPromotions.companyId, companyId),
      eq(prospectPromotions.isActive, true),
      eq(prospectPromotions.ruleType, "tier_upgrade"),
      lte(prospectPromotions.validFrom, now),
      gt(prospectPromotions.validTo, now),
      eq(prospectPromotionBenefits.benefitType, "tier_upgrade"),
    ))
    .limit(2);

  if (rows.length > 1) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Sono presenti più campagne tier upgrade attive per questa company" });
  }
  return rows[0] ? mapTierUpgradePromotion(rows[0]) : null;
}

async function validateTierUpgradeInput(
  database: Database,
  companyId: string,
  input: Pick<TierUpgradePromotionInput, "qualifyingTierCode" | "grantedTierCode" | "validFrom" | "validTo">,
) {
  if (input.validTo <= input.validFrom) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "La data fine deve essere successiva alla data inizio" });
  }
  const config = await getProspectSimulatorConfig(database, companyId);
  const tiers = normalizeProspectTiers(config.tiers);
  const qualifyingIndex = tiers.findIndex((tier) => tier.code === input.qualifyingTierCode);
  const grantedIndex = tiers.findIndex((tier) => tier.code === input.grantedTierCode);
  if (qualifyingIndex < 0 || grantedIndex < 0 || grantedIndex <= qualifyingIndex) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Il tier concesso deve essere una fascia prospect configurata e più favorevole di quella qualificante",
    });
  }
}

function promotionWriteValues(input: TierUpgradePromotionInput) {
  return {
    title: input.title.trim(),
    publicDescription: input.publicDescription.trim(),
    internalNotes: input.internalNotes?.trim() || null,
    validFrom: input.validFrom,
    validTo: input.validTo,
    isActive: input.isActive,
  };
}

export async function listProspectTierUpgradePromotions(database: Database, companyId: string) {
  return database.select({
    id: prospectPromotions.id,
    title: prospectPromotions.title,
    publicDescription: prospectPromotions.publicDescription,
    internalNotes: prospectPromotions.internalNotes,
    validFrom: prospectPromotions.validFrom,
    validTo: prospectPromotions.validTo,
    isActive: prospectPromotions.isActive,
    createdAt: prospectPromotions.createdAt,
    updatedAt: prospectPromotions.updatedAt,
    qualifyingTierCode: prospectPromotionBenefits.qualifyingTierCode,
    grantedTierCode: prospectPromotionBenefits.grantedTierCode,
  }).from(prospectPromotions)
    .innerJoin(prospectPromotionBenefits, eq(prospectPromotionBenefits.promotionId, prospectPromotions.id))
    .where(and(eq(prospectPromotions.companyId, companyId), eq(prospectPromotionBenefits.benefitType, "tier_upgrade")))
    .orderBy(desc(prospectPromotions.validFrom));
}

export async function createProspectTierUpgradePromotion(
  database: Database,
  companyId: string,
  actorId: string,
  input: TierUpgradePromotionInput,
) {
  if (!input.title.trim() || !input.publicDescription.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Titolo e descrizione pubblica sono obbligatori" });
  }
  await validateTierUpgradeInput(database, companyId, input);
  try {
    return await database.transaction(async (tx: Database) => {
      const [promotion] = await tx.insert(prospectPromotions).values({
        companyId,
        createdBy: actorId,
        ...promotionWriteValues(input),
      }).returning();
      await tx.insert(prospectPromotionBenefits).values({
        promotionId: promotion.id,
        benefitType: "tier_upgrade",
        qualifyingTierCode: input.qualifyingTierCode,
        grantedTierCode: input.grantedTierCode,
        sortOrder: 0,
      });
      return promotion;
    });
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23P01") {
      throw new TRPCError({ code: "CONFLICT", message: "Esiste già una campagna prospect attiva sovrapposta per questa company" });
    }
    throw error;
  }
}

export async function updateProspectTierUpgradePromotion(
  database: Database,
  companyId: string,
  actorId: string,
  promotionId: string,
  input: TierUpgradePromotionInput,
) {
  if (!input.title.trim() || !input.publicDescription.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Titolo e descrizione pubblica sono obbligatori" });
  }
  await validateTierUpgradeInput(database, companyId, input);
  try {
    return await database.transaction(async (tx: Database) => {
      const [existing] = await tx.select({ id: prospectPromotions.id }).from(prospectPromotions)
        .where(and(eq(prospectPromotions.id, promotionId), eq(prospectPromotions.companyId, companyId), eq(prospectPromotions.ruleType, "tier_upgrade")))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Campagna prospect non trovata" });
      const [promotion] = await tx.update(prospectPromotions).set({
        ...promotionWriteValues(input),
        updatedBy: actorId,
        updatedAt: new Date(),
      }).where(eq(prospectPromotions.id, promotionId)).returning();
      await tx.update(prospectPromotionBenefits).set({
        qualifyingTierCode: input.qualifyingTierCode,
        grantedTierCode: input.grantedTierCode,
        updatedAt: new Date(),
      }).where(and(
        eq(prospectPromotionBenefits.promotionId, promotionId),
        eq(prospectPromotionBenefits.benefitType, "tier_upgrade"),
      ));
      return promotion;
    });
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23P01") {
      throw new TRPCError({ code: "CONFLICT", message: "Esiste già una campagna prospect attiva sovrapposta per questa company" });
    }
    throw error;
  }
}

export async function deactivateProspectPromotion(database: Database, companyId: string, actorId: string, promotionId: string) {
  const [promotion] = await database.update(prospectPromotions).set({
    isActive: false,
    updatedBy: actorId,
    updatedAt: new Date(),
  }).where(and(eq(prospectPromotions.id, promotionId), eq(prospectPromotions.companyId, companyId))).returning({ id: prospectPromotions.id });
  if (!promotion) throw new TRPCError({ code: "NOT_FOUND", message: "Campagna prospect non trovata" });
  return promotion;
}


export type ProspectServicePackagePromotionInput = {
  title: string; publicDescription: string; internalNotes?: string | null; validFrom: Date; validTo: Date; isActive: boolean;
  assignedTierCode: string; serviceCode: string; serviceName: string; serviceNet: number; serviceVatRate: number; minimumMerchandiseNet: number;
  bonusAmount?: number | null; bonusPaymentDeadline?: string | null;
};
export type ProspectServicePackagePromotion = {
  ruleType: "service_package"; promotionId: string; title: string; publicDescription: string; validFrom: Date; validTo: Date;
  assignedTierCode: string; serviceCode: string; serviceName: string; serviceNet: string; serviceVatRate: string; minimumMerchandiseNet: string;
  bonusAmount: string | null; bonusPaymentDeadline: string | null;
};
export type ProspectActivePromotion = (ProspectTierUpgradePromotion & { ruleType: "tier_upgrade" }) | ProspectServicePackagePromotion;

function conflict(error: unknown): never {
  const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code === "23P01") throw new TRPCError({ code: "CONFLICT", message: "Esiste già una campagna prospect attiva sovrapposta per questa company" });
  throw error;
}
async function validateServicePackageInput(database: Database, companyId: string, input: ProspectServicePackagePromotionInput) {
  if (!input.title.trim() || !input.publicDescription.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Titolo e descrizione pubblica sono obbligatori" });
  if (input.validTo <= input.validFrom) throw new TRPCError({ code: "BAD_REQUEST", message: "La data fine deve essere successiva alla data inizio" });
  const tiers = normalizeProspectTiers((await getProspectSimulatorConfig(database, companyId)).tiers);
  if (!tiers.some((tier) => tier.code === input.assignedTierCode)) throw new TRPCError({ code: "BAD_REQUEST", message: "Il pacchetto assegnato deve corrispondere a una fascia prospect configurata" });
  if (!input.serviceCode.trim() || !input.serviceName.trim() || !Number.isFinite(input.serviceNet) || input.serviceNet <= 0 || ![4, 5, 10, 22].includes(input.serviceVatRate) || !Number.isFinite(input.minimumMerchandiseNet) || input.minimumMerchandiseNet < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Configurazione del servizio non valida" });
  const hasBonus = input.bonusAmount != null || input.bonusPaymentDeadline != null;
  if (hasBonus && (!(input.bonusAmount! > 0) || !Number.isFinite(input.bonusAmount) || !input.bonusPaymentDeadline || !isDateOnly(input.bonusPaymentDeadline))) throw new TRPCError({ code: "BAD_REQUEST", message: "Bonus e data limite pagamento devono essere indicati insieme" });
}
function standardValues(input: ProspectServicePackagePromotionInput) {
  return { title: input.title.trim(), publicDescription: input.publicDescription.trim(), internalNotes: input.internalNotes?.trim() || null, validFrom: input.validFrom, validTo: input.validTo, isActive: input.isActive, ruleType: "service_package" as const };
}
function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
function toDateOnly(value: string | null | undefined) {
  return value == null ? null : isDateOnly(value) ? value : null;
}
export async function getActiveProspectPromotion(database: Database, companyId: string, now = new Date()): Promise<ProspectActivePromotion | null> {
  const rows = await database.select({
    id: prospectPromotions.id, title: prospectPromotions.title, publicDescription: prospectPromotions.publicDescription, validFrom: prospectPromotions.validFrom, validTo: prospectPromotions.validTo, ruleType: prospectPromotions.ruleType,
    qualifyingTierCode: prospectPromotionBenefits.qualifyingTierCode, grantedTierCode: prospectPromotionBenefits.grantedTierCode,
    assignedTierCode: prospectPromotionServicePackages.assignedTierCode, serviceCode: prospectPromotionServicePackages.serviceCode, serviceName: prospectPromotionServicePackages.serviceName, serviceNet: prospectPromotionServicePackages.serviceNet, serviceVatRate: prospectPromotionServicePackages.serviceVatRate, minimumMerchandiseNet: prospectPromotionServicePackages.minimumMerchandiseNet, bonusAmount: prospectPromotionServicePackages.bonusAmount, bonusPaymentDeadline: prospectPromotionServicePackages.bonusPaymentDeadline,
  }).from(prospectPromotions)
    .leftJoin(prospectPromotionBenefits, and(eq(prospectPromotionBenefits.promotionId, prospectPromotions.id), eq(prospectPromotionBenefits.benefitType, "tier_upgrade")))
    .leftJoin(prospectPromotionServicePackages, eq(prospectPromotionServicePackages.promotionId, prospectPromotions.id))
    .where(and(eq(prospectPromotions.companyId, companyId), eq(prospectPromotions.isActive, true), lte(prospectPromotions.validFrom, now), gt(prospectPromotions.validTo, now))).limit(2);
  if (rows.length > 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Sono presenti più campagne prospect attive per questa company" });
  const row = rows[0]; if (!row) return null;
  if (row.ruleType === "tier_upgrade") return { ...mapTierUpgradePromotion(row), ruleType: "tier_upgrade" };
  if (!row.assignedTierCode || !row.serviceCode || !row.serviceName || row.serviceNet == null || row.serviceVatRate == null || row.minimumMerchandiseNet == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Campagna pacchetto servizio incompleta" });
  return { ruleType: "service_package", promotionId: row.id, title: row.title, publicDescription: row.publicDescription, validFrom: row.validFrom, validTo: row.validTo, assignedTierCode: row.assignedTierCode, serviceCode: row.serviceCode, serviceName: row.serviceName, serviceNet: String(row.serviceNet), serviceVatRate: String(row.serviceVatRate), minimumMerchandiseNet: String(row.minimumMerchandiseNet), bonusAmount: row.bonusAmount == null ? null : String(row.bonusAmount), bonusPaymentDeadline: row.bonusPaymentDeadline ? String(row.bonusPaymentDeadline).slice(0, 10) : null };
}
export async function createProspectServicePackagePromotion(database: Database, companyId: string, actorId: string, input: ProspectServicePackagePromotionInput) {
  await validateServicePackageInput(database, companyId, input);
  try { return await database.transaction(async (tx: Database) => {
    const [promotion] = await tx.insert(prospectPromotions).values({ companyId, createdBy: actorId, ...standardValues(input) }).returning();
    await tx.insert(prospectPromotionServicePackages).values({ promotionId: promotion.id, companyId, assignedTierCode: input.assignedTierCode, serviceCode: input.serviceCode.trim(), serviceName: input.serviceName.trim(), serviceNet: money(input.serviceNet), serviceVatRate: money(input.serviceVatRate), minimumMerchandiseNet: money(input.minimumMerchandiseNet), bonusAmount: input.bonusAmount == null ? null : money(input.bonusAmount), bonusPaymentDeadline: toDateOnly(input.bonusPaymentDeadline) });
    return promotion;
  }); } catch (error) { conflict(error); }
}
export async function updateProspectServicePackagePromotion(database: Database, companyId: string, actorId: string, promotionId: string, input: ProspectServicePackagePromotionInput) {
  await validateServicePackageInput(database, companyId, input);
  try { return await database.transaction(async (tx: Database) => {
    const [existing] = await tx.select({ id: prospectPromotions.id }).from(prospectPromotions).where(and(eq(prospectPromotions.id, promotionId), eq(prospectPromotions.companyId, companyId), eq(prospectPromotions.ruleType, "service_package"))).limit(1);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Campagna pacchetto servizio non trovata" });
    const [promotion] = await tx.update(prospectPromotions).set({ ...standardValues(input), updatedBy: actorId, updatedAt: new Date() }).where(eq(prospectPromotions.id, promotionId)).returning();
    await tx.update(prospectPromotionServicePackages).set({ assignedTierCode: input.assignedTierCode, serviceCode: input.serviceCode.trim(), serviceName: input.serviceName.trim(), serviceNet: money(input.serviceNet), serviceVatRate: money(input.serviceVatRate), minimumMerchandiseNet: money(input.minimumMerchandiseNet), bonusAmount: input.bonusAmount == null ? null : money(input.bonusAmount), bonusPaymentDeadline: toDateOnly(input.bonusPaymentDeadline), updatedAt: new Date() }).where(eq(prospectPromotionServicePackages.promotionId, promotionId));
    return promotion;
  }); } catch (error) { conflict(error); }
}
export async function listProspectPromotions(database: Database, companyId: string) {
  return database.select({ id: prospectPromotions.id, title: prospectPromotions.title, publicDescription: prospectPromotions.publicDescription, internalNotes: prospectPromotions.internalNotes, validFrom: prospectPromotions.validFrom, validTo: prospectPromotions.validTo, isActive: prospectPromotions.isActive, ruleType: prospectPromotions.ruleType, qualifyingTierCode: prospectPromotionBenefits.qualifyingTierCode, grantedTierCode: prospectPromotionBenefits.grantedTierCode, assignedTierCode: prospectPromotionServicePackages.assignedTierCode, serviceCode: prospectPromotionServicePackages.serviceCode, serviceName: prospectPromotionServicePackages.serviceName, serviceNet: prospectPromotionServicePackages.serviceNet, serviceVatRate: prospectPromotionServicePackages.serviceVatRate, minimumMerchandiseNet: prospectPromotionServicePackages.minimumMerchandiseNet, bonusAmount: prospectPromotionServicePackages.bonusAmount, bonusPaymentDeadline: prospectPromotionServicePackages.bonusPaymentDeadline }).from(prospectPromotions).leftJoin(prospectPromotionBenefits, and(eq(prospectPromotionBenefits.promotionId, prospectPromotions.id), eq(prospectPromotionBenefits.benefitType, "tier_upgrade"))).leftJoin(prospectPromotionServicePackages, eq(prospectPromotionServicePackages.promotionId, prospectPromotions.id)).where(eq(prospectPromotions.companyId, companyId)).orderBy(desc(prospectPromotions.validFrom));
}

export async function createProspectPromotion(database: Database, companyId: string, actorId: string, input: (TierUpgradePromotionInput & { ruleType?: "tier_upgrade" }) | (ProspectServicePackagePromotionInput & { ruleType: "service_package" })) {
  if (input.ruleType === "service_package") return createProspectServicePackagePromotion(database, companyId, actorId, input);
  return createProspectTierUpgradePromotion(database, companyId, actorId, input);
}
export async function updateProspectPromotion(database: Database, companyId: string, actorId: string, promotionId: string, input: (TierUpgradePromotionInput & { ruleType?: "tier_upgrade" }) | (ProspectServicePackagePromotionInput & { ruleType: "service_package" })) {
  if (input.ruleType === "service_package") return updateProspectServicePackagePromotion(database, companyId, actorId, promotionId, input);
  return updateProspectTierUpgradePromotion(database, companyId, actorId, promotionId, input);
}
