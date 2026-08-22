import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;
const sql = postgres(databaseUrl, { prepare: false, max: 1 });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const id = TEST_IDS;
const runNow = new Date("2030-08-15T12:00:00.000Z");
const periodStart = "2030-08-15";
const periodEnd = "2030-09-15";

const batchA = "eeeeeeee-eeee-eeee-eeee-eeeeeeee0001";
const batchB = "eeeeeeee-eeee-eeee-eeee-eeeeeeee0002";
const batchC = "eeeeeeee-eeee-eeee-eeee-eeeeeeee0003";
const batchD = "eeeeeeee-eeee-eeee-eeee-eeeeeeee0004";

async function resetScenario() {
  await sql`DELETE FROM expiry_alert_runs`;
  await seedHotfixM13();
  await sql`UPDATE expiry_alert_settings SET reorder_tolerance_days = 7, min_pieces_threshold = 1 WHERE company_id = ${id.originCompany}`;
}

async function insertBatch(input: { batchId: string; productId: string; code: string; expiry: string; quantity: number; deliveredAt?: string }) {
  await sql`
    INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId")
    VALUES (${input.batchId}, ${input.productId}, ${input.code}, ${input.expiry}::date, ${input.quantity}, '1.00', ${id.originCompany})
  `;
  await sql`
    INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId")
    VALUES (${id.normalRetailerLocation}, ${input.batchId}, ${input.quantity}, ${id.originCompany})
  `;
  if (input.deliveredAt) {
    await sql`
      INSERT INTO "stockMovements" ("productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", "toLocationId", notes, "companyId", timestamp)
      VALUES (${input.productId}, 'TRANSFER', ${input.quantity}, 0, ${input.quantity}, ${input.batchId}, ${id.originCentral}, ${id.normalRetailerLocation}, 'TEST riordino', ${id.originCompany}, ${input.deliveredAt}::timestamptz)
    `;
  }
}

async function runAlert() {
  const { runExpiryAlertForCompany } = await import("../server/services/expiryAlertService");
  return runExpiryAlertForCompany({ companyId: id.originCompany, mode: "alert", trigger: "dry_run", dryRun: true, now: runNow, periodStart, periodEnd });
}

async function itemsForRun(runId: string) {
  return sql`
    SELECT i.batch_code, i.product_name, i.quantity_pieces
    FROM expiry_alert_items i
    JOIN expiry_alert_notifications n ON n.id = i.notification_id
    WHERE n.run_id = ${runId}::uuid
    ORDER BY i.batch_code
  `;
}

async function suppressionsForRun(runId: string) {
  return sql`
    SELECT old_batch_code, new_batch_code, old_delivery_at, new_delivery_at, tolerance_days
    FROM expiry_alert_suppressions
    WHERE run_id = ${runId}::uuid
    ORDER BY old_batch_code
  `;
}

async function main() {
  const results: Record<string, unknown> = {};

  // Lotto A (marzo, scadenza settembre) è sostituito dal lotto B (giugno,
  // scadenza dicembre): nella finestra agosto A è soppresso.
  await resetScenario();
  await sql`UPDATE "productBatches" SET "expirationDate" = '2030-09-01'::date WHERE id = ${id.batchSoon}`;
  await sql`UPDATE "stockMovements" SET timestamp = '2030-03-01T09:00:00Z' WHERE "batchId" = ${id.batchSoon} AND type = 'TRANSFER'`;
  await insertBatch({ batchId: batchB, productId: id.productBoxes, code: "TEST-RIORDINO-B", expiry: "2030-12-01", quantity: 40, deliveredAt: "2030-06-01T09:00:00Z" });
  const beforeReorder = await sql`SELECT * FROM "inventoryByBatch" WHERE "locationId" = ${id.normalRetailerLocation} ORDER BY "batchId"`;
  const beforeReorderMovements = await sql`SELECT * FROM "stockMovements" WHERE "companyId" = ${id.originCompany} ORDER BY timestamp, id`;
  const reorderRun = await runAlert();
  const reorderItems = await itemsForRun(reorderRun.runId!);
  const reorderSuppressions = await suppressionsForRun(reorderRun.runId!);
  const afterReorder = await sql`SELECT * FROM "inventoryByBatch" WHERE "locationId" = ${id.normalRetailerLocation} ORDER BY "batchId"`;
  const afterReorderMovements = await sql`SELECT * FROM "stockMovements" WHERE "companyId" = ${id.originCompany} ORDER BY timestamp, id`;
  assert(!reorderItems.some((item) => item.batch_code === "TEST-SCAD-NEXT-MONTH"), "Lotto A riordinato non deve entrare nell'alert agosto");
  assert(reorderSuppressions.length === 1 && reorderSuppressions[0].old_batch_code === "TEST-SCAD-NEXT-MONTH" && reorderSuppressions[0].new_batch_code === "TEST-RIORDINO-B", "Soppressione A→B non registrata");
  assert(JSON.stringify(beforeReorder) === JSON.stringify(afterReorder), "La soppressione non deve modificare inventoryByBatch");
  assert(JSON.stringify(beforeReorderMovements) === JSON.stringify(afterReorderMovements), "La soppressione non deve creare o modificare stockMovements");
  results.reordered_batch_suppressed = { status: "PASS", run: reorderRun, before: beforeReorder, after: afterReorder, movementsBefore: beforeReorderMovements, movementsAfter: afterReorderMovements, items: reorderItems, suppressions: reorderSuppressions };

  // Un indirizzo PEC ha precedenza: il lotto non viene nascosto nelle sole
  // soppressioni, ma genera una notifica skipped visibile all'amministrazione.
  await resetScenario();
  await sql`UPDATE retailers SET email = 'test@pec.example.it' WHERE id = ${id.normalRetailer}`;
  await sql`UPDATE "productBatches" SET "expirationDate" = '2030-09-01'::date WHERE id = ${id.batchSoon}`;
  await sql`UPDATE "stockMovements" SET timestamp = '2030-03-01T09:00:00Z' WHERE "batchId" = ${id.batchSoon} AND type = 'TRANSFER'`;
  await insertBatch({ batchId: batchB, productId: id.productBoxes, code: "TEST-PEC-RIORDINO-B", expiry: "2030-12-01", quantity: 40, deliveredAt: "2030-06-01T09:00:00Z" });
  const pecRun = await runAlert();
  const pecItems = await itemsForRun(pecRun.runId!);
  const pecSuppressions = await suppressionsForRun(pecRun.runId!);
  const [pecNotification] = await sql`SELECT status, skip_reason FROM expiry_alert_notifications WHERE run_id = ${pecRun.runId}::uuid`;
  assert(pecNotification.status === "skipped" && pecNotification.skip_reason === "pec_address", "PEC deve avere precedenza sul filtro riordino");
  assert(pecItems.some((item) => item.batch_code === "TEST-SCAD-NEXT-MONTH"), "Lotto PEC non deve sparire dalla reportistica del run");
  assert(pecSuppressions.length === 0 && pecRun.itemsSuppressedByReorder === 0, "Lotto PEC non deve essere salvato come sola soppressione riordino");
  results.pec_precedes_reorder_suppression = { status: "PASS", run: pecRun, notification: pecNotification, items: pecItems, suppressions: pecSuppressions };

  // Unico lotto in finestra, mai riordinato: rimane nell'alert.
  await resetScenario();
  await sql`UPDATE "productBatches" SET "expirationDate" = '2030-09-01'::date WHERE id = ${id.batchSoon}`;
  await sql`DELETE FROM "stockMovements" WHERE "batchId" = ${id.batchSoon}`;
  const singleRun = await runAlert();
  const singleItems = await itemsForRun(singleRun.runId!);
  const singleSuppressions = await suppressionsForRun(singleRun.runId!);
  assert(singleItems.some((item) => item.batch_code === "TEST-SCAD-NEXT-MONTH"), "Lotto singolo mai riordinato deve entrare nell'alert");
  assert(singleSuppressions.length === 0, "Lotto singolo non deve essere soppresso");
  results.single_batch_retained = { status: "PASS", run: singleRun, items: singleItems, suppressions: singleSuppressions };

  // Consegne a 3 giorni: rientrano nella tolleranza 7 giorni e restano entrambe correnti.
  await resetScenario();
  await sql`DELETE FROM "inventoryByBatch" WHERE "locationId" = ${id.normalRetailerLocation} AND "batchId" = ${id.batchSoon}`;
  await sql`DELETE FROM "stockMovements" WHERE "batchId" = ${id.batchSoon}`;
  await insertBatch({ batchId: batchC, productId: id.productBoxes, code: "TEST-TOLLERANZA-C", expiry: "2030-09-02", quantity: 20, deliveredAt: "2030-06-01T09:00:00Z" });
  await insertBatch({ batchId: batchD, productId: id.productBoxes, code: "TEST-TOLLERANZA-D", expiry: "2030-09-03", quantity: 20, deliveredAt: "2030-06-04T09:00:00Z" });
  const toleranceRun = await runAlert();
  const toleranceItems = await itemsForRun(toleranceRun.runId!);
  const toleranceSuppressions = await suppressionsForRun(toleranceRun.runId!);
  assert(toleranceItems.filter((item) => item.product_name === "TEST Prodotto Confezione 6").length === 2, "Lotti consegnati entro 3 giorni devono restare entrambi correnti");
  assert(toleranceSuppressions.length === 0, "Tolleranza 7 giorni non deve sopprimere i lotti a distanza 3 giorni");
  results.within_tolerance_retained = { status: "PASS", run: toleranceRun, items: toleranceItems, suppressions: toleranceSuppressions };

  // Riordino del prodotto confezione non influenza un prodotto diverso.
  await resetScenario();
  await sql`UPDATE "productBatches" SET "expirationDate" = '2030-09-01'::date WHERE id = ${id.batchSoon}`;
  await sql`UPDATE "stockMovements" SET timestamp = '2030-03-01T09:00:00Z' WHERE "batchId" = ${id.batchSoon} AND type = 'TRANSFER'`;
  await insertBatch({ batchId: batchB, productId: id.productBoxes, code: "TEST-ALTRO-PRODOTTO-B", expiry: "2030-12-01", quantity: 40, deliveredAt: "2030-06-01T09:00:00Z" });
  await sql`UPDATE "productBatches" SET "expirationDate" = '2030-09-05'::date WHERE id = ${id.batchExpired}`;
  await sql`INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES (${id.normalRetailerLocation}, ${id.batchExpired}, 3, ${id.originCompany})`;
  const differentProductRun = await runAlert();
  const differentProductItems = await itemsForRun(differentProductRun.runId!);
  const differentProductSuppressions = await suppressionsForRun(differentProductRun.runId!);
  assert(!differentProductItems.some((item) => item.batch_code === "TEST-SCAD-NEXT-MONTH"), "Prodotto confezione riordinato deve essere soppresso");
  assert(differentProductItems.some((item) => item.batch_code === "TEST-SCAD-EXPIRED"), "Prodotto diverso non deve essere influenzato dal riordino altrui");
  assert(differentProductSuppressions.length === 1, "Solo il lotto del prodotto riordinato deve risultare soppresso");
  results.products_independent = { status: "PASS", run: differentProductRun, items: differentProductItems, suppressions: differentProductSuppressions };

  const [{ count: emailLogs }] = await sql`SELECT COUNT(*)::int AS count FROM email_log`;
  const [{ count: m13Movements }] = await sql`SELECT COUNT(*)::int AS count FROM "stockMovements" WHERE "sourceDocumentType" = 'm13_retailer_declaration'`;
  assert(emailLogs === 0 && m13Movements === 0, "Test riordini non deve creare email_log o movimenti M13");
  results.invariants = { status: "PASS", emailLogs, m13Movements };

  console.log(JSON.stringify(results, null, 2));
}

main().finally(() => sql.end({ timeout: 5 }));
