/** F16 — Pure helpers for retailer promotional pricing. */

/**
 * Applies a promotion to the price already reserved for the retailer
 * (tier/markup), returning a 2-decimal monetary price.
 */
export function applyPromotionDiscount(
  priceBeforePromotion: number,
  promotionDiscountPercent: number,
): number {
  const boundedDiscount = Math.min(100, Math.max(0, promotionDiscountPercent));
  return Math.round(
    (priceBeforePromotion * (1 - boundedDiscount / 100) + Number.EPSILON) * 100,
  ) / 100;
}
