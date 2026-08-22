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
  await (await caller()).submitResponse({ token: soldOut.notification.response_token, items: [{ itemId: soldOutItem.id, declaredPackages: 0 }] });
  const soldOutAfter = await inventoryRaw(soldOutItem.batch_id);
  const soldOutMovements = await movementsRaw(soldOut.notification.id);
  const [soldOutItemAfter] = await sql`SELECT * FROM expiry_alert_items WHERE id = ${soldOutItem.id}::uuid`;
  assert(soldOutAfter[0].quantity === 0, "sold_out non ha azzerato inventoryByBatch");
  assert(soldOutMovements.length === 1 && soldOutMovements[0].type === "ADJUSTMENT" && soldOutMovements[0].sourceDocumentType === "m13_retailer_declaration", "sold_out movimento M13 non conforme");
  assert(soldOutMovements[0].retailerId === TEST_IDS.normalRetailer && soldOutMovements[0].fromLocationId === null && soldOutMovements[0].toLocationId === null, "sold_out retailer/location non allineati alla convenzione ADJUSTMENT");
  assert(soldOutItemAfter.adjustment_applied === true, "sold_out adjustment_applied non true");
  result.sold_out = { status: "PASS", notificationId: soldOut.notification.id, before: soldOutBefore, after: soldOutAfter, movements: soldOutMovements, itemAfter: soldOutItemAfter };

  const hasStockSix = await createTokenScenario(false);
  const sixItem = hasStockSix.items.find((item) => item.batch_id === TEST_IDS.batchSoon)!;
  const hasStockSixBefore = await inventoryRaw(sixItem.batch_id);
  await (await caller()).submitResponse({ token: hasStockSix.notification.response_token, items: [{ itemId: sixItem.id, declaredPackages: 7 }] });
  const hasStockSixAfter = await inventoryRaw(sixItem.batch_id);
  const hasStockSixMovements = await movementsRaw(hasStockSix.notification.id);
  const [hasStockSixItemAfter] = await sql`SELECT * FROM expiry_alert_items WHERE id = ${sixItem.id}::uuid`;
  assert(hasStockSixBefore[0].quantity === 50 && hasStockSixAfter[0].quantity === 42, "has_stock PPU6 non ha convertito 7 confezioni in 42 pezzi");
  assert(hasStockSixMovements[0].quantity === 8 && hasStockSixMovements[0].previousQuantity === 50 && hasStockSixMovements[0].newQuantity === 42 && hasStockSixItemAfter.declared_quantity === 42, "has_stock PPU6 quantity assoluta o direzione stock errate");
  result.has_stock_pieces_per_unit_6 = { status: "PASS", notificationId: hasStockSix.notification.id, before: hasStockSixBefore, after: hasStockSixAfter, movements: hasStockSixMovements, itemAfter: hasStockSixItemAfter };

  const exceedsSnapshot = await createTokenScenario(true);
  const pieceItem = exceedsSnapshot.items.find((item) => item.batch_id === TEST_IDS.batchExpired)!;
  const exceedsBefore = await inventoryRaw(pieceItem.batch_id);
  await (await caller()).submitResponse({ token: exceedsSnapshot.notification.response_token, items: [{ itemId: pieceItem.id, declaredPackages: 7 }] });
  const exceedsAfter = await inventoryRaw(pieceItem.batch_id);
  const exceedsMovements = await movementsRaw(exceedsSnapshot.notification.id);
  const [exceedsItemAfter] = await sql`SELECT * FROM expiry_alert_items WHERE id = ${pieceItem.id}::uuid`;
  const [exceedsNotificationAfter] = await sql`SELECT * FROM expiry_alert_notifications WHERE id = ${exceedsSnapshot.notification.id}::uuid`;
  assert(exceedsBefore[0].quantity === 3 && exceedsAfter[0].quantity === 3, "dichiarazione superiore ha modificato inventoryByBatch");
  assert(exceedsMovements.length === 0 && exceedsItemAfter.declared_quantity === 7 && exceedsItemAfter.adjustment_applied === false, "dichiarazione superiore ha creato una rettifica o non ha salvato il dichiarato");
  assert(exceedsItemAfter.declaration_anomaly === true, "flag declaration_anomaly per-item mancante");
  assert(exceedsNotificationAfter.response_type === "has_stock", "response_type di dominio sovrascritto dall'anomalia");
  result.declaration_exceeds_snapshot = { status: "PASS", notificationId: exceedsSnapshot.notification.id, before: exceedsBefore, after: exceedsAfter, movements: exceedsMovements, itemAfter: exceedsItemAfter, notificationAfter: exceedsNotificationAfter };

  const mixedResponse = await createTokenScenario(true);
  const normalMixedItem = mixedResponse.items.find((item) => item.batch_id === TEST_IDS.batchSoon)!;
  const anomalyMixedItem = mixedResponse.items.find((item) => item.batch_id === TEST_IDS.batchExpired)!;
  const normalMixedBefore = await inventoryRaw(normalMixedItem.batch_id);
  const anomalyMixedBefore = await inventoryRaw(anomalyMixedItem.batch_id);
  await (await caller()).submitResponse({
    token: mixedResponse.notification.response_token,
    items: [
      { itemId: normalMixedItem.id, declaredPackages: 0 },
      { itemId: anomalyMixedItem.id, declaredPackages: 7 },
    ],
  });
  const normalMixedAfter = await inventoryRaw(normalMixedItem.batch_id);
  const anomalyMixedAfter = await inventoryRaw(anomalyMixedItem.batch_id);
  const mixedMovements = await movementsRaw(mixedResponse.notification.id);
  const [normalMixedAfterItem] = await sql`SELECT * FROM expiry_alert_items WHERE id = ${normalMixedItem.id}::uuid`;
  const [anomalyMixedAfterItem] = await sql`SELECT * FROM expiry_alert_items WHERE id = ${anomalyMixedItem.id}::uuid`;
  assert(normalMixedBefore[0].quantity === 50 && normalMixedAfter[0].quantity === 0 && normalMixedAfterItem.adjustment_applied === true && normalMixedAfterItem.declaration_anomaly === false, "item normale non rettificato nella risposta mista");
  assert(anomalyMixedBefore[0].quantity === 3 && anomalyMixedAfter[0].quantity === 3 && anomalyMixedAfterItem.adjustment_applied === false && anomalyMixedAfterItem.declaration_anomaly === true, "item anomalo ha rettificato stock nella risposta mista");
  assert(mixedMovements.length === 1 && mixedMovements[0].retailerId === TEST_IDS.normalRetailer && mixedMovements[0].fromLocationId === null && mixedMovements[0].toLocationId === null, "movimento risposta mista non conforme");
  result.mixed_normal_and_anomaly_items = { status: "PASS", notificationId: mixedResponse.notification.id, normalBefore: normalMixedBefore, normalAfter: normalMixedAfter, anomalyBefore: anomalyMixedBefore, anomalyAfter: anomalyMixedAfter, movements: mixedMovements, normalItemAfter: normalMixedAfterItem, anomalyItemAfter: anomalyMixedAfterItem };

  const doubleSubmit = await createTokenScenario(false);
  const doubleItem = doubleSubmit.items.find((item) => item.batch_id === TEST_IDS.batchSoon)!;
  const doubleBefore = await inventoryRaw(doubleItem.batch_id);
  await (await caller()).submitResponse({ token: doubleSubmit.notification.response_token, items: [{ itemId: doubleItem.id, declaredPackages: 0 }] });
  let duplicateError = "";
  try {
    await (await caller()).submitResponse({ token: doubleSubmit.notification.response_token, items: [{ itemId: doubleItem.id, declaredPackages: 0 }] });
  } catch (error) {
    duplicateError = error instanceof Error ? error.message : String(error);
  }
  const doubleAfter = await inventoryRaw(doubleItem.batch_id);
  const doubleMovements = await movementsRaw(doubleSubmit.notification.id);
  assert(doubleMovements.length === 1 && doubleAfter[0].quantity === 0 && duplicateError.includes("Risposta già registrata"), "doppia submit non idempotente");
  result.double_submit = { status: "PASS", notificationId: doubleSubmit.notification.id, before: doubleBefore, after: doubleAfter, movements: doubleMovements, duplicateError };

  const expired = await createTokenScenario(false);
  const expiredItem = expired.items.find((item) => item.batch_id === TEST_IDS.batchSoon)!;
  await sql`UPDATE expiry_alert_notifications SET token_expires_at = now() - interval '1 minute' WHERE id = ${expired.notification.id}::uuid`;
  const expiredBefore = await inventoryRaw(expiredItem.batch_id);
  let expiredError = "";
  try {
    await (await caller()).submitResponse({ token: expired.notification.response_token, items: [{ itemId: expiredItem.id, declaredPackages: 0 }] });
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
