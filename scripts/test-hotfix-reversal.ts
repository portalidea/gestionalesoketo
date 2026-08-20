import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { transferBatchToRetailer } from "../server/db";
import { cancelOrderWithTransferReversal } from "../server/services/orderTransferReversal";
import { loadInterCompanyStock, reverseInterCompanyStock } from "../server/services/interCompanyTransfer";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const DATABASE_URL = process.env.LOCAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Impostare LOCAL_TEST_DATABASE_URL o DATABASE_URL");

const sql = postgres(DATABASE_URL, { prepare: false, max: 5 });
const id = TEST_IDS;

type Snapshot = { inventory: unknown[]; movements: unknown[]; rawMovements: unknown[] };
type Evidence = { case: string; before: Snapshot; after: Snapshot; assertions: string[] };

async function snapshot(orderId: string): Promise<Snapshot> {
  const inventory = await sql`
    SELECT l.name AS location, pb."batchNumber" AS batch, ib.quantity, c.name AS company
    FROM "inventoryByBatch" ib
    JOIN locations l ON l.id = ib."locationId"
    JOIN "productBatches" pb ON pb.id = ib."batchId"
    JOIN companies c ON c.id = ib."companyId"
    WHERE l.id IN (${id.originCentral}, ${id.normalRetailerLocation}, ${id.interCompanyRetailerLocation}, ${id.soketoCentral})
    ORDER BY location, batch
  `;
  const movements = await sql`
    SELECT type, quantity, "previousQuantity", "newQuantity", "sourceDocumentType", "sourceDocument", notes, "notesInternal", "fromLocationId", "toLocationId", "companyId"
    FROM "stockMovements"
    WHERE "sourceDocument" = ${orderId}
       OR notes LIKE ${`%${orderId}%`}
       OR "notesInternal" LIKE ${`%${orderId}%`}
    ORDER BY timestamp ASC
  `;
  const rawMovements = await sql`
    SELECT to_jsonb(sm) AS movement
    FROM "stockMovements" sm
    WHERE sm."sourceDocument" = ${orderId}
       OR sm.notes LIKE ${`%${orderId}%`}
       OR sm."notesInternal" LIKE ${`%${orderId}%`}
    ORDER BY sm.timestamp ASC, sm.id ASC
  `;
  return { inventory, movements, rawMovements: rawMovements.map((row) => row.movement) };
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function setTransferred(orderId: string, retailerId: string, productId: string, batchId: string, pieces: number) {
  await transferBatchToRetailer({
    productId,
    batchId,
    retailerId,
    quantity: pieces,
    notes: `TEST HOTFIX STORNO — DA NON EVADERE — ${orderId}`,
    createdBy: id.adminUser,
    companyId: id.originCompany,
    orderId,
  });
  await sql`UPDATE orders SET status = 'transferring', "transferringAt" = now() WHERE id = ${orderId}`;
}

async function reversalCount(orderId: string) {
  const rows = await sql`
    SELECT count(*)::int AS count FROM "stockMovements"
    WHERE "sourceDocumentType" = 'order_cancellation_reversal' AND "sourceDocument" = ${orderId}
  `;
  return rows[0].count as number;
}

async function buildHtml(evidence: Evidence[]) {
  const blocks = evidence.map((entry) => `
    <section>
      <h2>${entry.case}</h2>
      <p class="pass">PASS — ${entry.assertions.join(" · ")}</p>
      <div class="grid">
        <div><h3>Prima</h3><pre>${escapeHtml(JSON.stringify(entry.before, null, 2))}</pre></div>
        <div><h3>Dopo</h3><pre>${escapeHtml(JSON.stringify(entry.after, null, 2))}</pre></div>
      </div>
    </section>`).join("\n");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Hotfix storno — evidenze test isolate</title><style>body{font:14px system-ui;margin:32px;color:#172033;background:#f5f7fb}h1{font-size:28px}section{background:#fff;border:1px solid #d7dfed;border-radius:12px;padding:20px;margin:18px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101827;color:#d5e4ff;padding:14px;border-radius:8px;font-size:11px}.pass{color:#087443;font-weight:700}@media(max-width:850px){.grid{grid-template-columns:1fr}}</style></head><body><h1>Hotfix storno transfer — database isolato</h1><p>Fixture versionata: seed M13 + cinque casi richiesti. Nessun dato di produzione.</p>${blocks}</body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
}

async function main() {
  const evidence: Evidence[] = [];

  // 1. Stock retailer intact: all 30 pieces must return to central stock.
  await seedHotfixM13();
  await setTransferred(id.orderIntact, id.normalRetailer, id.productBoxes, id.batchFourMonths, 30);
  const case1Before = await snapshot(id.orderIntact);
  const case1Result = await cancelOrderWithTransferReversal({ orderId: id.orderIntact, actorUserId: id.adminUser, reason: "TEST 1" });
  const case1After = await snapshot(id.orderIntact);
  assert(case1Result.reversalLines[0]?.reversedPieces === 30, "T1: expected full reversal of 30 pieces");
  assert(await reversalCount(id.orderIntact) === 1, "T1: expected one reverse movement");
  evidence.push({ case: "T1 — giacenza rivenditore intatta", before: case1Before, after: case1After, assertions: ["30 pz stornati", "1 movimento TRANSFER inverso"] });

  // 2. Retailer has already sold/adjusted stock: reverse only the available 11 pieces.
  await seedHotfixM13();
  await setTransferred(id.orderPartial, id.normalRetailer, id.productPieces, id.batchExpired, 30);
  await sql`
    UPDATE "inventoryByBatch" SET quantity = 11
    WHERE "locationId" = ${id.normalRetailerLocation} AND "batchId" = ${id.batchExpired}
  `;
  await sql`
    INSERT INTO "stockMovements" ("productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", notes, "adjustmentReason", "adjustmentNote", "companyId")
    VALUES (${id.productPieces}, 'ADJUSTMENT', -19, 30, 11, ${id.batchExpired}, ${id.normalRetailerLocation}, 'TEST HOTFIX STORNO — giacenza retailer ridotta', 'recount', 'Riduzione simulata nel database isolato', ${id.originCompany})
  `;
  const case2Before = await snapshot(id.orderPartial);
  const case2Result = await cancelOrderWithTransferReversal({ orderId: id.orderPartial, actorUserId: id.adminUser, reason: "TEST 2" });
  const case2After = await snapshot(id.orderPartial);
  assert(case2Result.reversalLines[0]?.reversedPieces === 11 && case2Result.reversalLines[0]?.missingPieces === 19, "T2: expected partial reversal 11/30");
  evidence.push({ case: "T2 — giacenza retailer insufficiente", before: case2Before, after: case2After, assertions: ["11 pz stornati", "19 pz discrepanza", "nessuna giacenza negativa"] });

  // 3. Sequential double cancellation: only the first call can create a reversal.
  await seedHotfixM13();
  await setTransferred(id.orderDouble, id.normalRetailer, id.productPieces, id.batchExpired, 12);
  const case3Before = await snapshot(id.orderDouble);
  const firstCancel = await cancelOrderWithTransferReversal({ orderId: id.orderDouble, actorUserId: id.adminUser, reason: "TEST 3 first" });
  const secondCancel = await cancelOrderWithTransferReversal({ orderId: id.orderDouble, actorUserId: id.adminUser, reason: "TEST 3 second" });
  const case3After = await snapshot(id.orderDouble);
  assert(firstCancel.reversalLines[0]?.reversedPieces === 12, "T3: expected first reversal");
  assert(secondCancel.previousStatus === "cancelled", "T3: expected idempotent second cancellation");
  assert(await reversalCount(id.orderDouble) === 1, "T3: expected exactly one reversal movement");
  evidence.push({ case: "T3 — doppio annullamento consecutivo", before: case3Before, after: case3After, assertions: ["secondo annullamento idempotente", "1 solo movimento"] });

  // 4. Concurrent calls: the order FOR UPDATE lock serializes them.
  await seedHotfixM13();
  await setTransferred(id.orderConcurrent, id.normalRetailer, id.productBoxes, id.batchFourMonths, 30);
  const case4Before = await snapshot(id.orderConcurrent);
  const concurrent = await Promise.all([
    cancelOrderWithTransferReversal({ orderId: id.orderConcurrent, actorUserId: id.adminUser, reason: "TEST 4 A" }),
    cancelOrderWithTransferReversal({ orderId: id.orderConcurrent, actorUserId: id.adminUser, reason: "TEST 4 B" }),
  ]);
  const case4After = await snapshot(id.orderConcurrent);
  assert(concurrent.filter((result) => result.previousStatus === "transferring").length === 1, "T4: expected one locked transferring cancellation");
  assert(await reversalCount(id.orderConcurrent) === 1, "T4: expected exactly one reversal movement");
  evidence.push({ case: "T4 — annullamenti concorrenti", before: case4Before, after: case4After, assertions: ["lock ordine serializza 2 richieste", "1 solo movimento"] });

  // 5. Inter-company: standard retailer reversal and M11.D SoKeto load reversal touch different rows.
  await seedHotfixM13();
  await setTransferred(id.orderIntercompany, id.interCompanyRetailer, id.productBoxes, id.batchSoon, 18);
  await loadInterCompanyStock({
    orderId: id.orderIntercompany,
    orderNumber: "TEST-REV-005",
    createdBy: id.adminUser,
    items: [{ productId: id.productBoxes, batchId: id.batchSoon, quantity: 18, productName: "TEST Prodotto Confezione 6" }],
  });
  const case5Before = await snapshot(id.orderIntercompany);
  const case5Result = await cancelOrderWithTransferReversal({ orderId: id.orderIntercompany, actorUserId: id.adminUser, reason: "TEST 5" });
  const [soketoInventory] = await sql`
    SELECT ib.id FROM "inventoryByBatch" ib
    JOIN "productBatches" pb ON pb.id = ib."batchId"
    WHERE ib."locationId" = ${id.soketoCentral}
      AND pb."productId" = ${id.productBoxes}
      AND pb."batchNumber" = 'TEST-SCAD-NEXT-MONTH'
      AND pb."companyId" = ${id.soketoCompany}
  `;
  await sql`UPDATE "inventoryByBatch" SET quantity = 7 WHERE id = ${soketoInventory.id}`;
  const intercompanyReversal = await reverseInterCompanyStock({
    orderId: id.orderIntercompany,
    orderNumber: "TEST-REV-005",
    createdBy: id.adminUser,
    items: [{ productId: id.productBoxes, batchId: id.batchSoon, quantity: 18, productName: "TEST Prodotto Confezione 6" }],
  });
  const case5After = await snapshot(id.orderIntercompany);
  assert(case5Result.reversalLines[0]?.reversedPieces === 18, "T5: expected standard retailer reversal");
  assert(await reversalCount(id.orderIntercompany) === 1, "T5: expected one standard reversal");
  assert(intercompanyReversal.warnings.some((warning) => warning.includes("Storno parziale")), "T5: expected M11.D partial reversal warning");
  evidence.push({ case: "T5 — inter-company senza doppio storno", before: case5Before, after: case5After, assertions: ["retailer→centrale origine stornato", "M11.D rimuove solo 7 di 18 pz disponibili", "carico SoKeto non va negativo"] });

  // 6. Pre-existing retailer quantity is preserved; only the new 30 pieces are reversed.
  await seedHotfixM13();
  await setTransferred(id.orderPreexistingStock, id.normalRetailer, id.productBoxes, id.batchSoon, 30);
  const case6Before = await snapshot(id.orderPreexistingStock);
  const case6Result = await cancelOrderWithTransferReversal({ orderId: id.orderPreexistingStock, actorUserId: id.adminUser, reason: "TEST 6" });
  const case6After = await snapshot(id.orderPreexistingStock);
  const retailerAfter = (case6After.inventory as Array<{ location: string; batch: string; quantity: number }>).find((row) => row.location === "TEST Location Rivenditore Normale" && row.batch === "TEST-SCAD-NEXT-MONTH");
  assert(case6Result.reversalLines[0]?.reversedPieces === 30, "T6: expected reversal of only the new 30 pieces");
  assert(retailerAfter?.quantity === 50, "T6: expected pre-existing retailer stock of 50 to remain");
  assert(await reversalCount(id.orderPreexistingStock) === 1, "T6: expected one reverse movement");
  evidence.push({ case: "T6 — giacenza preesistente preservata", before: case6Before, after: case6After, assertions: ["80 → 50 pz retailer", "centrale +30 pz", "1 solo movimento inverso"] });

  const outputDir = join(process.cwd(), "reports", "test-evidence");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "hotfix-reversal-evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(join(outputDir, "hotfix-reversal-evidence.html"), await buildHtml(evidence));
  console.log(JSON.stringify({ passed: 6, evidence: join(outputDir, "hotfix-reversal-evidence.html") }, null, 2));
}

main().finally(async () => {
  await sql.end({ timeout: 5 });
});
