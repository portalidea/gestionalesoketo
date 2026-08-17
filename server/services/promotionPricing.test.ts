import { describe, expect, it } from "vitest";
import { applyPromotionDiscount, canApplyPromotion, selectPromotionForProduct } from "./promotionPricing";

describe("promotion pricing", () => {
  it("applica il 15% al prezzo già scontato del tier", () => {
    expect(applyPromotionDiscount(4.12, 15)).toBe(3.5);
  });

  it("dà precedenza alla promo specifica senza cumulare quella generale", () => {
    const selected = selectPromotionForProduct("brioche-cacao", [
      { id: "general-20", title: "Promo generale", discountPercent: 20, productId: null },
      { id: "specific-15", title: "Promo cacao", discountPercent: 15, productId: "brioche-cacao" },
    ]);
    expect(selected?.id).toBe("specific-15");
    expect(applyPromotionDiscount(4.12, selected!.discountPercent)).toBe(3.5);
  });

  it("sceglie lo sconto maggiore tra promo dello stesso ambito", () => {
    const selected = selectPromotionForProduct("brioche-cacao", [
      { id: "general-10", title: "Generale 10", discountPercent: 10, productId: null },
      { id: "general-20", title: "Generale 20", discountPercent: 20, productId: null },
      { id: "specific-15", title: "Cacao 15", discountPercent: 15, productId: "brioche-cacao" },
      { id: "specific-25", title: "Cacao 25", discountPercent: 25, productId: "brioche-cacao" },
    ]);
    expect(selected?.id).toBe("specific-25");
  });

  it("non applica una promo quando il prezzo riservato è già gratuito", () => {
    const promotion = { id: "promo", title: "Promo", discountPercent: 15, productId: "product" };
    expect(canApplyPromotion(0, promotion)).toBe(false);
    expect(canApplyPromotion(4.12, promotion)).toBe(true);
  });
});
