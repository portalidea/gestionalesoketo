/** F16 — Pure helpers for retailer promotional pricing. */

export type PromotionCandidate = {
  id: string;
  title: string;
  discountPercent: number;
  productId: string | null;
};

/**
 * Selects exactly one applicable promotion. A product-specific promotion
 * always overrides a general promotion; within the same scope the highest
 * percentage wins. Discounts are never stacked.
 */
export function selectPromotionForProduct(
  productId: string,
  promotions: PromotionCandidate[],
): PromotionCandidate | null {
  let bestSpecific: PromotionCandidate | null = null;
  let bestGeneral: PromotionCandidate | null = null;

  for (const promotion of promotions) {
    if (promotion.discountPercent <= 0) continue;
    if (promotion.productId === productId) {
      if (!bestSpecific || promotion.discountPercent > bestSpecific.discountPercent) {
        bestSpecific = promotion;
      }
    } else if (promotion.productId === null) {
      if (!bestGeneral || promotion.discountPercent > bestGeneral.discountPercent) {
        bestGeneral = promotion;
      }
    }
  }

  return bestSpecific ?? bestGeneral;
}

/** Applies a promotion to the price already reserved for the retailer. */
export function applyPromotionDiscount(
  priceBeforePromotion: number,
  promotionDiscountPercent: number,
): number {
  const boundedDiscount = Math.min(100, Math.max(0, promotionDiscountPercent));
  return Math.round(
    (priceBeforePromotion * (1 - boundedDiscount / 100) + Number.EPSILON) * 100,
  ) / 100;
}
