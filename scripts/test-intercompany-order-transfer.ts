import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { confirmIntercompanyTransferAndAssign, getIntercompanySourceBatches } from "../server/services/intercompanyOrderTransfer";
import { cancelOrderWithTransferReversal } from "../server/services/orderTransferReversal";
import { getStockMovementsAll, getStockMovementsByLocationId } from "../server/db";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("LOCAL_TEST_DATABASE_URL obbligatorio");
const ids = TEST_IDS;
const sourceBatch = "77777777-7777-7777-7777-777777777771";
const targetBatch = "77777777-7777-7777-7777-777777777772";
const run = randomUUID();
const sql = postgres(databaseUrl, { prepare: false, max: 5 });

async function setup({ sourcePieces = 60, existingTarget = false } = {}) {
  await seedHotfixM13();
  await sql`DELETE FROM "inventoryByBatch" WHERE "locationId" = ${ids.originCentral} AND "batchId" IN (${ids.batchSoon}, ${ids.batchFourMonths})`;
  await sql`UPDATE "orderItems" SET "batchId" = NULL, quantity = 5 WHERE "orderId" = ${ids.orderIntact}`;
  await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${sourceBatch}, ${ids.productBoxes}, 'IC-TEST-LOT', '2026-12-31', ${sourcePieces}, '3.2500', ${ids.soketoCompany})`;
  await sql`INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES (${ids.soketoCentral}, ${sourceBatch}, ${sourcePieces}, ${ids.soketoCompany})`;
  if (existingTarget) {
    await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${targetBatch}, ${ids.productBoxes}, 'IC-TEST-LOT', '2026-12-31', 1, '9.9900', ${ids.originCompany})`;
  }
  const [item] = await sql`SELECT id FROM "orderItems" WHERE "orderId" = ${ids.orderIntact} LIMIT 1`;
  return item.id as string;
}

async function stock(companyId: string, batchId: string) {
  const [row] = await sql`SELECT quantity FROM "inventoryByBatch" WHERE "companyId" = ${companyId} AND "batchId" = ${batchId}`;
  return Number(row?.quantity ?? 0);
}
async function transferCount(orderId: string) {
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "sourceDocumentType" = 'intercompany_transfer' AND "sourceDocument" = ${orderId}`;
  return Number(row.count);
}
async function rawTransferEvidence(orderId: string, sourceBatchId: string, mirrorBatchId: string) {
  const movements = await sql`SELECT id, "productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", "toLocationId", "sourceDocumentType", "sourceDocument", notes, "createdBy", "timestamp", "companyId" FROM "stockMovements" WHERE "sourceDocumentType" = 'intercompany_transfer' AND "sourceDocument" = ${orderId} ORDER BY "companyId", id`;
  const inventory = await sql`SELECT "companyId", "locationId", "batchId", quantity FROM "inventoryByBatch" WHERE ("companyId" = ${ids.soketoCompany} AND "batchId" = ${sourceBatchId}) OR ("companyId" = ${ids.originCompany} AND "batchId" = ${mirrorBatchId}) ORDER BY "companyId"`;
  return { movements, inventory };
}
const confirm = (orderItemId: string) => confirmIntercompanyTransferAndAssign({ orderItemId, sourceBatchId: sourceBatch, actorUserId: ids.adminUser, activeCompanyId: ids.originCompany });

async function testFullTransferAndNewMirror() {
  const itemId = await setup();
  const preview = await getIntercompanySourceBatches(itemId, ids.originCompany);
  assert.equal(preview.eligible, true);
  assert.equal(preview.batches[0].availablePieces, 60);
  const result = await confirm(itemId);
  assert.equal(result.quantityPieces, 30);
  assert.equal(await stock(ids.soketoCompany, sourceBatch), 30);
  assert.equal(await stock(ids.originCompany, result.batchId), 30);
  assert.equal(await transferCount(ids.orderIntact), 2);
  const [item] = await sql`SELECT "batchId" FROM "orderItems" WHERE id = ${itemId}`;
  const [mirror] = await sql`SELECT "batchNumber", "expirationDate", "costPrice" FROM "productBatches" WHERE id = ${result.batchId}`;
  assert.equal(item.batchId, result.batchId); assert.equal(mirror.batchNumber, "IC-TEST-LOT"); assert.equal(new Date(mirror.expirationDate).toISOString().slice(0, 10), "2026-12-31"); assert.equal(String(mirror.costPrice), "3.2500");
  const soketoLedger = await getStockMovementsByLocationId(ids.soketoCentral, ids.soketoCompany, 50);
  const eketoLedger = await getStockMovementsByLocationId(ids.originCentral, ids.originCompany, 50);
  const soketoGlobal = await getStockMovementsAll({ companyId: ids.soketoCompany, limit: 50, offset: 0 });
  const eketoGlobal = await getStockMovementsAll({ companyId: ids.originCompany, limit: 50, offset: 0 });
  const soketoTransfer = soketoLedger.filter((movement) => movement.notes?.includes("Travaso inter-company"));
  const eketoTransfer = eketoLedger.filter((movement) => movement.notes?.includes("Travaso inter-company"));
  assert.equal(soketoTransfer.length, 1); assert.equal(eketoTransfer.length, 1);
  assert.equal(soketoTransfer[0].fromLocationId, ids.soketoCentral); assert.equal(soketoTransfer[0].toLocationId, null);
  assert.equal(eketoTransfer[0].fromLocationId, null); assert.equal(eketoTransfer[0].toLocationId, ids.originCentral);
  assert.equal(soketoGlobal.items.filter((movement) => movement.notes?.includes("Travaso inter-company")).length, 1);
  assert.equal(eketoGlobal.items.filter((movement) => movement.notes?.includes("Travaso inter-company")).length, 1);
  console.log("T1/T2/T8 PASS full transfer + company-scoped ledger", JSON.stringify({ before: { soketo: 60, eketo: 0 }, after: { soketo: 30, eketo: 30 }, movements: 2, assignedBatchId: result.batchId, mirror, soketoLedgerEntries: soketoTransfer.length, eketoLedgerEntries: eketoTransfer.length, soketoGlobalTransferEntries: soketoGlobal.items.filter((movement) => movement.notes?.includes("Travaso inter-company")).length, eketoGlobalTransferEntries: eketoGlobal.items.filter((movement) => movement.notes?.includes("Travaso inter-company")).length, raw: await rawTransferEvidence(ids.orderIntact, sourceBatch, result.batchId) }, null, 2));
}

async function testExistingMirrorPreserved() {
  const itemId = await setup({ existingTarget: true });
  const result = await confirm(itemId);
  assert.equal(result.batchId, targetBatch);
  const [mirror] = await sql`SELECT "costPrice" FROM "productBatches" WHERE id = ${targetBatch}`;
  assert.equal(String(mirror.costPrice), "9.9900");
  console.log("T3 PASS existing mirror cost not overwritten", { batchId: result.batchId, costPrice: mirror.costPrice });
}

async function testInsufficientAtomic() {
  const itemId = await setup({ sourcePieces: 29 });
  await assert.rejects(() => confirm(itemId), /Giacenza SoKeto insufficiente/);
  assert.equal(await stock(ids.soketoCompany, sourceBatch), 29);
  assert.equal(await transferCount(ids.orderIntact), 0);
  const [item] = await sql`SELECT "batchId" FROM "orderItems" WHERE id = ${itemId}`;
  assert.equal(item.batchId, null);
  console.log("T4 PASS insufficient stock rolls back", { soketo: 29, movements: 0, batchId: item.batchId });
}

async function testIdempotency() {
  const itemId = await setup();
  await confirm(itemId); const second = await confirm(itemId);
  assert.equal(second.alreadyAssigned, true); assert.equal(await transferCount(ids.orderIntact), 2);
  console.log("T5 PASS duplicate confirm", { alreadyAssigned: second.alreadyAssigned, movements: 2 });
}

async function testConcurrency() {
  const itemOne = await setup();
  const [secondItem] = await sql`INSERT INTO "orderItems" ("orderId", "productId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName") VALUES (${ids.orderPartial}, ${ids.productBoxes}, 5, 10, 0, 10, 10, 50, 55, 'TEST-BOX-6', 'TEST Prodotto Confezione 6') RETURNING id`;
  const results = await Promise.allSettled([confirm(itemOne), confirm(secondItem.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(await stock(ids.soketoCompany, sourceBatch), 0);
  assert.equal(await transferCount(ids.orderIntact) + await transferCount(ids.orderPartial), 4);
  console.log("T6 PASS concurrent confirmations serialized", { results: results.map((r) => r.status), soketoRemaining: 0, movements: 4 });
}

async function testSameItemConcurrency() {
  const itemId = await setup();
  const results = await Promise.all([confirm(itemId), confirm(itemId)]);
  assert.equal(results.filter((result) => !result.alreadyAssigned).length, 1);
  assert.equal(results.filter((result) => result.alreadyAssigned).length, 1);
  assert.equal(await stock(ids.soketoCompany, sourceBatch), 30);
  assert.equal(await transferCount(ids.orderIntact), 2);
  console.log("T6b PASS concurrent same order item is idempotent", JSON.stringify({ results: results.map((result) => ({ alreadyAssigned: result.alreadyAssigned, batchId: result.batchId })), soketoRemaining: 30, movements: 2, raw: await rawTransferEvidence(ids.orderIntact, sourceBatch, results[0].batchId) }, null, 2));
}

async function testCancellationNoReverseTransfer() {
  const itemId = await setup(); await confirm(itemId);
  const [assigned] = await sql`SELECT "batchId" FROM "orderItems" WHERE id = ${itemId}`;
  const before = await stock(ids.originCompany, assigned.batchId);
  await cancelOrderWithTransferReversal({ orderId: ids.orderIntact, actorUserId: ids.adminUser, reason: "test cancellation after intercompany transfer" });
  assert.equal(await stock(ids.originCompany, assigned.batchId), before);
  assert.equal(await transferCount(ids.orderIntact), 2);
  console.log("T7 PASS cancelled order keeps stock in E-Keto", JSON.stringify({ eketoBefore: before, eketoAfter: before, intercompanyMovements: 2, raw: await rawTransferEvidence(ids.orderIntact, sourceBatch, assigned.batchId) }, null, 2));
}

async function main() {
  console.log(`INTERCOMPANY_TRANSFER_TEST_RUN=${run}`);
  await testFullTransferAndNewMirror(); await testExistingMirrorPreserved(); await testInsufficientAtomic(); await testIdempotency(); await testConcurrency(); await testSameItemConcurrency(); await testCancellationNoReverseTransfer();
  console.log("INTERCOMPANY_TRANSFER_TESTS=PASS");
}
main().then(() => sql.end({ timeout: 5 })).catch(async (error) => { console.error(error); await sql.end({ timeout: 5 }); process.exitCode = 1; });
