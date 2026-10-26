import { and, eq, sql } from "drizzle-orm";
import {
  orderPromotionBonuses,
  orders,
  pricingPackages,
  prospectOrderCommercialTerms,
  prospectPromotions,
  retailerAllowanceConsumptions,
  retailerAllowances,
} from "../../drizzle/schema";
import { createRetailerAllowance } from "./retailerAllowanceService";

type Database = any;

export type PromotionBonusEvaluation =
  | { kind: "none" }
  | { kind: "already_granted"; allowanceId: string }
  | { kind: "granted"; allowanceId: string }
  | { kind: "expired" };

function romeDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function isWithinDeadline(paidAt: Date, deadline: string | Date) {
  const deadlineDate = deadline instanceof Date
    ? deadline.toISOString().slice(0, 10)
    : String(deadline).slice(0, 10);
  return romeDate(paidAt) <= deadlineDate;
}

function prospectTierPackageName(tierCode: string) {
  const names: Record<string, string> = {
    starter: "Starter",
    partner: "Partner",
    premium: "Premium",
    elite: "Elite",
  };
  const name = names[tierCode.trim().toLowerCase()];
  if (!name) throw new Error(`Pacchetto post-esaurimento prospect non valido: ${tierCode}.`);
  return name;
}

/**
 * Valuta il bonus contro la data economica del pagamento, non contro il momento
 * tecnico della registrazione. Il chiamante deve passare la medesima transazione
 * che registra/annulla il pagamento oppure una connessione che possa applicare i
 * row lock. Il vincolo UNICO su orderId è la seconda barriera di idempotenza.
 */
export async function evaluatePromotionBonusForPayment(
  database: Database,
  input: { orderId: string; actorUserId: string; paidAt: Date },
): Promise<PromotionBonusEvaluation> {
  const [bonus] = await database
    .select()
    .from(orderPromotionBonuses)
    .where(eq(orderPromotionBonuses.orderId, input.orderId))
    .for("update")
    .limit(1);

  if (!bonus) return { kind: "none" };
  if (bonus.status === "granted" && bonus.allowanceId) {
    return { kind: "already_granted", allowanceId: bonus.allowanceId };
  }
  // Una scadenza già valutata è definitiva: una seconda registrazione non deve
  // trasformare un pagamento tardivo in bonus.
  if (bonus.status === "expired") return { kind: "expired" };
  if (bonus.status !== "pending") return { kind: "none" };

  const now = new Date();
  if (!isWithinDeadline(input.paidAt, bonus.paymentDeadline)) {
    await database.update(orderPromotionBonuses).set({
      status: "expired",
      paymentPaidAt: input.paidAt,
      evaluatedAt: now,
      updatedAt: now,
      updatedBy: input.actorUserId,
    }).where(eq(orderPromotionBonuses.id, bonus.id));
    return { kind: "expired" };
  }

  const [order] = await database
    .select({
      id: orders.id,
      retailerId: orders.retailerId,
      companyId: orders.companyId,
      prospectCommercialTermsId: orders.prospectCommercialTermsId,
      orderNumber: orders.orderNumber,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update")
    .limit(1);
  if (!order?.retailerId || !order.prospectCommercialTermsId) {
    throw new Error("Bonus promo privo di ordine prospect o rivenditore.");
  }

  // Il tier congelato nei termini è il pacchetto post-esaurimento contrattuale.
  const [terms] = await database
    .select({ pricingTierCode: prospectOrderCommercialTerms.pricingTierCode })
    .from(prospectOrderCommercialTerms)
    .where(eq(prospectOrderCommercialTerms.id, order.prospectCommercialTermsId))
    .for("update")
    .limit(1);
  if (!terms) throw new Error("Termini commerciali prospect non trovati per il bonus promo.");
  const [postExhaustionPackage] = await database
    .select({ id: pricingPackages.id })
    .from(pricingPackages)
    .where(eq(pricingPackages.name, prospectTierPackageName(terms.pricingTierCode)))
    .limit(1);
  if (!postExhaustionPackage) {
    throw new Error(`Pacchetto post-esaurimento ${terms.pricingTierCode} non configurato.`);
  }
  const [promotion] = await database
    .select({ title: prospectPromotions.title })
    .from(prospectPromotions)
    .where(eq(prospectPromotions.id, bonus.promotionId))
    .limit(1);
  if (!promotion) throw new Error("Campagna prospect non trovata per il bonus promo.");

  const allowance = await createRetailerAllowance(database, {
    retailerId: order.retailerId,
    companyId: order.companyId,
    allowanceType: "promo_bonus",
    sourceAmount: Number(bonus.bonusAmount),
    sourceReference: `Bonus promo ${promotion.title} · ordine ${order.orderNumber}`,
    sourceReceivedAt: input.paidAt,
    activatedAt: input.paidAt,
    initialAmountOverride: Number(bonus.bonusAmount),
    valuationDiscountPercentOverride: 0,
    postExhaustionPricingPackageIdOverride: postExhaustionPackage.id,
    notes: `Bonus promosso dall'ordine ${order.orderNumber}.`,
    createdBy: input.actorUserId,
  });

  await database.update(orderPromotionBonuses).set({
    status: "granted",
    allowanceId: allowance.id,
    paymentPaidAt: input.paidAt,
    evaluatedAt: now,
    grantedAt: now,
    updatedAt: now,
    updatedBy: input.actorUserId,
  }).where(and(eq(orderPromotionBonuses.id, bonus.id), eq(orderPromotionBonuses.status, "pending")));

  return { kind: "granted", allowanceId: allowance.id };
}

/**
 * Revoca auditabile del bonus quando viene annullato il pagamento o l'ordine.
 * Se il credito e' stato consumato, l'allowance viene disattivata e la pratica
 * richiede revisione manuale, senza cancellare alcun movimento storico.
 */
export async function revokePromotionBonusForOrder(
  database: Database,
  input: { orderId: string; actorUserId: string },
) {
  const [bonus] = await database
    .select()
    .from(orderPromotionBonuses)
    .where(eq(orderPromotionBonuses.orderId, input.orderId))
    .for("update")
    .limit(1);
  if (!bonus || bonus.status !== "granted" || !bonus.allowanceId) return { kind: "none" as const };

  const [consumption] = await database
    .select({ amount: sql<string>`COALESCE(SUM(${retailerAllowanceConsumptions.consumptionAmount}), 0)::text` })
    .from(retailerAllowanceConsumptions)
    .where(eq(retailerAllowanceConsumptions.allowanceId, bonus.allowanceId));
  const consumedAmount = Number(consumption?.amount ?? 0);
  const now = new Date();

  await database.update(retailerAllowances).set({
    status: "cancelled",
    updatedAt: now,
  }).where(eq(retailerAllowances.id, bonus.allowanceId));

  if (consumedAmount > 0) {
    await database.update(orderPromotionBonuses).set({
      status: "review_required",
      reviewRequiredAt: now,
      updatedAt: now,
      updatedBy: input.actorUserId,
    }).where(eq(orderPromotionBonuses.id, bonus.id));
    return { kind: "review_required" as const, allowanceId: bonus.allowanceId, consumedAmount };
  }

  await database.update(orderPromotionBonuses).set({
    status: "revoked",
    revokedAt: now,
    updatedAt: now,
    updatedBy: input.actorUserId,
  }).where(eq(orderPromotionBonuses.id, bonus.id));
  return { kind: "revoked" as const, allowanceId: bonus.allowanceId, consumedAmount: 0 };
}

export const _private = { romeDate, isWithinDeadline, prospectTierPackageName };
