import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";
import { getDb } from "../server/db";
import { runExpiryAlertForCompany } from "../server/services/expiryAlertService";
import { buildM13IdempotencyKey, prepareM13NotificationDelivery } from "../server/services/emailLogService";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL o DATABASE_URL");
const localDatabaseUrl = databaseUrl;
process.env.DATABASE_URL = localDatabaseUrl;

const OTHER_RETAILER = "33333333-3333-3333-3333-333333333334";
const OTHER_LOCATION = "66666666-6666-6666-6666-666666666667";
const NOW = new Date("2026-09-01T10:00:00.000Z");
const RUN_DATE = "2026-09-01";

async function reserveNotification(notification: { id: string; retailerId: string; recipientEmail: string; retailerName: string }, key: string) {
  const db = await getDb();
  if (!db) throw new Error("Database Drizzle non disponibile");
  return prepareM13NotificationDelivery(db, {
    notificationId: notification.id,
    idempotencyKey: key,
    recipientEmail: notification.recipientEmail,
    recipientName: notification.retailerName,
    subject: "TEST M13 — nessun invio reale",
    textBody: "Fixture locale: nessuna email reale è stata inviata.",
    metadata: { test: "m13-idempotency" },
  });
}

async function main() {
  const cleanup = postgres(localDatabaseUrl, { prepare: false, max: 1 });
  try {
    await cleanup`DELETE FROM email_events`;
    await cleanup`DELETE FROM expiry_alert_items`;
    await cleanup`DELETE FROM expiry_alert_notifications`;
    await cleanup`DELETE FROM email_log`;
    await cleanup`DELETE FROM expiry_alert_runs`;
    await cleanup`DELETE FROM locations WHERE id = ${OTHER_LOCATION}`;
    await cleanup`DELETE FROM retailers WHERE id = ${OTHER_RETAILER}`;
  } finally {
    await cleanup.end({ timeout: 5 });
  }
  await seedHotfixM13();
  const sql = postgres(localDatabaseUrl, { prepare: false, max: 1 });
  try {
    await sql`
      INSERT INTO expiry_alert_settings (company_id, min_pieces_threshold, reorder_tolerance_days)
      VALUES (${TEST_IDS.originCompany}, 5, 7)
      ON CONFLICT (company_id) DO UPDATE
      SET min_pieces_threshold = EXCLUDED.min_pieces_threshold,
          reorder_tolerance_days = EXCLUDED.reorder_tolerance_days
    `;
    await sql`
      INSERT INTO retailers (id, name, email, "companyId", tier_engine_enabled)
      VALUES (${OTHER_RETAILER}, 'TEST Secondo Rivenditore', 'second@test.invalid', ${TEST_IDS.originCompany}, false)
    `;
    await sql`
      INSERT INTO locations (id, type, name, "retailerId", "companyId")
      VALUES (${OTHER_LOCATION}, 'retailer', 'TEST Location Secondo Rivenditore', ${OTHER_RETAILER}, ${TEST_IDS.originCompany})
    `;
    await sql`
      INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId")
      VALUES (${OTHER_LOCATION}, ${TEST_IDS.batchFourMonths}, 12, ${TEST_IDS.originCompany})
    `;

    const firstRun = await runExpiryAlertForCompany({
      companyId: TEST_IDS.originCompany,
      mode: "alignment",
      trigger: "cron",
      dryRun: true,
      now: NOW,
    });
    if (!firstRun.runId) throw new Error("Primo run non creato");
    const firstNotifications = await sql<{ id: string; retailerId: string; recipientEmail: string; retailerName: string }[]>`
      SELECT id, retailer_id AS "retailerId", recipient_email AS "recipientEmail", retailer_name AS "retailerName"
      FROM expiry_alert_notifications WHERE run_id = ${firstRun.runId} ORDER BY retailer_id
    `;
    const firstServed = firstNotifications.find((row) => row.retailerId === TEST_IDS.normalRetailer)!;
    const firstOther = firstNotifications.find((row) => row.retailerId === OTHER_RETAILER)!;
    const firstKey = buildM13IdempotencyKey({ mode: "alignment", companyId: TEST_IDS.originCompany, runDate: RUN_DATE, retailerId: firstServed.retailerId });
    const firstReservation = await reserveNotification(firstServed, firstKey);
    if (!firstReservation.reserved) throw new Error("La prima reservation deve riuscire");

    // Simula crash dopo una consegna: il run resta running oltre due ore.
    await sql`
      UPDATE expiry_alert_runs SET status = 'running', created_at = ${new Date(NOW.getTime() - 3 * 60 * 60 * 1000)}
      WHERE id = ${firstRun.runId}
    `;

    const recoveredRun = await runExpiryAlertForCompany({
      companyId: TEST_IDS.originCompany,
      mode: "alignment",
      trigger: "cron",
      dryRun: true,
      now: NOW,
    });
    if (!recoveredRun.runId || recoveredRun.recoveredRunIds[0] !== firstRun.runId) throw new Error("Recovery cron non avvenuto");
    const recoveredNotifications = await sql<{ id: string; retailerId: string; recipientEmail: string; retailerName: string; status: string; skipReason: string | null }[]>`
      SELECT id, retailer_id AS "retailerId", recipient_email AS "recipientEmail", retailer_name AS "retailerName", status, skip_reason AS "skipReason"
      FROM expiry_alert_notifications WHERE run_id = ${recoveredRun.runId} ORDER BY retailer_id
    `;
    const recoveredServed = recoveredNotifications.find((row) => row.retailerId === TEST_IDS.normalRetailer)!;
    const recoveredOther = recoveredNotifications.find((row) => row.retailerId === OTHER_RETAILER)!;
    const duplicated = await reserveNotification(recoveredServed, firstKey);
    const otherKey = buildM13IdempotencyKey({ mode: "alignment", companyId: TEST_IDS.originCompany, runDate: RUN_DATE, retailerId: recoveredOther.retailerId });
    const newRecipient = await reserveNotification(recoveredOther, otherKey);
    if (duplicated.reserved || !newRecipient.reserved) throw new Error("Il run recuperato non ha distinto duplicato e destinatario nuovo");

    // Un run manuale nella stessa finestra non può aggirare la chiave per retailer.
    const manualRun = await runExpiryAlertForCompany({
      companyId: TEST_IDS.originCompany,
      mode: "alignment",
      trigger: "manual",
      dryRun: true,
      now: NOW,
    });
    if (!manualRun.runId) throw new Error("Run manuale non creato");
    const [manualServed] = await sql<{ id: string; retailerId: string; recipientEmail: string; retailerName: string; status: string; skipReason: string | null }[]>`
      SELECT id, retailer_id AS "retailerId", recipient_email AS "recipientEmail", retailer_name AS "retailerName", status, skip_reason AS "skipReason"
      FROM expiry_alert_notifications WHERE run_id = ${manualRun.runId} AND retailer_id = ${TEST_IDS.normalRetailer}
    `;
    const manualDuplicate = await reserveNotification(manualServed, firstKey);
    if (manualDuplicate.reserved) throw new Error("Il run manuale ha aggirato l'idempotenza della finestra");

    const raw = await sql`
      SELECT n.run_id, n.retailer_id, n.status, n.skip_reason, n.email_log_id, e.idempotency_key, e.status AS email_status
      FROM expiry_alert_notifications n
      LEFT JOIN email_log e ON e.id = n.email_log_id
      WHERE n.run_id IN (${firstRun.runId}, ${recoveredRun.runId}, ${manualRun.runId})
      ORDER BY n.run_id, n.retailer_id
    `;
    const evidence = { firstRun, recoveredRun, manualRun, firstReservation, duplicated, newRecipient, manualDuplicate, firstOther, raw };
    await mkdir(resolve("reports/test-evidence"), { recursive: true });
    await writeFile(resolve("reports/test-evidence/m13-idempotency-evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
