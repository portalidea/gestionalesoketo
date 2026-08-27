import assert from "node:assert/strict";
import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";
import type { ShopifyOrder } from "../server/services/shopifyService";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;
// Il dispatcher importa il modulo ENV che richiede queste chiavi all'avvio.
// Sono placeholder solo per l'isolated test: nessun codice del test usa
// Supabase né può raggiungere servizi esterni.
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_ANON_KEY ??= "local-test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "local-test-service-role-key";

const sql = postgres(databaseUrl, { prepare: false, max: 2 });
const ids = TEST_IDS;
const STORE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const VARIANT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2";
const BATCH_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3";
const CUTOFF = "2026-09-01";

function shopifyOrder(id: number, createdAt: string, quantity = 5): ShopifyOrder {
  return {
    id,
    order_number: id,
    name: `#${id}`,
    email: "customer@local.invalid",
    customer: { first_name: "Shopify", last_name: "Test" },
    created_at: createdAt,
    total_price: "50.00",
    currency: "EUR",
    financial_status: "paid",
    fulfillment_status: null,
    shipping_address: { country_code: "IT" },
    line_items: [{ id: id * 10, sku: "SHOPIFY-TEST-BOX", name: "Test Shopify Box", quantity, price: "10.00", product_id: 1, variant_id: 1 }],
  };
}

async function setup({ cutoff = CUTOFF, quantity = 20 }: { cutoff?: string | null; quantity?: number } = {}) {
  await sql`DELETE FROM "stockMovements" WHERE "marketplaceOrderId" IN (SELECT id FROM marketplace_orders WHERE "storeId" = ${STORE_ID})`;
  await sql`DELETE FROM marketplace_orders WHERE "storeId" = ${STORE_ID}`;
  await sql`DELETE FROM channel_variants WHERE id = ${VARIANT_ID}`;
  await sql`DELETE FROM sales_stores WHERE id = ${STORE_ID}`;
  await sql`DELETE FROM "inventoryByBatch" WHERE "batchId" = ${BATCH_ID}`;
  await sql`DELETE FROM "productBatches" WHERE id = ${BATCH_ID}`;
  await seedHotfixM13();

  await sql`
    INSERT INTO sales_stores (id, channel, name, "storeIdentifier", "apiCredentials", "isActive", "companyId", "orderImportStartDate")
    VALUES (${STORE_ID}, 'shopify', 'TEST Shopify SoKeto', 'test-shopify.local', ${sql.json({ accessToken: "test-token" })}, true, ${ids.soketoCompany}, ${cutoff}::date)
  `;
  await sql`
    INSERT INTO channel_variants (id, "storeId", "productId", "channelSku", multiplier, "isActive", "isBundle")
    VALUES (${VARIANT_ID}, ${STORE_ID}, ${ids.productBoxes}, 'SHOPIFY-TEST-BOX', 1, true, false)
  `;
  await sql`
    INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId")
    VALUES (${BATCH_ID}, ${ids.productBoxes}, 'SHOPIFY-TEST-BATCH', '2027-01-31', ${quantity}, '2.0000', ${ids.soketoCompany})
  `;
  await sql`
    INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId")
    VALUES (${ids.soketoCentral}, ${BATCH_ID}, ${quantity}, ${ids.soketoCompany})
  `;
}

async function rawEvidence(orderId: string | null) {
  const inventory = await sql`
    SELECT id, "locationId", "batchId", quantity, "companyId", "updatedAt"
    FROM "inventoryByBatch" WHERE "batchId" = ${BATCH_ID}
  `;
  const movements = orderId ? await sql`
    SELECT id, "marketplaceOrderId", "productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", "toLocationId", "companyId", notes, "notesInternal", "timestamp"
    FROM "stockMovements" WHERE "marketplaceOrderId" = ${orderId} ORDER BY "timestamp", id
  ` : [];
  const orders = await sql`
    SELECT id, "channelOrderNumber", "orderDate", "syncedAt", "stockProcessingStatus", "stockProcessingAttempts", "stockProcessingError"
    FROM marketplace_orders WHERE "storeId" = ${STORE_ID} ORDER BY "channelOrderNumber"
  `;
  return { inventory, movements, orders };
}

async function inventoryQuantity() {
  const [row] = await sql`SELECT quantity FROM "inventoryByBatch" WHERE "batchId" = ${BATCH_ID}`;
  return Number(row.quantity);
}

async function storeLastSyncAt() {
  const [row] = await sql`SELECT "lastSyncAt" FROM sales_stores WHERE id = ${STORE_ID}`;
  return row?.lastSyncAt ? new Date(row.lastSyncAt) : null;
}

async function testPreCutoffRejected() {
  const { importShopifyOrder } = await import("../server/services/marketplaceOrderService");
  await setup();
  const imported = await importShopifyOrder(STORE_ID, shopifyOrder(9001, "2026-08-31T23:59:59+02:00"));
  assert.equal(imported.status, "skipped_before_cutoff");
  assert.equal(imported.marketplaceOrderId, null);
  assert.equal(await inventoryQuantity(), 20);
  const [{ count: movementCount }] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "batchId" = ${BATCH_ID}`;
  const [{ count: importedCount }] = await sql`SELECT COUNT(*)::int AS count FROM marketplace_orders WHERE "storeId" = ${STORE_ID}`;
  assert.equal(Number(movementCount), 0);
  assert.equal(Number(importedCount), 0);
  console.log("T1 PASS pre-cutoff rejected", JSON.stringify({ imported, raw: await rawEvidence(null) }, null, 2));
}

async function testSuccessfulAtomicExit() {
  const { importShopifyOrder, processStockForMarketplaceOrder } = await import("../server/services/marketplaceOrderService");
  await setup();
  const imported = await importShopifyOrder(STORE_ID, shopifyOrder(9002, "2026-09-01T00:00:00+02:00"));
  assert.equal(imported.status, "imported");
  assert.ok(imported.marketplaceOrderId);
  const result = await processStockForMarketplaceOrder(imported.marketplaceOrderId, ids.soketoCompany);
  assert.equal(result.status, "processed");
  assert.equal(await inventoryQuantity(), 15);
  const [movement] = await sql`
    SELECT type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", "toLocationId", "companyId"
    FROM "stockMovements" WHERE "marketplaceOrderId" = ${imported.marketplaceOrderId}
  `;
  assert.deepEqual({ ...movement }, {
    type: "SHOPIFY_EXIT",
    quantity: 5,
    previousQuantity: 20,
    newQuantity: 15,
    batchId: BATCH_ID,
    fromLocationId: ids.soketoCentral,
    toLocationId: null,
    companyId: ids.soketoCompany,
  });
  console.log("T2 PASS atomic Shopify exit", JSON.stringify({ imported, result, before: 20, after: 15, raw: await rawEvidence(imported.marketplaceOrderId) }, null, 2));
}

async function testMovementInsertRollback() {
  const { importShopifyOrder, processStockForMarketplaceOrder } = await import("../server/services/marketplaceOrderService");
  await setup();
  await sql`
    CREATE OR REPLACE FUNCTION public.test_fail_shopify_exit() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.type = 'SHOPIFY_EXIT' THEN RAISE EXCEPTION 'injected Shopify ledger failure'; END IF;
      RETURN NEW;
    END;
    $$
  `;
  await sql`CREATE TRIGGER test_fail_shopify_exit_trigger BEFORE INSERT ON "stockMovements" FOR EACH ROW EXECUTE FUNCTION public.test_fail_shopify_exit()`;
  try {
    const imported = await importShopifyOrder(STORE_ID, shopifyOrder(9003, "2026-09-02T10:00:00+02:00"));
    assert.ok(imported.marketplaceOrderId);
    const result = await processStockForMarketplaceOrder(imported.marketplaceOrderId, ids.soketoCompany);
    assert.equal(result.status, "failed");
    assert.equal(await inventoryQuantity(), 20);
    const [{ count: movementCount }] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "marketplaceOrderId" = ${imported.marketplaceOrderId}`;
    assert.equal(Number(movementCount), 0);
    console.log("T3 PASS failed ledger insert rolls back inventory", JSON.stringify({ imported, result, before: 20, after: 20, raw: await rawEvidence(imported.marketplaceOrderId) }, null, 2));
  } finally {
    await sql`DROP TRIGGER IF EXISTS test_fail_shopify_exit_trigger ON "stockMovements"`;
    await sql`DROP FUNCTION IF EXISTS public.test_fail_shopify_exit()`;
  }
}

async function testDuplicateImportSingleExit() {
  const { importShopifyOrder, processStockForMarketplaceOrder } = await import("../server/services/marketplaceOrderService");
  await setup();
  const payload = shopifyOrder(9004, "2026-09-03T10:00:00+02:00");
  const first = await importShopifyOrder(STORE_ID, payload);
  assert.ok(first.marketplaceOrderId);
  const processed = await processStockForMarketplaceOrder(first.marketplaceOrderId, ids.soketoCompany);
  const second = await importShopifyOrder(STORE_ID, payload);
  assert.equal(processed.status, "processed");
  assert.equal(second.status, "duplicate");
  assert.equal(second.marketplaceOrderId, first.marketplaceOrderId);
  assert.equal(await inventoryQuantity(), 15);
  const [{ count: movementCount }] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "marketplaceOrderId" = ${first.marketplaceOrderId} AND type = 'SHOPIFY_EXIT'`;
  assert.equal(Number(movementCount), 1);
  console.log("T4 PASS duplicate import has one stock exit", JSON.stringify({ first, processed, second, raw: await rawEvidence(first.marketplaceOrderId) }, null, 2));
}

async function testDailyDispatcher() {
  const { runScheduledDispatcher } = await import("../server/cron-alerts");
  await setup();
  let receivedStart: string | null = null;
  const result = await runScheduledDispatcher({
    now: new Date("2026-09-04T05:00:00.000Z"),
    m13CronEnabled: false,
    shopifyFetchOrders: async (_store, params) => {
      receivedStart = params.createdAtMin;
      assert.equal(params.financialStatus, "paid");
      return [
        shopifyOrder(9005, "2026-08-31T12:00:00+02:00"),
        shopifyOrder(9006, "2026-09-04T06:00:00+02:00"),
      ];
    },
  });
  const store = result.shopifyOrderSync.results.find((entry) => entry.storeId === STORE_ID);
  assert.ok(store);
  assert.equal(result.shopifyOrderSync.scheduled, true);
  assert.equal(receivedStart, "2026-08-31T22:00:00.000Z");
  assert.equal(store.imported, 1);
  assert.equal(store.skippedBeforeCutoff, 1);
  assert.equal(store.processedStock, 1);
  assert.equal(await inventoryQuantity(), 15);
  const [importedOrder] = await sql`
    SELECT id FROM marketplace_orders
    WHERE "storeId" = ${STORE_ID} AND "channelOrderId" = '9006'
  `;
  assert.ok(importedOrder?.id);
  const evidence = await rawEvidence(importedOrder.id);
  assert.equal(evidence.movements.length, 1);
  assert.equal(evidence.movements[0]?.type, "SHOPIFY_EXIT");
  assert.equal(evidence.movements[0]?.companyId, ids.soketoCompany);
  console.log("T5 PASS daily dispatcher imports paid post-cutoff only", JSON.stringify({ result, raw: evidence }, null, 2));
}

async function testDailyDispatcherDoesNotStartBeforeCutoff() {
  const { runScheduledDispatcher } = await import("../server/cron-alerts");
  await setup();
  let fetchCalled = false;
  const result = await runScheduledDispatcher({
    now: new Date("2026-08-31T12:00:00.000Z"),
    m13CronEnabled: false,
    shopifyFetchOrders: async () => {
      fetchCalled = true;
      return [];
    },
  });
  const store = result.shopifyOrderSync.results.find((entry) => entry.storeId === STORE_ID);
  assert.ok(store);
  assert.equal(store.notStarted, true);
  assert.equal(fetchCalled, false);
  assert.equal(await inventoryQuantity(), 20);
  const [{ count: importedCount }] = await sql`SELECT COUNT(*)::int AS count FROM marketplace_orders WHERE "storeId" = ${STORE_ID}`;
  assert.equal(Number(importedCount), 0);
  console.log("T6 PASS daily dispatcher does not fetch before cutoff", JSON.stringify({ result, fetchCalled, raw: await rawEvidence(null) }, null, 2));
}

async function testGapOfThreeDaysIsRecovered() {
  const { runScheduledDispatcher } = await import("../server/cron-alerts");
  await setup();
  const lastSuccessfulSync = new Date("2026-09-04T05:00:00.000Z");
  const now = new Date("2026-09-07T05:00:00.000Z");
  await sql`UPDATE sales_stores SET "lastSyncAt" = ${lastSuccessfulSync} WHERE id = ${STORE_ID}`;
  let fetchStart: string | null = null;
  const result = await runScheduledDispatcher({
    now,
    m13CronEnabled: false,
    shopifyFetchOrders: async (_store, params) => {
      fetchStart = params.createdAtMin;
      return [shopifyOrder(9007, "2026-09-06T10:00:00+02:00")];
    },
  });
  const store = result.shopifyOrderSync.results.find((entry) => entry.storeId === STORE_ID);
  assert.ok(store);
  assert.equal(fetchStart, "2026-09-02T05:00:00.000Z");
  assert.deepEqual(store.gapRecovered, {
    lastSuccessfulSyncAt: "2026-09-04T05:00:00.000Z",
    gapStart: "2026-09-04T05:00:00.000Z",
    gapEnd: "2026-09-07T05:00:00.000Z",
    elapsedHours: 72,
  });
  assert.equal(store.gapTooLarge, null);
  assert.equal(store.lastSyncAtUpdated, true);
  assert.equal((await storeLastSyncAt())?.toISOString(), now.toISOString());
  assert.equal(await inventoryQuantity(), 15);
  console.log("T7 PASS three-day gap recovered", JSON.stringify({ result, fetchStart, raw: await rawEvidence(null) }, null, 2));
}

async function testGapOverSevenDaysBlocksImport() {
  const { runScheduledDispatcher } = await import("../server/cron-alerts");
  await setup();
  const lastSuccessfulSync = new Date("2026-09-01T05:00:00.000Z");
  const now = new Date("2026-09-11T05:00:00.000Z");
  await sql`UPDATE sales_stores SET "lastSyncAt" = ${lastSuccessfulSync} WHERE id = ${STORE_ID}`;
  let fetchCalled = false;
  const result = await runScheduledDispatcher({
    now,
    m13CronEnabled: false,
    shopifyFetchOrders: async () => {
      fetchCalled = true;
      return [shopifyOrder(9008, "2026-09-10T10:00:00+02:00")];
    },
  });
  const store = result.shopifyOrderSync.results.find((entry) => entry.storeId === STORE_ID);
  assert.ok(store);
  assert.equal(fetchCalled, false);
  assert.equal(store.imported, 0);
  assert.equal(store.gapRecovered, null);
  assert.deepEqual(store.gapTooLarge, {
    lastSuccessfulSyncAt: "2026-09-01T05:00:00.000Z",
    gapStart: "2026-09-01T05:00:00.000Z",
    gapEnd: "2026-09-11T05:00:00.000Z",
    elapsedHours: 240,
  });
  assert.match(store.errors[0]?.error || "", /supera il limite automatico di 7 giorni/);
  assert.equal((await storeLastSyncAt())?.toISOString(), lastSuccessfulSync.toISOString());
  assert.equal(await inventoryQuantity(), 20);
  console.log("T8 PASS ten-day gap blocks automatic import", JSON.stringify({ result, fetchCalled, raw: await rawEvidence(null) }, null, 2));
}

async function testProcessingErrorDoesNotAdvanceWatermark() {
  const { runScheduledDispatcher } = await import("../server/cron-alerts");
  await setup();
  const lastSuccessfulSync = new Date("2026-09-04T05:00:00.000Z");
  await sql`UPDATE sales_stores SET "lastSyncAt" = ${lastSuccessfulSync} WHERE id = ${STORE_ID}`;
  const invalidSkuOrder = shopifyOrder(9009, "2026-09-05T10:00:00+02:00");
  invalidSkuOrder.line_items[0].sku = "UNMAPPED-SHOPIFY-SKU";
  const result = await runScheduledDispatcher({
    now: new Date("2026-09-05T12:00:00.000Z"),
    m13CronEnabled: false,
    shopifyFetchOrders: async () => [invalidSkuOrder],
  });
  const store = result.shopifyOrderSync.results.find((entry) => entry.storeId === STORE_ID);
  assert.ok(store);
  assert.equal(store.imported, 1);
  assert.equal(store.failedStock, 1);
  assert.equal(store.lastSyncAtUpdated, false);
  assert.equal((await storeLastSyncAt())?.toISOString(), lastSuccessfulSync.toISOString());
  assert.equal(await inventoryQuantity(), 20);
  assert.ok(store.errors.some((entry) => entry.error.includes("lastSyncAt invariato")));
  console.log("T9 PASS processing error leaves lastSyncAt unchanged", JSON.stringify({ result, raw: await rawEvidence(null) }, null, 2));
}

async function testDuplicateFailedOrderDoesNotAdvanceWatermark() {
  const { importShopifyOrder, processStockForMarketplaceOrder } = await import("../server/services/marketplaceOrderService");
  const { runScheduledDispatcher } = await import("../server/cron-alerts");
  await setup();
  const lastSuccessfulSync = new Date("2026-09-05T05:00:00.000Z");
  await sql`UPDATE sales_stores SET "lastSyncAt" = ${lastSuccessfulSync} WHERE id = ${STORE_ID}`;
  const invalidSkuOrder = shopifyOrder(9010, "2026-09-06T10:00:00+02:00");
  invalidSkuOrder.line_items[0].sku = "UNMAPPED-DUPLICATE-SKU";
  const imported = await importShopifyOrder(STORE_ID, invalidSkuOrder);
  assert.ok(imported.marketplaceOrderId);
  assert.equal((await processStockForMarketplaceOrder(imported.marketplaceOrderId, ids.soketoCompany)).status, "failed");
  const result = await runScheduledDispatcher({
    now: new Date("2026-09-06T12:00:00.000Z"),
    m13CronEnabled: false,
    shopifyFetchOrders: async () => [invalidSkuOrder],
  });
  const store = result.shopifyOrderSync.results.find((entry) => entry.storeId === STORE_ID);
  assert.ok(store);
  assert.equal(store.duplicates, 0);
  assert.equal(store.failedStock, 1);
  assert.equal(store.lastSyncAtUpdated, false);
  assert.equal((await storeLastSyncAt())?.toISOString(), lastSuccessfulSync.toISOString());
  assert.ok(store.errors.some((entry) => entry.error.includes("già importato ma non elaborato con successo")));
  console.log("T10 PASS failed duplicate leaves lastSyncAt unchanged", JSON.stringify({ imported, result, raw: await rawEvidence(imported.marketplaceOrderId) }, null, 2));
}

async function main() {
  console.log("SHOPIFY_AUTOMATIC_STOCK_TEST_RUN=2026-09-cutoff");
  await testPreCutoffRejected();
  await testSuccessfulAtomicExit();
  await testMovementInsertRollback();
  await testDuplicateImportSingleExit();
  await testDailyDispatcher();
  await testDailyDispatcherDoesNotStartBeforeCutoff();
  await testGapOfThreeDaysIsRecovered();
  await testGapOverSevenDaysBlocksImport();
  await testProcessingErrorDoesNotAdvanceWatermark();
  await testDuplicateFailedOrderDoesNotAdvanceWatermark();
  console.log("SHOPIFY_AUTOMATIC_STOCK_TESTS=PASS");
}

main().then(() => sql.end({ timeout: 5 })).catch(async (error) => {
  console.error(error);
  await sql.end({ timeout: 5 });
  process.exitCode = 1;
});
