import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;

const sql = postgres(databaseUrl, { prepare: false, max: 1 });
const ids = {
  thirdProduct: "88888888-8888-8888-8888-888888888883",
  thirdBatch: "99999999-9999-9999-9999-999999999994",
  pieceReplacementBatch: "99999999-9999-9999-9999-999999999995",
  portalUser: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab",
  parityAdminOrder: "aaaaaaaa-0000-0000-0000-000000000007",
  parityPortalOrder: "aaaaaaaa-0000-0000-0000-000000000008",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function itemsFor(orderId: string) {
  return await sql`
    SELECT "productId", "batchId", quantity
    FROM "orderItems"
    WHERE "orderId" = ${orderId}
    ORDER BY "productId", "batchId" NULLS LAST
  `;
}

async function createParityOrder(orderId: string) {
  await sql`
    INSERT INTO orders (
      id, "orderNumber", "retailerId", status, "subtotalNet", "vatAmount", "totalGross", "discountPercent", "createdBy", "companyId"
    ) VALUES (
      ${orderId}, ${`TEST-PARITY-${orderId.slice(-1)}`}, ${TEST_IDS.normalRetailer}, 'pending', 50, 5, 55, 0, ${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}
    )
  `;
  await sql`
    INSERT INTO "orderItems" (
      "orderId", "productId", "batchId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName"
    ) VALUES (
      ${orderId}, ${TEST_IDS.productBoxes}, ${TEST_IDS.batchFourMonths}, 5, 10, 0, 10, 10, 50, 55, 'TEST-BOX-6', 'TEST Prodotto Confezione 6'
    )
  `;
}

async function main() {
  // Il reset locale storico non include ancora le colonne orders già presenti
  // nello schema applicativo e lette dal router portale. Questo shim è limitato
  // al database di test, che viene distrutto dal reset successivo; non è una migration.
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
  await sql`DELETE FROM "orderItems" WHERE "orderId" IN (${ids.parityAdminOrder}, ${ids.parityPortalOrder})`;
  await sql`DELETE FROM orders WHERE id IN (${ids.parityAdminOrder}, ${ids.parityPortalOrder})`;
  await seedHotfixM13();
  await sql`DELETE FROM "inventoryByBatch" WHERE "batchId" IN (${ids.thirdBatch}, ${ids.pieceReplacementBatch})`;
  await sql`DELETE FROM "productBatches" WHERE id IN (${ids.thirdBatch}, ${ids.pieceReplacementBatch})`;
  await sql`DELETE FROM products WHERE id = ${ids.thirdProduct}`;
  await sql`DELETE FROM users WHERE id = ${ids.portalUser}`;
  await sql`DELETE FROM auth.users WHERE id = ${ids.portalUser}`;

  await sql`
    INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
    VALUES (${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, true)
    ON CONFLICT ("userId", "companyId") DO UPDATE SET "isDefault" = true
  `;
  await sql`INSERT INTO auth.users (id, email) VALUES (${ids.portalUser}, 'retailer-admin@local.invalid')`;
  await sql`
    UPDATE users
    SET name = 'Test Retailer Admin', role = 'retailer_admin', "retailerId" = ${TEST_IDS.normalRetailer}
    WHERE id = ${ids.portalUser}
  `;
  await sql`
    INSERT INTO products (id, sku, name, "unitPrice", "piecesPerUnit", "sellableUnitLabel", "costPrice")
    VALUES (${ids.thirdProduct}, 'TEST-THIRD-1', 'TEST Terzo Prodotto', '7.00', 1, 'PZ', '1.0000')
  `;
  await sql`
    INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES
      (${ids.thirdBatch}, ${ids.thirdProduct}, 'TEST-THIRD-BATCH', '2026-12-31', 60, '1.0000', ${TEST_IDS.originCompany}),
      (${ids.pieceReplacementBatch}, ${TEST_IDS.productPieces}, 'TEST-PIECE-REPLACEMENT', '2026-11-30', 60, '1.0000', ${TEST_IDS.originCompany})
  `;
  await sql`
    INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES
      (${TEST_IDS.originCentral}, ${ids.thirdBatch}, 60, ${TEST_IDS.originCompany}),
      (${TEST_IDS.originCentral}, ${ids.pieceReplacementBatch}, 60, ${TEST_IDS.originCompany})
  `;

  // Add the requested 3-product pending order fixture while retaining its original batch assignments.
  await sql`
    INSERT INTO "orderItems" (
      "orderId", "productId", "batchId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName"
    ) VALUES
      (${TEST_IDS.orderIntact}, ${TEST_IDS.productPieces}, ${TEST_IDS.batchExpired}, 3, 5, 0, 5, 10, 15, 16.5, 'TEST-PZ-1', 'TEST Prodotto Pezzo Singolo'),
      (${TEST_IDS.orderIntact}, ${ids.thirdProduct}, ${ids.thirdBatch}, 2, 7, 0, 7, 10, 14, 15.4, 'TEST-THIRD-1', 'TEST Terzo Prodotto')
  `;

  const { ordersRouter } = await import("../server/orders-router");
  const { retailerOrdersRouter } = await import("../server/retailer-orders-router");
  const adminCaller = ordersRouter.createCaller({
    user: { id: TEST_IDS.adminUser, role: "admin", email: "test-admin@local.invalid", name: "Test Admin" },
    req: { headers: { "x-active-company-id": TEST_IDS.originCompany } },
    res: {},
  } as any);
  const portalCaller = retailerOrdersRouter.createCaller({
    user: { id: ids.portalUser, role: "retailer_admin", email: "retailer-admin@local.invalid", name: "Test Retailer Admin", retailerId: TEST_IDS.normalRetailer },
    req: { headers: {} },
    res: {},
  } as any);

  // T1: three unchanged product lines retain exactly their pre-existing batch IDs.
  const beforeUnchanged = await itemsFor(TEST_IDS.orderIntact);
  await adminCaller.updateItems({
    orderId: TEST_IDS.orderIntact,
    items: [
      { productId: TEST_IDS.productBoxes, quantity: 5 },
      { productId: TEST_IDS.productPieces, quantity: 3 },
      { productId: ids.thirdProduct, quantity: 2 },
    ],
  });
  const afterUnchanged = await itemsFor(TEST_IDS.orderIntact);
  assert(JSON.stringify(beforeUnchanged) === JSON.stringify(afterUnchanged), "Le tre righe invariate devono conservare esattamente i batchId.");

  // T2: original quantity stays on its prepared batch; only the added quantity is allocated FEFO.
  await adminCaller.updateItems({
    orderId: TEST_IDS.orderIntact,
    items: [
      { productId: TEST_IDS.productBoxes, quantity: 15 },
      { productId: TEST_IDS.productPieces, quantity: 3 },
      { productId: ids.thirdProduct, quantity: 2 },
    ],
  });
  const afterIncrease = await itemsFor(TEST_IDS.orderIntact);
  const boxRowsAfterIncrease = afterIncrease.filter((row) => row.productId === TEST_IDS.productBoxes);
  assert(boxRowsAfterIncrease.some((row) => row.batchId === TEST_IDS.batchFourMonths && Number(row.quantity) === 5), "La quantità originaria deve rimanere sul lotto già preparato.");
  assert(boxRowsAfterIncrease.some((row) => row.batchId === TEST_IDS.batchSoon && Number(row.quantity) === 10), "La sola eccedenza deve essere assegnata FEFO al lotto più prossimo.");

  // T3: an unavailable assigned batch is replaced by the next FEFO batch and produces a warning.
  await sql`
    UPDATE "inventoryByBatch" SET quantity = 0
    WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" = ${TEST_IDS.batchExpired}
  `;
  const unavailableResult = await adminCaller.updateItems({
    orderId: TEST_IDS.orderPartial,
    items: [{ productId: TEST_IDS.productPieces, quantity: 30 }],
  });
  const afterUnavailable = await itemsFor(TEST_IDS.orderPartial);
  assert(afterUnavailable.length === 1 && afterUnavailable[0]?.batchId === ids.pieceReplacementBatch, "Il lotto non disponibile deve essere riallocato sul batch alternativo.");
  assert(unavailableResult.warnings.some((warning) => warning.includes("precedentemente assegnato non più disponibile")), "La riallocazione deve essere segnalata con warning.");

  // T4: identical pending orders have the same selective allocation from backoffice and retailer portal.
  await createParityOrder(ids.parityAdminOrder);
  await createParityOrder(ids.parityPortalOrder);
  await adminCaller.updateItems({ orderId: ids.parityAdminOrder, items: [{ productId: TEST_IDS.productBoxes, quantity: 5 }] });
  await portalCaller.updateItems({ id: ids.parityPortalOrder, items: [{ productId: TEST_IDS.productBoxes, quantity: 5 }] });
  const parityAdmin = await itemsFor(ids.parityAdminOrder);
  const parityPortal = await itemsFor(ids.parityPortalOrder);
  assert(JSON.stringify(parityAdmin) === JSON.stringify(parityPortal), "Portale e backoffice devono produrre la stessa assegnazione selettiva.");

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    tests: {
      unchangedThreeProducts: "PASS",
      increasedQuantity: "PASS",
      unavailableBatchReassignedWithWarning: "PASS",
      backofficeAndPortalParity: "PASS",
    },
    raw: { beforeUnchanged, afterUnchanged, afterIncrease, afterUnavailable, unavailableResult, parityAdmin, parityPortal },
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
