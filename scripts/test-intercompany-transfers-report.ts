import assert from "node:assert/strict";
import postgres from "postgres";
import { confirmIntercompanyTransferAndAssign } from "../server/services/intercompanyOrderTransfer";
import { loadIntercompanyTransfers } from "../server/reports-router";
import { getDb } from "../server/db";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("LOCAL_TEST_DATABASE_URL obbligatorio");
const ids = TEST_IDS;
const sourceBatch = "77777777-7777-7777-7777-777777777791";
const sql = postgres(databaseUrl, { prepare: false, max: 4 });

async function setupBothDirections() {
  await seedHotfixM13();
  await sql`DELETE FROM "inventoryByBatch" WHERE "locationId" = ${ids.originCentral} AND "batchId" IN (${ids.batchSoon}, ${ids.batchFourMonths})`;
  await sql`UPDATE "orderItems" SET "batchId" = NULL, quantity = 5 WHERE "orderId" = ${ids.orderIntact}`;
  await sql`UPDATE orders SET "companyId" = ${ids.soketoCompany}, "orderNumber" = 'TEST-SOK-REPORT-001' WHERE id = ${ids.orderPartial}`;
  await sql`UPDATE "orderItems" SET "productId" = ${ids.productBoxes}, "batchId" = NULL, quantity = 5, "productSku" = 'TEST-BOX-6', "productName" = 'TEST Prodotto Confezione 6' WHERE "orderId" = ${ids.orderPartial}`;
  await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${sourceBatch}, ${ids.productBoxes}, 'IC-REPORT-LOT', '2026-12-31', 60, '3.2500', ${ids.soketoCompany})`;
  await sql`INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES (${ids.soketoCentral}, ${sourceBatch}, 60, ${ids.soketoCompany})`;
  const [forwardItem] = await sql`SELECT id FROM "orderItems" WHERE "orderId" = ${ids.orderIntact}`;
  const [reverseItem] = await sql`SELECT id FROM "orderItems" WHERE "orderId" = ${ids.orderPartial}`;
  return { forwardItemId: forwardItem.id as string, reverseItemId: reverseItem.id as string };
}

async function main() {
  const { forwardItemId, reverseItemId } = await setupBothDirections();
  const forward = await confirmIntercompanyTransferAndAssign({ orderItemId: forwardItemId, sourceBatchId: sourceBatch, actorUserId: ids.adminUser, activeCompanyId: ids.originCompany });
  const reverse = await confirmIntercompanyTransferAndAssign({ orderItemId: reverseItemId, sourceBatchId: forward.batchId, actorUserId: ids.adminUser, activeCompanyId: ids.soketoCompany });
  assert.equal(forward.directionLabel, "SoKeto → E-Keto");
  assert.equal(reverse.directionLabel, "E-Keto → SoKeto");

  const db = await getDb();
  if (!db) throw new Error("DB non disponibile");
  const rows = await loadIntercompanyTransfers(db, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.direction).sort(), ["E-Keto → SoKeto", "SoKeto → E-Keto"]);
  assert.deepEqual(rows.map((row) => row.orderId).sort(), [ids.orderIntact, ids.orderPartial].sort());
  const totalCost = rows.reduce((sum, row) => sum + Number(row.totalCost), 0);
  assert.equal(totalCost, 195);
  const [{ ledgerRows }] = await sql`SELECT COUNT(*)::int AS "ledgerRows" FROM "stockMovements" WHERE "sourceDocumentType" = 'intercompany_transfer' AND "sourceDocument" IN (${ids.orderIntact}, ${ids.orderPartial})`;
  assert.equal(Number(ledgerRows), 4);
  console.log("INTERCOMPANY_REPORT_BIDIRECTIONAL_TEST=PASS", JSON.stringify({ forward, reverse, reportRows: rows, reportTotalCost: totalCost, ledgerRows: Number(ledgerRows), expectedReportRows: 2, expectedLedgerRows: 4 }, null, 2));
}

main().then(() => sql.end({ timeout: 5 })).catch(async (error) => { console.error(error); await sql.end({ timeout: 5 }); process.exitCode = 1; });
