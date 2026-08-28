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
  it.each([[499, "starter"], [500, "partner"], [789, "partner"], [790, "premium"], [1004, "premium"], [1005, "elite"]])("assegna %s EUR alla fascia %s", (quantity, tierCode) => {
    const result = calculateProspectSimulation(config, [food], [{ productId: food.id, quantity }]);
    expect(result.reachedTier.code).toBe(tierCode);
  });

  it("applica spedizione gratuita ed espositore solo oltre le rispettive soglie", () => {
    const belowShippingThreshold = calculateProspectSimulation(config, [food], [{ productId: food.id, quantity: 893 }]);
    const overShippingThreshold = calculateProspectSimulation(config, [food], [{ productId: food.id, quantity: 894 }]);
    const atDisplayThreshold = calculateProspectSimulation(config, [food], [{ productId: food.id, quantity: 790 }]);
    const overDisplayThreshold = calculateProspectSimulation(config, [food], [{ productId: food.id, quantity: 791 }]);
    expect(belowShippingThreshold.freeShippingApplied).toBe(false);
    expect(overShippingThreshold.freeShippingApplied).toBe(true);
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
