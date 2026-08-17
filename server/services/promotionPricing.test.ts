import { describe, expect, it } from "vitest";
import { applyPromotionDiscount } from "./promotionPricing";

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
});
