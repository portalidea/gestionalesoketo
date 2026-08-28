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

  it("calcola margine su netti e consigliato lordo con IVA prodotto", () => {
    const result = calculateProspectSimulation(config, [food, beer], [{ productId: food.id, quantity: 1 }, { productId: beer.id, quantity: 1 }]);
    const starter = result.tiers.find((tier) => tier.code === "starter")!;
    expect(result.items[0]?.recommendedPublicNet).toBe("0.90");
    expect(result.items[0]?.recommendedPublicGross).toBe("0.99");
    expect(result.items[1]?.recommendedPublicNet).toBe("0.90");
    expect(result.items[1]?.recommendedPublicGross).toBe("1.10");
    expect(starter.potentialMarginNet).toBe("0.57");
    expect(starter.potentialMarginPercent).toBe("31.67");
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
