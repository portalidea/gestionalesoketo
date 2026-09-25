import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;
// I test non devono inviare email reali, nemmeno a indirizzi fixture.
process.env.RESEND_API_KEY = "";

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

const ids = {
  portalUser: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac",
  orderId: "aaaaaaaa-0000-0000-0000-000000000009",
  unknownProduct: "88888888-8888-8888-8888-888888888899",
  otherCompanyProduct: "88888888-8888-8888-8888-888888888898",
  otherCompanyBatch: "99999999-9999-9999-9999-999999999998",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function centralStock() {
  const rows = await sql<{ batchId: string; quantity: number }[]>`
    SELECT ibb."batchId" AS "batchId", ibb.quantity
    FROM "inventoryByBatch" ibb
    INNER JOIN locations l ON l.id = ibb."locationId"
    INNER JOIN "productBatches" pb ON pb.id = ibb."batchId"
    WHERE l."companyId" = ${TEST_IDS.originCompany}
      AND l.type = 'central_warehouse'
      AND pb."productId" = ${TEST_IDS.productBoxes}
    ORDER BY ibb."batchId"
  `;
  return rows.map((row) => ({ batchId: row.batchId, quantity: Number(row.quantity) }));
}

async function main() {
  // Il replay locale storico non include ancora tutte le colonne orders lette
  // dal router partner. È uno shim del solo database effimero di test.
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
  await sql`DELETE FROM "orderItems" WHERE "orderId" = ${ids.orderId}`;
  await sql`DELETE FROM orders WHERE id = ${ids.orderId}`;
  await sql`DELETE FROM "orderItems" WHERE "orderId" IN (SELECT id FROM orders WHERE "createdBy" = ${ids.portalUser})`;
  await sql`DELETE FROM orders WHERE "createdBy" = ${ids.portalUser}`;
  await sql`DELETE FROM "inventoryByBatch" WHERE "batchId" = ${ids.otherCompanyBatch}`;
  await sql`DELETE FROM "productBatches" WHERE id = ${ids.otherCompanyBatch}`;
  await sql`DELETE FROM products WHERE id = ${ids.otherCompanyProduct}`;
  await sql`DELETE FROM users WHERE id = ${ids.portalUser}`;
  await sql`DELETE FROM auth.users WHERE id = ${ids.portalUser}`;
  await seedHotfixM13();

  // Prodotto a listino con lotti e giacenza esclusivamente nel centrale
  // SoKeto: resta visibile e ordinabile anche dal retailer E-Keto.
  await sql`
    INSERT INTO products (id, sku, name, "unitPrice", "piecesPerUnit", "sellableUnitLabel", "costPrice")
    VALUES (${ids.otherCompanyProduct}, 'TEST-SOKETO-ONLY', 'TEST Prodotto solo SoKeto', '12.00', 1, 'PZ', '2.0000')
  `;
  await sql`
    INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId")
    VALUES (${ids.otherCompanyBatch}, ${ids.otherCompanyProduct}, 'TEST-SOKETO-ONLY-LOT', CURRENT_DATE + 365, 24, '2.0000', ${TEST_IDS.soketoCompany})
  `;
  await sql`
    INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId")
    VALUES (${TEST_IDS.soketoCentral}, ${ids.otherCompanyBatch}, 24, ${TEST_IDS.soketoCompany})
  `;

  await sql`INSERT INTO auth.users (id, email) VALUES (${ids.portalUser}, 'retailer-stock-unblock@local.invalid')`;
  await sql`
    UPDATE users
    SET name = 'Test Retailer Stock Unblock',
        role = 'retailer_admin',
        "retailerId" = ${TEST_IDS.normalRetailer}
    WHERE id = ${ids.portalUser}
  `;

  // Il prodotto è nel catalogo ma non ha alcuna giacenza nel centrale E-Keto.
  await sql`
    UPDATE "inventoryByBatch"
    SET quantity = 0
    WHERE "locationId" = ${TEST_IDS.originCentral}
      AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})
  `;

  const beforeCreation = await centralStock();
  const { retailerSelfServiceRouter } = await import("../server/retailer-selfservice-router");
  const caller = retailerSelfServiceRouter.createCaller({
    user: {
      id: ids.portalUser,
      role: "retailer_admin",
      email: "retailer-stock-unblock@local.invalid",
      name: "Test Retailer Stock Unblock",
      retailerId: TEST_IDS.normalRetailer,
    },
    req: { headers: {} },
    res: {},
  } as any);

  // T1: catalogo e dettaglio restano disponibili senza esporre quantità, stati o lotti.
  const catalog = await caller.catalogList({ limit: 10, offset: 0 });
  const catalogProduct = catalog.products.find((product) => product.productId === TEST_IDS.productBoxes);
  assert(catalogProduct, "Il prodotto a giacenza zero deve restare nel catalogo retailer.");
  assert(!("availableStock" in catalogProduct), "Il catalogo retailer non deve esporre availableStock.");
  assert(!("stockStatus" in catalogProduct), "Il catalogo retailer non deve esporre stockStatus.");

  const detail = await caller.catalogGetById({ productId: TEST_IDS.productBoxes });
  assert(!("availableStock" in detail.product), "Il dettaglio retailer non deve esporre availableStock.");
  assert(!("batches" in detail), "Il dettaglio retailer non deve esporre lotti.");
  let unknownProductRejected = false;
  try {
    await caller.catalogGetById({ productId: ids.unknownProduct });
  } catch (error) {
    unknownProductRejected = /Prodotto non trovato nel catalogo/.test(String(error));
  }
  assert(unknownProductRejected, "Un productId non ammesso deve restituire NOT_FOUND.");
  const soketoOnlyCatalogProduct = catalog.products.find((product) => product.productId === ids.otherCompanyProduct);
  assert(soketoOnlyCatalogProduct,
    "Un prodotto a listino con lotti solo SoKeto deve comparire nel catalogo del retailer E-Keto.");
  const soketoOnlyDetail = await caller.catalogGetById({ productId: ids.otherCompanyProduct });
  assert(soketoOnlyDetail.product.productId === ids.otherCompanyProduct,
    "Il dettaglio di un prodotto con lotti solo SoKeto deve essere accessibile dal retailer E-Keto.");

  // T2: anteprima, checkout e modifica accettano quantità superiori alla giacenza.
  const preview = await caller.cartPreview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 40 }] });
  assert(!("warnings" in preview), "cartPreview non deve restituire warning di disponibilità.");
  const soketoOnlyPreview = await caller.cartPreview({ items: [{ productId: ids.otherCompanyProduct, quantity: 40 }] });
  assert(soketoOnlyPreview.items[0]?.productId === ids.otherCompanyProduct,
    "Il prodotto con lotti solo SoKeto deve essere ordinabile dal retailer E-Keto.");

  const checkout = await caller.cartCheckout({
    items: [{ productId: TEST_IDS.productBoxes, quantity: 40 }],
    notes: "TEST — ordine oltre giacenza consentito",
  });
  const afterCreation = await centralStock();
  assert(JSON.stringify(afterCreation) === JSON.stringify(beforeCreation), "La creazione ordine non deve alterare inventoryByBatch.");

  const createdItems = await sql<{ batchId: string | null; quantity: number }[]>`
    SELECT "batchId" AS "batchId", quantity
    FROM "orderItems"
    WHERE "orderId" = ${checkout.orderId}
  `;
  assert(createdItems.length === 1 && createdItems[0]?.batchId === null, "L'ordine pending non deve allocare un lotto.");

  const modified = await caller.ordersModifyItems({
    orderId: checkout.orderId,
    items: [{ productId: TEST_IDS.productBoxes, quantity: 80 }],
  });
  const afterModification = await centralStock();
  assert(modified.success === true, "La modifica oltre giacenza deve riuscire.");
  assert(JSON.stringify(afterModification) === JSON.stringify(beforeCreation), "La modifica ordine non deve alterare inventoryByBatch.");

  const modifiedItems = await sql<{ batchId: string | null; quantity: number }[]>`
    SELECT "batchId" AS "batchId", quantity
    FROM "orderItems"
    WHERE "orderId" = ${checkout.orderId}
  `;
  assert(modifiedItems.length === 1 && modifiedItems[0]?.batchId === null && Number(modifiedItems[0]?.quantity) === 80,
    "La modifica deve mantenere la riga senza lotto e con la nuova quantità.");

  await sql`DELETE FROM "inventoryByBatch" WHERE "batchId" = ${ids.otherCompanyBatch}`;
  await sql`DELETE FROM "productBatches" WHERE id = ${ids.otherCompanyBatch}`;
  await sql`DELETE FROM products WHERE id = ${ids.otherCompanyProduct}`;

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    tests: {
      zeroStockProductStillVisible: "PASS",
      detailWithoutAvailabilityOrBatches: "PASS",
      unknownProductNotFound: "PASS",
      soketoOnlyStockProductVisibleAndOrderable: "PASS",
      previewWithoutStockWarnings: "PASS",
      checkoutAboveStockCreatesPendingOrder: "PASS",
      modificationAboveStockSucceeds: "PASS",
      inventoryUnchangedAfterCreateAndModify: "PASS",
    },
    raw: {
      beforeCreation,
      afterCreation,
      afterModification,
      checkout,
      createdItems,
      modified,
      modifiedItems,
      catalogProductKeys: Object.keys(catalogProduct).sort(),
      detailProductKeys: Object.keys(detail.product).sort(),
      soketoOnlyCatalogProduct,
      soketoOnlyDetailProductKeys: Object.keys(soketoOnlyDetail.product).sort(),
      soketoOnlyPreview,
    },
  }, null, 2));
}

main()
  .then(async () => {
    await sql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
