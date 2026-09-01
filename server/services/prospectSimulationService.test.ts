import { describe, expect, it } from "vitest";
import { calculateProspectSimulation, normalizeProspectTiers } from "./prospectSimulationService";

const config = {
  companyId: "00000000-0000-0000-0000-000000000002",
  minimumOrderNet: "290.00",
  shippingFeeNet: "18.00",
  freeShippingThresholdNet: "500.00",
  recommendedPublicDiscountPercent: "10.00",
  displayStandThreshold: "790.00",
  privacyPolicyUrl: "https://www.soketo.it/privacy",
  tiers: [
    { code: "starter", name: "Starter", discount_percent: 38.5, minimum_list_net: 0 },
    { code: "partner", name: "Partner", discount_percent: 41.4, minimum_list_net: 500 },
    { code: "premium", name: "Premium", discount_percent: 44.05, minimum_list_net: 790 },
    { code: "elite", name: "Elite", discount_percent: 46.5, minimum_list_net: 1005 },
  ],
};
const food = { id: "11111111-1111-1111-1111-111111111111", sku: "FOOD", name: "Prodotto 10%", category: null, unitListNet: "1.00", vatRate: "10.00", piecesPerUnit: 1, unitLabel: "PZ", simulatorOrder: 1 };
const beer = { id: "22222222-2222-2222-2222-222222222222", sku: "BEER", name: "Birra 22%", category: null, unitListNet: "1.00", vatRate: "22.00", piecesPerUnit: 1, unitLabel: "PZ", simulatorOrder: 2 };

describe("calculateProspectSimulation", () => {
  it("resta Partner quando il Partner netto è 550 EUR e il Premium netto sarebbe 525 EUR", () => {
    const product = { ...food, unitListNet: "938.57" };
    const result = calculateProspectSimulation(config, [product], [{ productId: product.id, quantity: 1 }]);
    expect(result.reachedTier.code).toBe("partner");
    expect(result.currentTierMerchandiseNet).toBe("550.00");
    expect(result.tiers.find((tier) => tier.code === "premium")?.merchandiseNet).toBe("525.13");
    expect(result.nextTier?.additionalMerchandiseNet).toBe("264.87");
  });

  it("assegna Elite a 1.005 EUR netti Elite esatti", () => {
    const product = { ...food, unitListNet: "1878.5047" };
    const result = calculateProspectSimulation(config, [product], [{ productId: product.id, quantity: 1 }]);
    expect(result.tiers.find((tier) => tier.code === "elite")?.merchandiseNet).toBe("1005.00");
    expect(result.reachedTier.code).toBe("elite");
  });

  it("assegna Premium quando Elite è 1.004 EUR ma Premium è 1.050 EUR", () => {
    const product = { ...food, unitListNet: "1877.13" };
    const result = calculateProspectSimulation(config, [product], [{ productId: product.id, quantity: 1 }]);
    expect(result.tiers.find((tier) => tier.code === "elite")?.merchandiseNet).toBe("1004.26");
    expect(result.tiers.find((tier) => tier.code === "premium")?.merchandiseNet).toBe("1050.25");
    expect(result.reachedTier.code).toBe("premium");
  });

  it("rispetta i bordi esatti di Partner, Premium ed Elite sul netto pagato", () => {
    const partner = calculateProspectSimulation(config, [{ ...food, unitListNet: "853.2423" }], [{ productId: food.id, quantity: 1 }]);
    const premium = calculateProspectSimulation(config, [{ ...food, unitListNet: "1411.9750" }], [{ productId: food.id, quantity: 1 }]);
    const elite = calculateProspectSimulation(config, [{ ...food, unitListNet: "1878.5047" }], [{ productId: food.id, quantity: 1 }]);
    expect(partner.reachedTier.code).toBe("partner");
    expect(partner.currentTierMerchandiseNet).toBe("500.00");
    expect(premium.reachedTier.code).toBe("premium");
    expect(premium.currentTierMerchandiseNet).toBe("790.00");
    expect(elite.reachedTier.code).toBe("elite");
    expect(elite.currentTierMerchandiseNet).toBe("1005.00");
  });

  it("applica spedizione ed espositore sul netto scontato della fascia raggiunta", () => {
    const atShippingThreshold = calculateProspectSimulation(config, [{ ...food, unitListNet: "853.2423" }], [{ productId: food.id, quantity: 1 }]);
    const overShippingThreshold = calculateProspectSimulation(config, [{ ...food, unitListNet: "853.25" }], [{ productId: food.id, quantity: 1 }]);
    const atDisplayThreshold = calculateProspectSimulation(config, [{ ...food, unitListNet: "1411.9750" }], [{ productId: food.id, quantity: 1 }]);
    const overDisplayThreshold = calculateProspectSimulation(config, [{ ...food, unitListNet: "1411.99" }], [{ productId: food.id, quantity: 1 }]);
    expect(atShippingThreshold.currentTierMerchandiseNet).toBe("500.00");
    expect(atShippingThreshold.freeShippingApplied).toBe(false);
    expect(overShippingThreshold.freeShippingApplied).toBe(true);
    expect(atDisplayThreshold.currentTierMerchandiseNet).toBe("790.00");
    expect(atDisplayThreshold.displayStandUnlocked).toBe(false);
    expect(overDisplayThreshold.displayStandUnlocked).toBe(true);
  });

  it("calcola il margine sul listino netto e lo rende identico allo sconto di ogni fascia", () => {
    const result = calculateProspectSimulation(config, [food, beer], [{ productId: food.id, quantity: 1 }, { productId: beer.id, quantity: 1 }]);
    const expectedDiscounts = { starter: "38.50", partner: "41.40", premium: "44.05", elite: "46.50" };
    for (const tier of result.tiers) {
      expect(tier.potentialMarginPercent).toBe(expectedDiscounts[tier.code as keyof typeof expectedDiscounts]);
    }
    for (const item of result.items) {
      for (const tierPrice of item.tierPrices) {
        expect(tierPrice.potentialMarginPercent).toBe(expectedDiscounts[tierPrice.tierCode as keyof typeof expectedDiscounts]);
      }
    }
  });

  it("non usa recommended_public_discount_percent nel calcolo del margine", () => {
    const result = calculateProspectSimulation({ ...config, recommendedPublicDiscountPercent: "99.00" }, [food], [{ productId: food.id, quantity: 1 }]);
    expect(result.tiers.map((tier) => tier.potentialMarginPercent)).toEqual(["38.50", "41.40", "44.05", "46.50"]);
  });

  it("restituisce per ogni prodotto i quattro prezzi unitari usati dalla tabella a fasce", () => {
    const listPrice100 = { ...food, unitListNet: "100.00" };
    const result = calculateProspectSimulation(config, [listPrice100], [{ productId: listPrice100.id, quantity: 2 }]);
    expect(result.items[0]?.tierPrices.map((price) => ({ code: price.tierCode, unitNet: price.unitNet }))).toEqual([
      { code: "starter", unitNet: "61.50" },
      { code: "partner", unitNet: "58.60" },
      { code: "premium", unitNet: "55.95" },
      { code: "elite", unitNet: "53.50" },
    ]);
  });

  it.each([0, -1, 1.5])("rifiuta quantità %s", (quantity) => {
    expect(() => calculateProspectSimulation(config, [food], [{ productId: food.id, quantity }])).toThrow("quantità");
  });

  it("rifiuta prodotti non esposti nel catalogo", () => {
    expect(() => calculateProspectSimulation(config, [food], [{ productId: beer.id, quantity: 1 }])).toThrow("non sono disponibili");
  });

  it("rifiuta una configurazione fasce incompleta", () => {
    expect(() => normalizeProspectTiers(config.tiers.slice(0, 3))).toThrow("Configurazione fasce");
  });
});
