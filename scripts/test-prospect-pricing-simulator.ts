import assert from "node:assert/strict";
import "dotenv/config";
import { eq } from "drizzle-orm";
import { companies, products, prospectSimulationItems, prospectSimulations, prospectSimulatorConfig } from "../drizzle/schema";
import { getDb } from "../server/db";
import { calculateProspectSimulation, createProspectSimulation, getProspectSimulatorConfig, getPublicProspectCatalog } from "../server/services/prospectSimulationService";

const SOKETO_COMPANY_ID = "00000000-0000-0000-0000-000000000002";
const tiers = [
  { code: "starter", name: "Starter", discount_percent: 38.5, minimum_list_net: 0 },
  { code: "partner", name: "Partner", discount_percent: 41.4, minimum_list_net: 500 },
  { code: "premium", name: "Premium", discount_percent: 44.05, minimum_list_net: 790 },
  { code: "elite", name: "Elite", discount_percent: 46.5, minimum_list_net: 1005 },
];

function marker(name: string, details: Record<string, unknown>) {
  console.log(`${name} PASS ${JSON.stringify(details)}`);
}

async function main() {
  const db = await getDb();
  assert(db, "Database locale non disponibile");
  await db.delete(prospectSimulationItems);
  await db.delete(prospectSimulations);
  await db.delete(prospectSimulatorConfig);
  const existingCompany = await db.select().from(companies).where(eq(companies.id, SOKETO_COMPANY_ID)).limit(1);
  assert(existingCompany[0], "Company SoKeto assente nel seed locale");
  await db.delete(products).where(eq(products.sku, "PROSPECT-HIDDEN-TEST"));
  const seedProducts = await db.select().from(products).limit(2);
  assert(seedProducts.length >= 2, "Servono due prodotti nel seed locale");
  const [food10, beer22] = seedProducts;
  const [hidden] = await db.insert(products).values({
    sku: "PROSPECT-HIDDEN-TEST",
    name: "Prodotto non esposto di test",
    unitPrice: "1.00",
    vatRate: "10.00",
    showInSimulator: false,
  }).returning();
  await db.update(products).set({ showInSimulator: true, simulatorOrder: 1, unitPrice: "1.00", vatRate: "10.00" }).where(eq(products.id, food10.id));
  await db.update(products).set({ showInSimulator: true, simulatorOrder: 2, unitPrice: "1.00", vatRate: "22.00" }).where(eq(products.id, beer22.id));
  await db.insert(prospectSimulatorConfig).values({
    companyId: SOKETO_COMPANY_ID,
    minimumOrderNet: "290.00",
    shippingFeeNet: "18.00",
    freeShippingThresholdNet: "500.00",
    recommendedPublicDiscountPercent: "10.00",
    displayStandThreshold: "790.00",
    privacyPolicyUrl: "https://www.soketo.it/privacy",
    tiers,
  });
  const config = await getProspectSimulatorConfig(db);
  const catalog = await getPublicProspectCatalog(db);
  assert.equal(catalog.length, 2, "Catalogo pubblico deve escludere prodotto hidden");

  for (const [qty, expected] of [[499, "starter"], [500, "partner"], [789, "partner"], [790, "premium"], [1004, "premium"], [1005, "elite"]] as const) {
    const calculated = calculateProspectSimulation(config, catalog, [{ productId: food10.id, quantity: qty }]);
    assert.equal(calculated.reachedTier.code, expected);
  }
  marker("T1_THRESHOLDS", { points: "499,500,789,790,1004,1005", outcomes: "starter,partner,partner,premium,premium,elite" });

  const belowShippingThreshold = calculateProspectSimulation(config, catalog, [{ productId: food10.id, quantity: 893 }]);
  const overShippingThreshold = calculateProspectSimulation(config, catalog, [{ productId: food10.id, quantity: 894 }]);
  const atDisplayThreshold = calculateProspectSimulation(config, catalog, [{ productId: food10.id, quantity: 790 }]);
  const overDisplayThreshold = calculateProspectSimulation(config, catalog, [{ productId: food10.id, quantity: 791 }]);
  assert.equal(belowShippingThreshold.freeShippingApplied, false);
  assert.equal(overShippingThreshold.freeShippingApplied, true);
  assert.equal(atDisplayThreshold.displayStandUnlocked, false);
  assert.equal(overDisplayThreshold.displayStandUnlocked, true);
  marker("T1B_COMMERCIAL_THRESHOLDS", { shippingAfterDiscountAt499_63: false, shippingAfterDiscountAt500_09: true, displayAt790: false, displayOver790: true });

  const mixed = calculateProspectSimulation(config, catalog, [{ productId: food10.id, quantity: 1 }, { productId: beer22.id, quantity: 1 }]);
  assert.equal(mixed.items[0]?.recommendedPublicNet, "0.90");
  assert.equal(mixed.items[0]?.recommendedPublicGross, "0.99");
  assert.equal(mixed.items[1]?.recommendedPublicNet, "0.90");
  assert.equal(mixed.items[1]?.recommendedPublicGross, "1.10");
  assert.equal(mixed.tiers.find((tier) => tier.code === "starter")?.potentialMarginNet, "0.57");
  marker("T2_NET_MARGIN_MIXED_VAT", { foodRecommendedNet: "0.90", foodRecommendedGross10: "0.99", beerRecommendedNet: "0.90", beerRecommendedGross22: "1.10", starterMarginNet: "0.57" });

  for (const quantity of [0, -1]) assert.throws(() => calculateProspectSimulation(config, catalog, [{ productId: food10.id, quantity }]), /quantità/);
  marker("T3_INVALID_QUANTITIES", { rejected: "0,-1" });
  assert.throws(() => calculateProspectSimulation(config, catalog, [{ productId: hidden.id, quantity: 1 }]), /non sono disponibili/);
  marker("T4_HIDDEN_PRODUCT", { hiddenProductId: hidden.id, rejected: true });

  await db.delete(prospectSimulatorConfig);
  await assert.rejects(() => getProspectSimulatorConfig(db), /non è ancora disponibile/);
  marker("T5_MISSING_CONFIG", { available: false });
  await db.insert(prospectSimulatorConfig).values({ companyId: SOKETO_COMPANY_ID, minimumOrderNet: "290", shippingFeeNet: "18", freeShippingThresholdNet: "500", recommendedPublicDiscountPercent: "10", displayStandThreshold: "790", privacyPolicyUrl: "https://www.soketo.it/privacy", tiers });

  const created = await createProspectSimulation(db, {
    legalName: "Prospect Test Srl", contactName: "Giulia Bianchi", email: "giulia@example.test", phone: "3331234567", businessType: "Negozio specializzato", city: "Milano", vatNumber: "IT12345678901", privacyAccepted: true, items: [{ productId: food10.id, quantity: 500 }, { productId: beer22.id, quantity: 1 }],
  }, async () => ({ sent: false, errorMessage: "notifica test deliberatamente non inviata" }));
  const savedItems = await db.select().from(prospectSimulationItems).where(eq(prospectSimulationItems.simulationId, created.id));
  const [saved] = await db.select().from(prospectSimulations).where(eq(prospectSimulations.id, created.id));
  assert.equal(savedItems.length, 2);
  assert.equal(saved.notificationStatus, "failed");
  assert.equal(saved.reachedTierCode, "partner");
  marker("T6_SUBMIT_SNAPSHOT", { simulationId: created.id, itemRows: savedItems.length, notificationStatus: saved.notificationStatus, reachedTier: saved.reachedTierCode, listSubtotalNet: saved.listSubtotalNet });
  console.log("PROSPECT_SIMULATOR_TESTS=PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
