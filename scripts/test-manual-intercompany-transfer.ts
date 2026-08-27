import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { confirmManualIntercompanyTransfer, getManualIntercompanySourceBatches } from "../server/services/intercompanyOrderTransfer";
import { loadIntercompanyTransfers } from "../server/reports-router";
import { getDb } from "../server/db";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("LOCAL_TEST_DATABASE_URL obbligatorio");
const ids = TEST_IDS;
const sourceBatch = "77777777-7777-7777-7777-777777777801";
const existingTargetBatch = "77777777-7777-7777-7777-777777777802";
const sql = postgres(databaseUrl, { prepare: false, max: 5 });

async function setup({ sourcePieces = 80, existingTarget = false } = {}) {
  await seedHotfixM13();
  await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${sourceBatch}, ${ids.productBoxes}, 'IC-MANUAL-LOT', '2026-12-31', ${sourcePieces}, '2.7500', ${ids.originCompany})`;
  await sql`INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES (${ids.originCentral}, ${sourceBatch}, ${sourcePieces}, ${ids.originCompany})`;
  if (existingTarget) {
    await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${existingTargetBatch}, ${ids.productBoxes}, 'IC-MANUAL-LOT', '2026-12-31', 1, '9.9900', ${ids.soketoCompany})`;
  }
}

async function stock(companyId: string, batchId: string) {
  const [row] = await sql`SELECT quantity FROM "inventoryByBatch" WHERE "companyId" = ${companyId} AND "batchId" = ${batchId}`;
  return Number(row?.quantity ?? 0);
}

async function rawEvidence(...refs: string[]) {
  const movements = await sql`SELECT id, "productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", "toLocationId", "sourceDocumentType", "sourceDocument", notes, "createdBy", "timestamp", "companyId" FROM "stockMovements" WHERE "sourceDocumentType" = 'intercompany_manual_transfer' AND "sourceDocument" IN ${sql(refs)} ORDER BY "sourceDocument", "companyId", id`;
  const inventory = await sql`SELECT "companyId", "locationId", "batchId", quantity FROM "inventoryByBatch" WHERE "batchId" IN (${sourceBatch}, ${existingTargetBatch}) OR ("companyId" = ${ids.soketoCompany} AND "batchId" IN (SELECT "batchId" FROM "stockMovements" WHERE "sourceDocument" IN ${sql(refs)})) ORDER BY "companyId", "batchId"`;
  return { movements, inventory };
}

function manualInput(overrides: Partial<Parameters<typeof confirmManualIntercompanyTransfer>[0]> = {}) {
  return {
    sourceCompanyId: ids.originCompany,
    destinationCompanyId: ids.soketoCompany,
    sourceBatchId: sourceBatch,
    quantityPieces: 40,
    notes: "Riallineamento fisico magazzino condiviso",
    transferReference: `manual:${randomUUID()}`,
    actorUserId: ids.adminUser,
    ...overrides,
  };
}

async function testBidirectionalManualAndReport() {
  await setup();
  const preview = await getManualIntercompanySourceBatches({ sourceCompanyId: ids.originCompany, destinationCompanyId: ids.soketoCompany, productId: ids.productBoxes });
  assert.equal(preview.directionLabel, "E-Keto → SoKeto");
  assert.equal(preview.batches.find((batch) => batch.batchId === sourceBatch)?.availablePieces, 80);
  const forward = await confirmManualIntercompanyTransfer(manualInput());
  assert.equal(forward.alreadyTransferred, false);
  assert.equal(forward.directionLabel, "E-Keto → SoKeto");
  if (!forward.targetBatchId) throw new Error("Il travaso manuale riuscito deve restituire il lotto destinazione");
  const forwardTargetBatchId = forward.targetBatchId;
  assert.equal(await stock(ids.originCompany, sourceBatch), 40);
  assert.equal(await stock(ids.soketoCompany, forwardTargetBatchId), 40);
  const [mirror] = await sql`SELECT "batchNumber", "expirationDate", "costPrice" FROM "productBatches" WHERE id = ${forwardTargetBatchId}`;
  assert.equal(mirror.batchNumber, "IC-MANUAL-LOT");
  assert.equal(new Date(mirror.expirationDate).toISOString().slice(0, 10), "2026-12-31");
  assert.equal(String(mirror.costPrice), "2.7500");
  const reverse = await confirmManualIntercompanyTransfer(manualInput({
    sourceCompanyId: ids.soketoCompany,
    destinationCompanyId: ids.originCompany,
    sourceBatchId: forwardTargetBatchId,
    quantityPieces: 10,
    notes: "Rientro fisico magazzino condiviso",
  }));
  assert.equal(reverse.directionLabel, "SoKeto → E-Keto");
  assert.equal(await stock(ids.soketoCompany, forwardTargetBatchId), 30);
  assert.equal(await stock(ids.originCompany, sourceBatch), 50);
  const db = await getDb();
  if (!db) throw new Error("DB non disponibile");
  const reportRows = await loadIntercompanyTransfers(db, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
  const manualRows = reportRows.filter((row) => [forward.transferReference, reverse.transferReference].includes(row.sourceDocument));
  assert.equal(manualRows.length, 2);
  assert.deepEqual(manualRows.map((row) => row.direction).sort(), ["E-Keto → SoKeto", "SoKeto → E-Keto"]);
  assert.equal(manualRows.reduce((total, row) => total + Number(row.totalCost), 0), 137.5);
  console.log("M1/M2/M3 PASS manual both directions + mirror cost + report one-row-per-transfer", JSON.stringify({ forward, reverse, reportRows: manualRows, raw: await rawEvidence(forward.transferReference, reverse.transferReference) }, null, 2));
}

async function testExistingMirrorCostPreserved() {
  await setup({ existingTarget: true });
  const result = await confirmManualIntercompanyTransfer(manualInput());
  assert.equal(result.targetBatchId, existingTargetBatch);
  const [mirror] = await sql`SELECT "costPrice" FROM "productBatches" WHERE id = ${existingTargetBatch}`;
  assert.equal(String(mirror.costPrice), "9.9900");
  console.log("M4 PASS manual existing target cost preserved", JSON.stringify({ result, mirror, raw: await rawEvidence(result.transferReference) }, null, 2));
}

async function testInsufficientIsAtomic() {
  await setup({ sourcePieces: 39 });
  const input = manualInput();
  await assert.rejects(() => confirmManualIntercompanyTransfer(input), /Giacenza E-Keto insufficiente/);
  assert.equal(await stock(ids.originCompany, sourceBatch), 39);
  const [movementCount] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${input.transferReference}`;
  assert.equal(Number(movementCount.count), 0);
  console.log("M5 PASS manual insufficient stock is atomic", JSON.stringify({ sourceStock: 39, movementCount: Number(movementCount.count) }, null, 2));
}

async function testIdempotentSameReference() {
  await setup();
  const input = manualInput();
  const [first, retry] = await Promise.all([confirmManualIntercompanyTransfer(input), confirmManualIntercompanyTransfer(input)]);
  assert.equal([first.alreadyTransferred, retry.alreadyTransferred].filter(Boolean).length, 1);
  assert.equal(await stock(ids.originCompany, sourceBatch), 40);
  const [movementCount] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${input.transferReference}`;
  assert.equal(Number(movementCount.count), 2);
  console.log("M6 PASS manual same reference is idempotent", JSON.stringify({ first, retry, raw: await rawEvidence(input.transferReference) }, null, 2));
}

async function main() {
  await testBidirectionalManualAndReport();
  await testExistingMirrorCostPreserved();
  await testInsufficientIsAtomic();
  await testIdempotentSameReference();
  console.log("MANUAL_INTERCOMPANY_TRANSFER_TESTS=PASS");
}

main().then(() => sql.end({ timeout: 5 })).catch(async (error) => { console.error(error); await sql.end({ timeout: 5 }); process.exitCode = 1; });
