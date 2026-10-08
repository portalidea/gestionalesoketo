import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;
process.env.RESEND_API_KEY = "";

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

const ids = {
  premiumPackage: "11111111-1111-1111-1111-111111111991",
  specialPackage: "11111111-1111-1111-1111-111111111992",
  allowance: "22222222-2222-2222-2222-222222222991",
  investorAllowance: "22222222-2222-2222-2222-222222222992",
  portalUser: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaad",
  otherRetailer: "33333333-3333-3333-3333-333333333991",
  otherPortalUser: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaae",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function allowanceTotals() {
  const [row] = await sql<{ consumed: string }[]>`
    SELECT COALESCE(SUM("consumptionAmount"), 0)::text AS consumed
    FROM retailer_allowance_consumptions
    WHERE "allowanceId" = ${ids.allowance}
  `;
  return Number(row?.consumed ?? "0");
}

async function main() {
  // Il replay storico locale non include ancora 0034; questo shim esiste solo
  // nel database effimero e consente di esercitare il writer corrente.
  await sql`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS "paymentStatus" varchar(20) DEFAULT 'unpaid',
      ADD COLUMN IF NOT EXISTS "paymentMethod" varchar(50),
      ADD COLUMN IF NOT EXISTS "paidAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "approvedForShippingAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "transferringAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "shippedAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "deliveredAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "cancelledAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "cancelledReason" text
  `;
  await sql`
    DELETE FROM retailer_allowance_consumptions
    WHERE "allowanceId" IN (${ids.allowance}, ${ids.investorAllowance})
       OR "orderId" IN (SELECT id FROM orders WHERE "createdBy" IN (${ids.portalUser}, ${ids.otherPortalUser}))
  `;
  await sql`DELETE FROM "orderItems" WHERE "orderId" IN (SELECT id FROM orders WHERE "createdBy" IN (${ids.portalUser}, ${ids.otherPortalUser}))`;
  await sql`DELETE FROM orders WHERE "createdBy" IN (${ids.portalUser}, ${ids.otherPortalUser})`;
  await sql`DELETE FROM retailer_allowances WHERE id IN (${ids.allowance}, ${ids.investorAllowance})`;
  await sql`DELETE FROM users WHERE id IN (${ids.portalUser}, ${ids.otherPortalUser})`;
  await sql`DELETE FROM auth.users WHERE id IN (${ids.portalUser}, ${ids.otherPortalUser})`;
  await sql`DELETE FROM retailers WHERE id = ${ids.otherRetailer}`;
  await seedHotfixM13();
  await sql`
    INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
    VALUES (${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, true)
    ON CONFLICT ("userId", "companyId") DO UPDATE SET "isDefault" = true
  `;

  await sql`
    INSERT INTO "pricingPackages" (id, name, "discountPercent", "sortOrder", "isAssignableToNewRetailers")
    VALUES (${ids.premiumPackage}, 'Premium Test Plafond', 44.05, 3, true)
    ON CONFLICT (id) DO UPDATE
    SET "discountPercent" = EXCLUDED."discountPercent",
        "isAssignableToNewRetailers" = true
  `;
  await sql`
    INSERT INTO "pricingPackages" (id, name, "discountPercent", "sortOrder", "isAssignableToNewRetailers")
    VALUES (${ids.specialPackage}, 'Special Test Non Assegnabile', 100.00, 99, false)
    ON CONFLICT (id) DO UPDATE SET "isAssignableToNewRetailers" = false
  `;
  await sql`
    UPDATE retailers
    SET "pricingPackageId" = ${ids.premiumPackage}, "pricingModel" = 'tier_discount'
    WHERE id = ${TEST_IDS.normalRetailer}
  `;
  await sql`
    INSERT INTO retailer_allowances (
      id, "retailerId", "billingCompanyId", "initialAmount", "valuationDiscountPercent",
      "activatedAt", "packageInvoiceReference", "postExhaustionPricingPackageId", status,
      "allowanceType", "sourceAmount", "sourceReference", "sourceReceivedAt", notes, "createdBy"
    ) VALUES (
      ${ids.allowance}, ${TEST_IDS.normalRetailer}, ${TEST_IDS.originCompany}, 20.00, 44.05,
      NOW(), NULL, ${ids.premiumPackage}, 'active',
      'restaurant_package', 20000.00,
      'Investimento test caso 3: pacchetto ristoratore + beneficio investitore',
      '2026-04-28T00:00:00.000Z'::timestamptz,
      'TEST plafond', ${TEST_IDS.adminUser}
    )
  `;

  await sql`INSERT INTO auth.users (id, email) VALUES (${ids.portalUser}, 'allowance-holder@local.invalid')`;
  await sql`
    UPDATE users
    SET name = 'Test Titolare Plafond', role = 'retailer_admin', "retailerId" = ${TEST_IDS.normalRetailer}
    WHERE id = ${ids.portalUser}
  `;

  // Seconda anagrafica della stessa P.IVA, ma nell'altra company e senza plafond.
  await sql`
    INSERT INTO retailers (id, name, email, "vatNumber", "companyId", "pricingPackageId", tier_engine_enabled)
    VALUES (
      ${ids.otherRetailer}, 'TEST Altra Anagrafica', 'allowance-other@local.invalid', '01338920224',
      ${TEST_IDS.soketoCompany}, ${ids.premiumPackage}, false
    )
  `;
  await sql`INSERT INTO auth.users (id, email) VALUES (${ids.otherPortalUser}, 'allowance-other@local.invalid')`;
  await sql`
    UPDATE users
    SET name = 'Test Altra Anagrafica', role = 'retailer_admin', "retailerId" = ${ids.otherRetailer}
    WHERE id = ${ids.otherPortalUser}
  `;

  const { retailerSelfServiceRouter } = await import("../server/retailer-selfservice-router");
  const {
    createRetailerAllowance,
    getAllowanceOriginReport,
    getRetailerAllowanceLedger,
    prepareAllowanceActivation,
  } = await import("../server/services/retailerAllowanceService");
  const { getDb } = await import("../server/db");
  const database = await getDb();
  assert(database, "Il client Drizzle locale deve essere disponibile per testare le regole di tipo.");
  const holderCaller = retailerSelfServiceRouter.createCaller({
    user: { id: ids.portalUser, role: "retailer_admin", email: "allowance-holder@local.invalid", name: "Test Titolare", retailerId: TEST_IDS.normalRetailer },
    activeCompanyId: TEST_IDS.originCompany,
    req: { headers: {} }, res: {},
  } as any);
  const otherCaller = retailerSelfServiceRouter.createCaller({
    user: { id: ids.otherPortalUser, role: "retailer_admin", email: "allowance-other@local.invalid", name: "Test Altra", retailerId: ids.otherRetailer },
    activeCompanyId: TEST_IDS.soketoCompany,
    req: { headers: {} }, res: {},
  } as any);

  // T1: ordine a cavallo. Il plafond 20 copre tre confezioni (3 × 5,595 = 16,79), le altre due restano Premium.
  const preview = await holderCaller.cartPreview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 5 }] });
  assert(preview.allowance?.remainingBefore === "20.00", "Il residuo iniziale deve essere 20,00 €.");
  assert(preview.items.length === 2, "La riga a cavallo deve essere spezzata in gratuita e a pagamento.");
  const previewCovered = preview.items.find((item) => item.allowanceCovered);
  const previewPaid = preview.items.find((item) => !item.allowanceCovered);
  assert(previewCovered?.quantity === 3 && previewCovered.unitPriceFinal === "0.00", "Tre confezioni devono risultare coperte a 0 €.");
  assert(previewPaid?.quantity === 2 && previewPaid.unitPriceFinal === "5.60", "L'eccedenza deve usare il prezzo Premium 5,60 €.");

  const created = await holderCaller.cartCheckout({ items: [{ productId: TEST_IDS.productBoxes, quantity: 5 }], notes: "TEST plafond a cavallo" });
  const createdRows = await sql<{ quantity: number; unitPriceFinal: string }[]>`
    SELECT quantity, "unitPriceFinal"::text AS "unitPriceFinal"
    FROM "orderItems" WHERE "orderId" = ${created.orderId}
    ORDER BY "unitPriceFinal", quantity
  `;
  const consumedAfterCreate = await allowanceTotals();
  assert(createdRows.length === 2, "L'ordine creato deve contenere due righe prezzo.");
  assert(createdRows.some((row) => Number(row.quantity) === 3 && Number(row.unitPriceFinal) === 0), "Quota coperta non salvata a 0 €.");
  assert(createdRows.some((row) => Number(row.quantity) === 2 && Number(row.unitPriceFinal) === 5.6), "Quota eccedente non salvata Premium.");
  assert(consumedAfterCreate === 16.79, `Consumo atteso 16,79 €, trovato ${consumedAfterCreate}.`);

  // T2: modifica stessa riga. Il vecchio consumo viene stornato e riapplicato, senza raddoppio ledger.
  const modified = await holderCaller.ordersModifyItems({ orderId: created.orderId, items: [{ productId: TEST_IDS.productBoxes, quantity: 4 }] });
  const consumedAfterModify = await allowanceTotals();
  assert(modified.success, "La modifica dell'ordine plafond deve riuscire.");
  assert(consumedAfterModify === 16.79, "La modifica non deve raddoppiare il consumo plafond.");

  // T3: anche il writer amministrativo legacy deve stornare e ricreare il ledger.
  const { ordersRouter } = await import("../server/orders-router");
  const adminCaller = ordersRouter.createCaller({
    user: { id: TEST_IDS.adminUser, role: "admin", email: "test-admin@local.invalid", name: "Test Admin" },
    activeCompanyId: TEST_IDS.originCompany,
    req: { headers: {} }, res: {},
  } as any);
  const adminModified = await adminCaller.updateItems({
    orderId: created.orderId,
    items: [{ productId: TEST_IDS.productBoxes, quantity: 3 }],
  });
  const consumedAfterAdminModify = await allowanceTotals();
  assert(adminModified.totalGross === "0.00", "Il writer admin deve mantenere a 0 € la quota ancora coperta.");
  assert(consumedAfterAdminModify === 16.79, "Il writer admin non deve duplicare il consumo plafond.");

  const { appRouter } = await import("../server/routers");
  const appCaller = appRouter.createCaller({
    user: { id: TEST_IDS.adminUser, role: "admin", email: "test-admin@local.invalid", name: "Test Admin" },
    activeCompanyId: TEST_IDS.originCompany,
    req: { headers: {} }, res: {},
  } as any);
  let specialRejected = false;
  try {
    await appCaller.retailers.assignPackage({ retailerId: TEST_IDS.normalRetailer, packageId: ids.specialPackage });
  } catch (error) {
    specialRejected = /non è assegnabile/.test(String(error));
  }
  assert(specialRejected, "Il pacchetto Special non assegnabile deve essere bloccato anche lato server.");

  const { retailerCheckoutRouter } = await import("../server/retailer-checkout-router");
  const legacyCaller = retailerCheckoutRouter.createCaller({
    user: { id: ids.portalUser, role: "retailer_admin", email: "allowance-holder@local.invalid", name: "Test Titolare", retailerId: TEST_IDS.normalRetailer },
    activeCompanyId: TEST_IDS.originCompany,
    req: { headers: {} }, res: {},
  } as any);
  let legacyRejected = false;
  try {
    await legacyCaller.preview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }] });
  } catch (error) {
    legacyRejected = /Procedura obsoleta/.test(String(error));
  }
  assert(legacyRejected, "I namespace legacy non devono bypassare lo split e il ledger plafond.");

  // T4: annullamento ripristina il residuo tramite reversal append-only.
  await holderCaller.ordersCancel({ orderId: created.orderId, reason: "TEST storno plafond" });
  const consumedAfterCancel = await allowanceTotals();
  const [cancelled] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${created.orderId}`;
  assert(cancelled?.status === "cancelled", "L'ordine deve risultare annullato.");
  assert(consumedAfterCancel === 0, "L'annullamento deve ripristinare tutto il residuo.");
  const ledger = await sql<{ entryType: string; consumptionAmount: string }[]>`
    SELECT "entryType", "consumptionAmount"::text AS "consumptionAmount"
    FROM retailer_allowance_consumptions WHERE "allowanceId" = ${ids.allowance} ORDER BY "createdAt", "entryType"
  `;
  assert(ledger.some((row) => row.entryType === "reversal" && Number(row.consumptionAmount) < 0), "Il ledger deve contenere una reversal negativa.");

  // T5: un plafond esaurito è ignorato dal calcolo e il retailer paga Premium pieno.
  await sql`UPDATE retailer_allowances SET status = 'exhausted' WHERE id = ${ids.allowance}`;
  const exhaustedPreview = await holderCaller.cartPreview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }] });
  assert(exhaustedPreview.allowance === null, "Un plafond exhausted non deve concedere quote gratuite.");
  assert(exhaustedPreview.items.length === 1 && exhaustedPreview.items[0]?.unitPriceFinal === "5.60", "Un plafond exhausted deve applicare Premium pieno.");
  await sql`UPDATE retailer_allowances SET status = 'active' WHERE id = ${ids.allowance}`;

  // T6: l'anagrafica non titolare, pur con stessa P.IVA, non usa il plafond.
  const otherPreview = await otherCaller.cartPreview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }] });
  assert(otherPreview.allowance === null, "L'altra anagrafica non deve leggere il plafond del titolare.");
  assert(otherPreview.items.length === 1 && otherPreview.items[0]?.unitPriceFinal === "5.60", "L'altra anagrafica deve pagare Premium.");

  // T7: il consumo resta legato al 44,05% congelato anche se il package Premium cambia.
  await sql`UPDATE "pricingPackages" SET "discountPercent" = 50.00 WHERE id = ${ids.premiumPackage}`;
  const frozenPreview = await holderCaller.cartPreview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 5 }] });
  const frozenCovered = frozenPreview.items.find((item) => item.allowanceCovered);
  const frozenPaid = frozenPreview.items.find((item) => !item.allowanceCovered);
  assert(frozenCovered?.quantity === 3 && frozenCovered.allowanceConsumptionAmount === "16.79", "Lo sconto congelato deve mantenere tre confezioni coperte per 16,79 €.");
  assert(frozenPaid?.unitPriceFinal === "5.00", "Solo l'eccedenza deve riflettere il nuovo prezzo Premium.");

  // T8: investor solo SoKeto, restaurant_package solo E-Keto, incasso obbligatorio.
  const commonSource = {
    sourceAmount: 20000,
    sourceReference: "Investimento test caso 3: pacchetto ristoratore + beneficio investitore",
    sourceReceivedAt: new Date("2026-04-28T00:00:00.000Z"),
    activatedAt: new Date("2026-04-28T00:00:00.000Z"),
  };
  let investorOnEketoRejected = false;
  try {
    await prepareAllowanceActivation(database, {
      retailerId: TEST_IDS.normalRetailer,
      companyId: TEST_IDS.originCompany,
      allowanceType: "investor_benefit",
      ...commonSource,
    });
  } catch (error) {
    investorOnEketoRejected = /solo a SoKeto/.test(String(error));
  }
  assert(investorOnEketoRejected, "investor_benefit su E-Keto deve essere rifiutato.");

  let restaurantOnSoketoRejected = false;
  try {
    await prepareAllowanceActivation(database, {
      retailerId: ids.otherRetailer,
      companyId: TEST_IDS.soketoCompany,
      allowanceType: "restaurant_package",
      ...commonSource,
    });
  } catch (error) {
    restaurantOnSoketoRejected = /solo a E-Keto/.test(String(error));
  }
  assert(restaurantOnSoketoRejected, "restaurant_package su SoKeto deve essere rifiutato.");

  let investorWithoutReceiptRejected = false;
  try {
    await prepareAllowanceActivation(database, {
      retailerId: ids.otherRetailer,
      companyId: TEST_IDS.soketoCompany,
      allowanceType: "investor_benefit",
      ...commonSource,
      sourceReceivedAt: null,
    });
  } catch (error) {
    investorWithoutReceiptRejected = /data di incasso/.test(String(error));
  }
  assert(investorWithoutReceiptRejected, "investor_benefit senza sourceReceivedAt deve essere rifiutato.");

  const investorCreated = await createRetailerAllowance(database, {
    retailerId: ids.otherRetailer,
    companyId: TEST_IDS.soketoCompany,
    allowanceType: "investor_benefit",
    ...commonSource,
  });
  await sql`UPDATE retailer_allowances SET id = ${ids.investorAllowance} WHERE id = ${investorCreated.id}`;
  assert(investorCreated.initialAmount === "1000.00", "Il plafond investitore deve essere il 5% di 20.000 €.");
  assert(investorCreated.valuationDiscountPercent === "0.00", "Il plafond investitore deve valorizzare a prezzo al pubblico.");

  // T9: la stessa origine caso 3 appare una sola volta, senza raddoppiare € 20.000.
  await sql`UPDATE retailer_allowances SET "initialAmount" = 1000.00 WHERE id = ${ids.allowance}`;
  const originReport = await getAllowanceOriginReport(database, [TEST_IDS.originCompany, TEST_IDS.soketoCompany]);
  const sharedOrigin = originReport.filter((row) => row.sourceReference === commonSource.sourceReference);
  assert(sharedOrigin.length === 1, "Un'origine condivisa deve comparire una sola volta nel report.");
  assert(sharedOrigin[0]?.sourceAmount === "20000.00", "Il versamento caso 3 deve restare € 20.000 una sola volta.");
  assert(sharedOrigin[0]?.allowancesCount === 2 && sharedOrigin[0]?.initialAmountTotal === "2000.00", "Il report deve collegare due plafond senza raddoppiare il versamento.");

  // T10: quota storica frazionaria leggibile in card; investitore exhausted non regala nulla.
  await sql`
    INSERT INTO retailer_allowance_consumptions (
      "allowanceId", "orderId", "orderItemId", "entryType", "reversesConsumptionId",
      "coveredQuantity", "listUnitPriceSnapshot", "valuationDiscountPercentSnapshot",
      "consumptionAmount", "createdBy", "reversalReason"
    ) VALUES (
      ${ids.investorAllowance}, ${created.orderId}, NULL, 'consumption', NULL,
      38.545455, 7.70, 0.00, 296.80, ${TEST_IDS.adminUser}, NULL
    )
  `;
  await sql`UPDATE retailer_allowances SET status = 'exhausted' WHERE id = ${ids.investorAllowance}`;
  const investorLedger = await getRetailerAllowanceLedger(database, ids.otherRetailer, TEST_IDS.soketoCompany);
  assert(investorLedger.allowance?.status === "exhausted", "La card admin deve poter leggere un plafond investitore esaurito.");
  assert(investorLedger.entries.some((entry) => entry.coveredQuantity === "38.545455"), "La quota finanziaria parziale deve restare leggibile a sei decimali.");
  const exhaustedInvestorPreview = await otherCaller.cartPreview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }] });
  assert(exhaustedInvestorPreview.allowance === null && exhaustedInvestorPreview.items[0]?.unitPriceFinal === "5.00", "Un investitore exhausted deve ordinare a Premium pieno senza quote gratuite.");

  const evidence = {
    generatedAt: new Date().toISOString(),
    tests: {
      splitAtAllowanceBoundary: "PASS",
      consumptionLedgerOnCreate: "PASS",
      modificationDoesNotDoubleConsume: "PASS",
      adminModificationDoesNotDoubleConsume: "PASS",
      specialPackageRejectedServerSide: "PASS",
      legacyPricingRoutesFailClosed: "PASS",
      cancellationRestoresRemaining: "PASS",
      exhaustedAllowancePaysFullPremium: "PASS",
      nonHolderRetailerPaysPremium: "PASS",
      frozenValuationDiscountSurvivesPackageChange: "PASS",
      investorRejectedOnEketo: "PASS",
      restaurantRejectedOnSoketo: "PASS",
      investorRequiresReceipt: "PASS",
      investorIsFivePercentOfSource: "PASS",
      sharedCaseThreeOriginCountedOnce: "PASS",
      fractionalHistoricalConsumptionVisible: "PASS",
      exhaustedInvestorPaysFullPremium: "PASS",
    },
    raw: { preview, created, createdRows, consumedAfterCreate, modified, consumedAfterModify, adminModified, consumedAfterAdminModify, cancelled, consumedAfterCancel, ledger, exhaustedPreview, otherPreview, frozenPreview, investorCreated, originReport, investorLedger, exhaustedInvestorPreview },
  };

  await sql`
    DELETE FROM retailer_allowance_consumptions
    WHERE "allowanceId" IN (${ids.allowance}, ${ids.investorAllowance})
       OR "orderId" IN (SELECT id FROM orders WHERE "createdBy" IN (${ids.portalUser}, ${ids.otherPortalUser}))
  `;
  await sql`DELETE FROM "orderItems" WHERE "orderId" IN (SELECT id FROM orders WHERE "createdBy" IN (${ids.portalUser}, ${ids.otherPortalUser}))`;
  await sql`DELETE FROM orders WHERE "createdBy" IN (${ids.portalUser}, ${ids.otherPortalUser})`;
  await sql`DELETE FROM retailer_allowances WHERE id IN (${ids.allowance}, ${ids.investorAllowance})`;
  await sql`DELETE FROM retailers WHERE id = ${ids.otherRetailer}`;
  await sql`DELETE FROM auth.users WHERE id IN (${ids.portalUser}, ${ids.otherPortalUser})`;

  console.log(JSON.stringify(evidence, null, 2));
}

main()
  .then(async () => { await sql.end({ timeout: 5 }); process.exit(0); })
  .catch(async (error) => { console.error(error); await sql.end({ timeout: 5 }); process.exit(1); });
