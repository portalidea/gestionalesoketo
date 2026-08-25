import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;
const sql = postgres(databaseUrl, { prepare: false, max: 1 });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function resetM13() {
  await sql`DELETE FROM expiry_alert_items`;
  await sql`DELETE FROM expiry_alert_notifications`;
  await sql`DELETE FROM email_events`;
  await sql`DELETE FROM email_log`;
  await sql`DELETE FROM expiry_alert_runs`;
  await seedHotfixM13();
}

async function createTokenScenario(withPieceUnit = false) {
  await resetM13();
  if (withPieceUnit) {
    await sql`
      INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId")
      VALUES (${TEST_IDS.normalRetailerLocation}, ${TEST_IDS.batchExpired}, 3, ${TEST_IDS.originCompany})
    `;
  }
  const { runExpiryAlertForCompany } = await import("../server/services/expiryAlertService");
  const result = await runExpiryAlertForCompany({
    companyId: TEST_IDS.originCompany,
    mode: "alignment",
    trigger: "dry_run",
    dryRun: true,
    now: new Date(),
  });
  assert(result.runId, "Run alignment non creato");
  const [notification] = await sql`
    SELECT id, response_token FROM expiry_alert_notifications WHERE run_id = ${result.runId}::uuid AND retailer_id = ${TEST_IDS.normalRetailer}::uuid
  `;
  assert(notification, "Notifica token non creata");
  const items = await sql`
    SELECT id, batch_id, quantity_pieces, pieces_per_unit FROM expiry_alert_items WHERE notification_id = ${notification.id}::uuid ORDER BY pieces_per_unit DESC
  `;
  return { notification, items };
}

async function caller() {
  const { expiryAlertsRouter } = await import("../server/expiry-alert-router");
  return expiryAlertsRouter.createCaller({ req: { headers: {} } as any, res: {} as any, user: null });
}

async function inventoryRaw(batchId: string) {
  return sql`SELECT * FROM "inventoryByBatch" WHERE "locationId" = ${TEST_IDS.normalRetailerLocation}::uuid AND "batchId" = ${batchId}::uuid`;
}

async function movementsRaw(notificationId: string) {
  return sql`SELECT * FROM "stockMovements" WHERE "sourceDocument" = ${notificationId}::text ORDER BY timestamp, id`;
}

async function main() {
  const { renderM13PlainText } = await import("../server/services/m13EmailDelivery");
  const result: Record<string, unknown> = {};

  const rendered = renderM13PlainText({
    introText: "TESTO AMMINISTRATIVO FORNITO ESTERNAMENTE",
    items: [
      { productName: "Prodotto confezione", batchCode: "B6", quantityPieces: 50, piecesPerUnit: 6 },
      { productName: "Prodotto pezzo", batchCode: "B1", quantityPieces: 3, piecesPerUnit: 1 },
    ],
  });
  assert(rendered.includes("8 confezioni + 2 pz (50 pz)") && rendered.includes("3 pz"), "Rendering quantità non conforme");
  result.rendered_email_quantities = { status: "PASS", textBody: rendered };

  const soldOut = await createTokenScenario(false);
  const soldOutItem = soldOut.items.find((item) => item.batch_id === TEST_IDS.batchSoon)!;
  const soldOutBefore = await inventoryRaw(soldOutItem.batch_id);
  await (await caller()).submitResponse({ token: soldOut.notification.response_token, itemId: soldOutItem.id });
  const soldOutAfter = await inventoryRaw(soldOutItem.batch_id);
  const soldOutMovements = await movementsRaw(soldOut.notification.id);
  const [soldOutItemAfter] = await sql`SELECT * FROM expiry_alert_items WHERE id = ${soldOutItem.id}::uuid`;
  assert(soldOutAfter[0].quantity === 0, "sold_out non ha azzerato inventoryByBatch");
  assert(soldOutMovements.length === 1 && soldOutMovements[0].type === "ADJUSTMENT" && soldOutMovements[0].sourceDocumentType === "m13_retailer_declaration", "sold_out movimento M13 non conforme");
  assert(soldOutMovements[0].retailerId === TEST_IDS.normalRetailer && soldOutMovements[0].fromLocationId === null && soldOutMovements[0].toLocationId === null, "sold_out retailer/location non allineati alla convenzione ADJUSTMENT");
  assert(soldOutItemAfter.adjustment_applied === true, "sold_out adjustment_applied non true");
  result.sold_out = { status: "PASS", notificationId: soldOut.notification.id, before: soldOutBefore, after: soldOutAfter, movements: soldOutMovements, itemAfter: soldOutItemAfter };

  const doubleSubmit = await createTokenScenario(false);
  const doubleItem = doubleSubmit.items.find((item) => item.batch_id === TEST_IDS.batchSoon)!;
  const doubleBefore = await inventoryRaw(doubleItem.batch_id);
  await (await caller()).submitResponse({ token: doubleSubmit.notification.response_token, itemId: doubleItem.id });
  const duplicateResult = await (await caller()).submitResponse({ token: doubleSubmit.notification.response_token, itemId: doubleItem.id });
  const doubleAfter = await inventoryRaw(doubleItem.batch_id);
  const doubleMovements = await movementsRaw(doubleSubmit.notification.id);
  assert(doubleMovements.length === 1 && doubleAfter[0].quantity === 0 && duplicateResult.alreadyReported === true, "doppia segnalazione esaurito non idempotente");
  result.double_submit = { status: "PASS", notificationId: doubleSubmit.notification.id, before: doubleBefore, after: doubleAfter, movements: doubleMovements, duplicateResult };

  const expired = await createTokenScenario(false);
  const expiredItem = expired.items.find((item) => item.batch_id === TEST_IDS.batchSoon)!;
  await sql`UPDATE expiry_alert_notifications SET token_expires_at = now() - interval '1 minute' WHERE id = ${expired.notification.id}::uuid`;
  const expiredBefore = await inventoryRaw(expiredItem.batch_id);
  let expiredError = "";
  try {
    await (await caller()).submitResponse({ token: expired.notification.response_token, itemId: expiredItem.id });
  } catch (error) {
    expiredError = error instanceof Error ? error.message : String(error);
  }
  const expiredAfter = await inventoryRaw(expiredItem.batch_id);
  const expiredMovements = await movementsRaw(expired.notification.id);
  assert(expiredError.includes("Link scaduto") && expiredAfter[0].quantity === expiredBefore[0].quantity && expiredMovements.length === 0, "token scaduto non bloccato");
  result.expired_token = { status: "PASS", notificationId: expired.notification.id, before: expiredBefore, after: expiredAfter, movements: expiredMovements, expiredError };

  console.log(JSON.stringify(result, null, 2));
}

main().finally(() => sql.end({ timeout: 5 }));
