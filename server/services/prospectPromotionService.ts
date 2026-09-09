import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import {
  prospectPromotionBenefits,
  prospectPromotions,
} from "../../drizzle/schema";
import {
  getProspectSimulatorConfig,
  normalizeProspectTiers,
  type ProspectSimulationCalculation,
  type ProspectTierUpgradePromotion,
} from "./prospectSimulationService";

type Database = any;

export type ProspectTierUpgradePromotionInput = {
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
    type: "tier_upgrade";
    title: string;
    qualifyingTierCode: string;
    grantedTierCode: string;
  }>;
  pricedItemsSnapshot: ProspectCommercialOrderItemSnapshot[];
  merchandiseNet: string;
  shippingNet: "0.00";
  shippingVatRate: null;
  shippingVatAmount: "0.00";
  freeShippingApplied: false;
  vatAmount: string;
  totalGross: string;
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
  const vatAmount = pricedItemsSnapshot.reduce((total, item) => total + (Number(item.lineTotalGross) - Number(item.lineTotalNet)), 0);
  const totalGross = pricedItemsSnapshot.reduce((total, item) => total + Number(item.lineTotalGross), 0);
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
    shippingNet: "0.00",
    shippingVatRate: null,
    shippingVatAmount: "0.00",
    freeShippingApplied: false,
    vatAmount: money(vatAmount),
    totalGross: money(totalGross),
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
  input: Pick<ProspectTierUpgradePromotionInput, "qualifyingTierCode" | "grantedTierCode" | "validFrom" | "validTo">,
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

function promotionWriteValues(input: ProspectTierUpgradePromotionInput) {
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
  input: ProspectTierUpgradePromotionInput,
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
  input: ProspectTierUpgradePromotionInput,
) {
  if (!input.title.trim() || !input.publicDescription.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Titolo e descrizione pubblica sono obbligatori" });
  }
  await validateTierUpgradeInput(database, companyId, input);
  try {
    return await database.transaction(async (tx: Database) => {
      const [existing] = await tx.select({ id: prospectPromotions.id }).from(prospectPromotions)
        .where(and(eq(prospectPromotions.id, promotionId), eq(prospectPromotions.companyId, companyId)))
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
