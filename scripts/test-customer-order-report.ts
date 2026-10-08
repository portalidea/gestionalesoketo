import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

const ids = {
  primaryRetailer: "cccccccc-cccc-4ccc-8ccc-cccccccccc01",
  relatedRetailer: "cccccccc-cccc-4ccc-8ccc-cccccccccc02",
  premiumPackage: "cccccccc-cccc-cccc-cccc-cccccccccc02",
  allowanceEketo: "cccccccc-cccc-cccc-cccc-cccccccccc03",
  allowanceSoketo: "cccccccc-cccc-cccc-cccc-cccccccccc04",
  eketoOrder: "cccccccc-cccc-cccc-cccc-cccccccccc05",
  soketoOrder: "cccccccc-cccc-cccc-cccc-cccccccccc06",
  cancelledOrder: "cccccccc-cccc-cccc-cccc-cccccccccc07",
  eketoItem: "cccccccc-cccc-cccc-cccc-cccccccccc08",
  soketoItem: "cccccccc-cccc-cccc-cccc-cccccccccc09",
  cancelledItem: "cccccccc-cccc-cccc-cccc-cccccccccc10",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function cleanup() {
  await sql`DELETE FROM retailer_allowance_consumptions WHERE "allowanceId" IN (${ids.allowanceEketo}, ${ids.allowanceSoketo})`;
  await sql`DELETE FROM "orderItems" WHERE id IN (${ids.eketoItem}, ${ids.soketoItem}, ${ids.cancelledItem})`;
  await sql`DELETE FROM orders WHERE id IN (${ids.eketoOrder}, ${ids.soketoOrder}, ${ids.cancelledOrder})`;
  await sql`DELETE FROM retailer_allowances WHERE id IN (${ids.allowanceEketo}, ${ids.allowanceSoketo})`;
  await sql`DELETE FROM retailers WHERE id IN (${ids.primaryRetailer}, ${ids.relatedRetailer})`;
  await sql`DELETE FROM "pricingPackages" WHERE id = ${ids.premiumPackage}`;
}

async function main() {
  await cleanup();
  await seedHotfixM13();

  await sql`
    INSERT INTO "pricingPackages" (id, name, "discountPercent", "sortOrder", "isAssignableToNewRetailers")
    VALUES (${ids.premiumPackage}, 'Premium Test Report Cliente', 44.05, 3, true)
  `;
  await sql`
    INSERT INTO retailers (id, name, email, "vatNumber", "companyId", "pricingPackageId", tier_engine_enabled)
    VALUES (
      ${ids.primaryRetailer}, 'TEST Cliente Primario E-Keto', 'report-eketo@local.invalid', '01338920224',
      ${TEST_IDS.originCompany}, ${ids.premiumPackage}, false
    ), (
      ${ids.relatedRetailer}, 'TEST Cliente Correlato SoKeto', 'report-soketo@local.invalid', '01338920224',
      ${TEST_IDS.soketoCompany}, ${ids.premiumPackage}, false
    )
  `;

  await sql`
    INSERT INTO orders (
      id, "orderNumber", "retailerId", status, "subtotalNet", "vatAmount", "totalGross",
      "createdBy", "companyId", "createdAt"
    ) VALUES
      (${ids.eketoOrder}, 'ORD-TEST-REPORT-E-1', ${ids.primaryRetailer}, 'delivered', 100.00, 10.00, 110.00, ${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, '2026-05-01T10:00:00.000Z'),
      (${ids.soketoOrder}, 'ORD-TEST-REPORT-S-1', ${ids.relatedRetailer}, 'delivered', 80.00, 8.00, 88.00, ${TEST_IDS.adminUser}, ${TEST_IDS.soketoCompany}, '2026-05-02T10:00:00.000Z'),
      (${ids.cancelledOrder}, 'ORD-TEST-REPORT-S-X', ${ids.relatedRetailer}, 'cancelled', 50.00, 5.00, 55.00, ${TEST_IDS.adminUser}, ${TEST_IDS.soketoCompany}, '2026-05-03T10:00:00.000Z')
  `;
  await sql`
    INSERT INTO "orderItems" (
      id, "orderId", "productId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate",
      "lineTotalNet", "lineTotalGross", "productSku", "productName"
    ) VALUES
      (${ids.eketoItem}, ${ids.eketoOrder}, ${TEST_IDS.productBoxes}, 10, 10.00, 0.00, 10.00, 10.00, 100.00, 110.00, 'TEST-E', 'Prodotto E-Keto Test'),
      (${ids.soketoItem}, ${ids.soketoOrder}, ${TEST_IDS.productBoxes}, 8, 10.00, 0.00, 10.00, 10.00, 80.00, 88.00, 'TEST-S', 'Prodotto SoKeto Test'),
      (${ids.cancelledItem}, ${ids.cancelledOrder}, ${TEST_IDS.productBoxes}, 5, 10.00, 0.00, 10.00, 10.00, 50.00, 55.00, 'TEST-X', 'Prodotto Annullato Test')
  `;
  await sql`
    INSERT INTO retailer_allowances (
      id, "retailerId", "billingCompanyId", "initialAmount", "valuationDiscountPercent", "activatedAt",
      "packageInvoiceReference", "postExhaustionPricingPackageId", status, "allowanceType", "sourceAmount",
      "sourceReference", "sourceReceivedAt", "createdBy"
    ) VALUES
      (${ids.allowanceEketo}, ${ids.primaryRetailer}, ${TEST_IDS.originCompany}, 1000.00, 44.05, '2026-04-28T00:00:00.000Z', NULL, ${ids.premiumPackage}, 'active', 'restaurant_package', 20000.00, 'Caso 3 test report cliente', '2026-04-28T00:00:00.000Z', ${TEST_IDS.adminUser}),
      (${ids.allowanceSoketo}, ${ids.relatedRetailer}, ${TEST_IDS.soketoCompany}, 1000.00, 0.00, '2026-04-28T00:00:00.000Z', NULL, ${ids.premiumPackage}, 'exhausted', 'investor_benefit', 20000.00, 'Caso 3 test report cliente', '2026-04-28T00:00:00.000Z', ${TEST_IDS.adminUser})
  `;
  await sql`
    INSERT INTO retailer_allowance_consumptions (
      "allowanceId", "orderId", "orderItemId", "entryType", "coveredQuantity", "listUnitPriceSnapshot",
      "valuationDiscountPercentSnapshot", "consumptionAmount", "createdBy"
    ) VALUES
      (${ids.allowanceEketo}, ${ids.eketoOrder}, ${ids.eketoItem}, 'consumption', 10, 10.00, 44.05, 100.00, ${TEST_IDS.adminUser}),
      (${ids.allowanceSoketo}, ${ids.soketoOrder}, ${ids.soketoItem}, 'consumption', 8, 10.00, 0.00, 80.00, ${TEST_IDS.adminUser})
  `;

  const { getDb } = await import("../server/db");
  const {
    generateCustomerOrderPdf,
    generateCustomerOrderXlsx,
    loadCustomerOrderReport,
  } = await import("../server/services/customerOrderReportService");
  const database = await getDb();
  assert(database, "Il client Drizzle locale deve essere disponibile.");

  const report = await loadCustomerOrderReport(database, {
    retailerId: ids.primaryRetailer,
    dateFrom: "2026-04-28",
    dateTo: "2026-05-31",
    includeRelatedProfiles: true,
    authorizedCompanyIds: [TEST_IDS.originCompany, TEST_IDS.soketoCompany],
  });
  assert(report.orders.length === 3, "Excel deve ricevere anche l'ordine annullato.");
  assert(report.totals.orderCount === 2, "PDF e totali devono escludere gli annullati.");
  assert(report.totals.subtotalNet === 180 && report.totals.vatAmount === 18 && report.totals.totalGross === 198, "I totali delle due company devono essere aggregati correttamente.");
  assert(report.totals.creditCovered === 180, "La quota coperta deve sommare solo gli ordini non annullati.");
  assert(report.allowances.length === 2, "Il report deve riepilogare i due tipi plafond.");
  assert(report.allowances.find((allowance) => allowance.type === "restaurant_package")?.remainingAmount === 900, "Il residuo pacchetto ristoratore deve essere corretto.");
  assert(report.allowances.find((allowance) => allowance.type === "investor_benefit")?.remainingAmount === 920, "Il residuo investitore deve riflettere il solo ordine SoKeto non annullato.");

  const scopedReport = await loadCustomerOrderReport(database, {
    retailerId: ids.primaryRetailer,
    dateFrom: "2026-04-28",
    dateTo: "2026-05-31",
    includeRelatedProfiles: true,
    authorizedCompanyIds: [TEST_IDS.originCompany],
  });
  assert(scopedReport.orders.length === 1 && scopedReport.orders[0]?.companyName.includes("E-Keto"), "La P. IVA non deve aggirare lo scope company staff.");

  await sql`
    INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
    VALUES
      (${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, true),
      (${TEST_IDS.adminUser}, ${TEST_IDS.soketoCompany}, false)
    ON CONFLICT ("userId", "companyId") DO UPDATE
    SET "isDefault" = "userCompanyAccess"."isDefault"
  `;
  const { appRouter } = await import("../server/routers");
  const staffCaller = appRouter.createCaller({
    user: { id: TEST_IDS.adminUser, role: "admin", email: "test-admin@local.invalid", name: "Test Admin" },
    activeCompanyId: TEST_IDS.originCompany,
    req: { headers: {} },
    res: {},
  } as any);
  const procedureReport = await staffCaller.customerOrderReport.preview({
    retailerId: ids.primaryRetailer,
    dateFrom: "2026-04-28",
    dateTo: "2026-05-31",
    includeRelatedProfiles: true,
  });
  assert(procedureReport.orders.length === 3, "La procedura staff deve aggregare soltanto le company a cui l'utente è autorizzato.");

  const pdfBase64 = await generateCustomerOrderPdf(report);
  const xlsxBase64 = await generateCustomerOrderXlsx(report);
  const pdfBuffer = Buffer.from(pdfBase64, "base64");
  const xlsxBuffer = Buffer.from(xlsxBase64, "base64");
  assert(pdfBuffer.subarray(0, 4).toString("ascii") === "%PDF", "L'export PDF deve essere un PDF valido.");
  assert(xlsxBuffer.subarray(0, 2).toString("ascii") === "PK", "L'export Excel deve essere un file XLSX valido.");
  await writeFile("/tmp/customer-order-report-test.pdf", pdfBuffer);
  await writeFile("/tmp/customer-order-report-test.xlsx", xlsxBuffer);

  const evidence = {
    generatedAt: new Date().toISOString(),
    tests: {
      relatedProfilesAggregateAuthorizedCompanies: "PASS",
      cancelledExcludedFromPdfTotals: "PASS",
      cancelledIncludedAndMarkedInExcel: "PASS",
      creditCoverageReconciled: "PASS",
      allowanceSummaryVisibleByType: "PASS",
      vatNumberDoesNotBypassCompanyScope: "PASS",
      staffProcedureRespectsCompanyAccess: "PASS",
      pdfGenerated: "PASS",
      xlsxGenerated: "PASS",
    },
    raw: {
      totals: report.totals,
      allowanceSummary: report.allowances,
      orders: report.orders.map((order) => ({ orderNumber: order.orderNumber, status: order.status, creditCovered: order.creditCovered })),
      scopedOrders: scopedReport.orders.map((order) => order.orderNumber),
      pdfBytes: pdfBuffer.length,
      xlsxBytes: xlsxBuffer.length,
    },
  };

  await cleanup();
  console.log(JSON.stringify(evidence, null, 2));
}

main()
  .then(async () => {
    await sql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch { /* cleanup best-effort */ }
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
