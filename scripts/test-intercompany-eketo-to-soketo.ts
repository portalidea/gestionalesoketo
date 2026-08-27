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
const sourceBatch = "77777777-7777-7777-7777-777777777781";
const existingMirrorBatch = "77777777-7777-7777-7777-777777777782";
const run = randomUUID();
const sql = postgres(databaseUrl, { prepare: false, max: 5 });

async function setup({ sourcePieces = 60, existingTarget = false } = {}) {
  await seedHotfixM13();
  await sql`UPDATE orders SET "companyId" = ${ids.soketoCompany}, "orderNumber" = 'TEST-SOK-001' WHERE id = ${ids.orderIntact}`;
  await sql`UPDATE "orderItems" SET "batchId" = NULL, quantity = 5 WHERE "orderId" = ${ids.orderIntact}`;
  await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${sourceBatch}, ${ids.productBoxes}, 'IC-REVERSE-LOT', '2026-12-31', ${sourcePieces}, '2.7500', ${ids.originCompany})`;
  await sql`INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES (${ids.originCentral}, ${sourceBatch}, ${sourcePieces}, ${ids.originCompany})`;
  if (existingTarget) {
    await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${existingMirrorBatch}, ${ids.productBoxes}, 'IC-REVERSE-LOT', '2026-12-31', 1, '9.9900', ${ids.soketoCompany})`;
  }
  const [item] = await sql`SELECT id FROM "orderItems" WHERE "orderId" = ${ids.orderIntact} LIMIT 1`;
  return item.id as string;
}

async function stock(companyId: string, batchId: string) {
  const [row] = await sql`SELECT quantity FROM "inventoryByBatch" WHERE "companyId" = ${companyId} AND "batchId" = ${batchId}`;
  return Number(row?.quantity ?? 0);
}

async function transferCount() {
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "sourceDocumentType" = 'intercompany_transfer' AND "sourceDocument" = ${ids.orderIntact}`;
  return Number(row.count);
}

async function rawEvidence(targetBatchId: string) {
  const movements = await sql`SELECT id, "productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", "toLocationId", "sourceDocumentType", "sourceDocument", notes, "notesInternal", "createdBy", "timestamp", "companyId" FROM "stockMovements" WHERE "sourceDocumentType" = 'intercompany_transfer' AND "sourceDocument" = ${ids.orderIntact} ORDER BY "companyId", id`;
  const inventory = await sql`SELECT "companyId", "locationId", "batchId", quantity FROM "inventoryByBatch" WHERE ("companyId" = ${ids.originCompany} AND "batchId" = ${sourceBatch}) OR ("companyId" = ${ids.soketoCompany} AND "batchId" = ${targetBatchId}) ORDER BY "companyId"`;
  const [item] = await sql`SELECT id, "orderId", "batchId", quantity FROM "orderItems" WHERE "orderId" = ${ids.orderIntact}`;
  return { inventory, movements, item };
}

const confirm = (orderItemId: string) => confirmIntercompanyTransferAndAssign({
  orderItemId,
  sourceBatchId: sourceBatch,
  actorUserId: ids.adminUser,
  activeCompanyId: ids.soketoCompany,
});

async function testFullReverseTransfer() {
  const itemId = await setup();
  const preview = await getIntercompanySourceBatches(itemId, ids.soketoCompany);
  assert.equal(preview.eligible, true);
  assert.equal(preview.directionLabel, "E-Keto → SoKeto");
  assert.equal(preview.sourceCompanyName, "E-Keto");
  assert.equal(preview.destinationCompanyName, "SoKeto");
  assert.equal(preview.batches.find((batch) => batch.batchId === sourceBatch)?.availablePieces, 60);
  const result = await confirm(itemId);
  assert.equal(result.directionLabel, "E-Keto → SoKeto");
  assert.equal(result.quantityPieces, 30);
  assert.equal(await stock(ids.originCompany, sourceBatch), 30);
  assert.equal(await stock(ids.soketoCompany, result.batchId), 30);
  assert.equal(await transferCount(), 2);
  const [mirror] = await sql`SELECT "batchNumber", "expirationDate", "costPrice" FROM "productBatches" WHERE id = ${result.batchId}`;
  assert.equal(mirror.batchNumber, "IC-REVERSE-LOT");
  assert.equal(new Date(mirror.expirationDate).toISOString().slice(0, 10), "2026-12-31");
  assert.equal(String(mirror.costPrice), "2.7500");
  const eketoLedger = await getStockMovementsByLocationId(ids.originCentral, ids.originCompany, 50);
  const soketoLedger = await getStockMovementsByLocationId(ids.soketoCentral, ids.soketoCompany, 50);
  const eketoGlobal = await getStockMovementsAll({ companyId: ids.originCompany, limit: 50, offset: 0 });
  const soketoGlobal = await getStockMovementsAll({ companyId: ids.soketoCompany, limit: 50, offset: 0 });
  const eketoTransfer = eketoLedger.filter((movement) => movement.notes?.includes("E-Keto → SoKeto"));
  const soketoTransfer = soketoLedger.filter((movement) => movement.notes?.includes("E-Keto → SoKeto"));
  assert.equal(eketoTransfer.length, 1); assert.equal(soketoTransfer.length, 1);
  assert.equal(eketoTransfer[0].fromLocationId, ids.originCentral); assert.equal(eketoTransfer[0].toLocationId, null);
  assert.equal(soketoTransfer[0].fromLocationId, null); assert.equal(soketoTransfer[0].toLocationId, ids.soketoCentral);
  assert.equal(eketoGlobal.items.filter((movement) => movement.notes?.includes("E-Keto → SoKeto")).length, 1);
  assert.equal(soketoGlobal.items.filter((movement) => movement.notes?.includes("E-Keto → SoKeto")).length, 1);
  console.log("R1/R2/R3 PASS E-Keto→SoKeto full transfer + mirror + scoped ledger", JSON.stringify({ preview, result, raw: await rawEvidence(result.batchId) }, null, 2));
}

async function testExistingMirrorPreserved() {
  const itemId = await setup({ existingTarget: true });
  const result = await confirm(itemId);
  assert.equal(result.batchId, existingMirrorBatch);
  const [mirror] = await sql`SELECT "costPrice" FROM "productBatches" WHERE id = ${existingMirrorBatch}`;
  assert.equal(String(mirror.costPrice), "9.9900");
  console.log("R4 PASS E-Keto→SoKeto existing mirror cost preserved", JSON.stringify({ result, mirror, raw: await rawEvidence(result.batchId) }, null, 2));
}

async function testInsufficientIsAtomic() {
  const itemId = await setup({ sourcePieces: 29 });
  await assert.rejects(() => confirm(itemId), /Giacenza E-Keto insufficiente/);
  assert.equal(await stock(ids.originCompany, sourceBatch), 29);
  assert.equal(await transferCount(), 0);
  const [item] = await sql`SELECT "batchId" FROM "orderItems" WHERE id = ${itemId}`;
  assert.equal(item.batchId, null);
  console.log("R5 PASS E-Keto→SoKeto insufficient source is atomic", JSON.stringify({ raw: await rawEvidence(existingMirrorBatch) }, null, 2));
}

async function testSameItemIdempotency() {
  const itemId = await setup();
  const results = await Promise.all([confirm(itemId), confirm(itemId)]);
  assert.equal(results.filter((result) => !result.alreadyAssigned).length, 1);
  assert.equal(results.filter((result) => result.alreadyAssigned).length, 1);
  assert.equal(await stock(ids.originCompany, sourceBatch), 30);
  assert.equal(await transferCount(), 2);
  console.log("R6 PASS E-Keto→SoKeto same-item confirmation is idempotent", JSON.stringify({ results, raw: await rawEvidence(results[0].batchId) }, null, 2));
}

async function testCancellationDoesNotReverse() {
  const itemId = await setup();
  const result = await confirm(itemId);
  const before = await stock(ids.soketoCompany, result.batchId);
  await cancelOrderWithTransferReversal({ orderId: ids.orderIntact, actorUserId: ids.adminUser, reason: "reverse transfer cancellation test" });
  assert.equal(await stock(ids.soketoCompany, result.batchId), before);
  assert.equal(await transferCount(), 2);
  console.log("R7 PASS E-Keto→SoKeto cancelled order keeps stock in SoKeto", JSON.stringify({ before, after: before, raw: await rawEvidence(result.batchId) }, null, 2));
}

async function main() {
  console.log(`INTERCOMPANY_EKETO_TO_SOKETO_TEST_RUN=${run}`);
  await testFullReverseTransfer();
  await testExistingMirrorPreserved();
  await testInsufficientIsAtomic();
  await testSameItemIdempotency();
  await testCancellationDoesNotReverse();
  console.log("INTERCOMPANY_EKETO_TO_SOKETO_TESTS=PASS");
}

main().then(() => sql.end({ timeout: 5 })).catch(async (error) => { console.error(error); await sql.end({ timeout: 5 }); process.exitCode = 1; });
