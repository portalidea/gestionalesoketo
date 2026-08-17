import { describe, expect, it } from "vitest";
import { applyPromotionDiscount, selectPromotionForProduct } from "./promotionPricing";

describe("applyPromotionDiscount", () => {
  it("applica il 15% al prezzo già scontato del tier", () => {
    // Listino 7,70 €, tier Elite -46,5% = 4,12 €; promo ulteriore -15% = 3,50 €.
    expect(applyPromotionDiscount(4.12, 15)).toBe(3.5);
  });

  it("arrotonda correttamente a due decimali", () => {
    expect(applyPromotionDiscount(4.13, 15)).toBe(3.51);
  });

  it("protegge da percentuali non valide", () => {
    expect(applyPromotionDiscount(10, -10)).toBe(10);
    expect(applyPromotionDiscount(10, 150)).toBe(0);
  });

  it("dà precedenza alla promo specifica e non cumula quella generale", () => {
    const selected = selectPromotionForProduct("brioche-cacao", [
      { id: "general-20", title: "Promo generale", discountPercent: 20, productId: null },
      { id: "specific-15", title: "Promo cacao", discountPercent: 15, productId: "brioche-cacao" },
    ]);

    expect(selected?.id).toBe("specific-15");
    expect(applyPromotionDiscount(4.12, selected!.discountPercent)).toBe(3.5);
  });

  it("sceglie lo sconto maggiore fra promo dello stesso ambito", () => {
    const selected = selectPromotionForProduct("brioche-cacao", [
      { id: "general-10", title: "Promo generale 10", discountPercent: 10, productId: null },
      { id: "general-20", title: "Promo generale 20", discountPercent: 20, productId: null },
      { id: "specific-15", title: "Promo cacao 15", discountPercent: 15, productId: "brioche-cacao" },
      { id: "specific-25", title: "Promo cacao 25", discountPercent: 25, productId: "brioche-cacao" },
    ]);

    expect(selected?.id).toBe("specific-25");
  });
});
