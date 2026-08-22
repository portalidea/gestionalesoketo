import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const { runExpiryAlertForCompany } = await import("../server/services/expiryAlertService");
  const { buildM13IdempotencyKey, prepareM13NotificationDelivery, markM13EmailProviderAccepted } = await import("../server/services/emailLogService");
  const { getDb } = await import("../server/db");
  const database = await getDb();
  if (!database) throw new Error("Drizzle locale non disponibile");

  await sql`DELETE FROM expiry_alert_items`;
  await sql`DELETE FROM expiry_alert_notifications`;
  await sql`DELETE FROM email_events`;
  await sql`DELETE FROM email_log`;
  await sql`DELETE FROM expiry_alert_runs`;
  await seedHotfixM13();

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const inThirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const results: Array<{ id: string; result: string; raw: unknown }> = [];

  const t1 = await runExpiryAlertForCompany({ companyId: TEST_IDS.originCompany, mode: "alignment", trigger: "dry_run", dryRun: true, now });
  assert(t1.retailersEvaluated === 1 && t1.itemsFlagged === 1, "T1 alignment deve includere un retailer e un lotto");
  const [t1Item] = await sql`SELECT quantity_pieces, pieces_per_unit, delivery_status FROM expiry_alert_items LIMIT 1`;
  assert(t1Item.quantity_pieces === 50 && t1Item.pieces_per_unit === 6, "T1 snapshot confezioni/pezzi errato");
  results.push({ id: "T1", result: "PASS", raw: { t1, t1Item } });

  const t2 = await runExpiryAlertForCompany({ companyId: TEST_IDS.originCompany, mode: "alert", trigger: "dry_run", dryRun: true, now, periodStart: today, periodEnd: inThirtyDays });
  assert(t2.itemsFlagged === 1 && t2.retailersEvaluated === 1, "T2 alert deve filtrare la finestra scadenze");
  results.push({ id: "T2", result: "PASS", raw: t2 });

  await sql`UPDATE expiry_alert_settings SET min_pieces_threshold = 51 WHERE company_id = ${TEST_IDS.originCompany}`;
  const t3 = await runExpiryAlertForCompany({ companyId: TEST_IDS.originCompany, mode: "alignment", trigger: "dry_run", dryRun: true, now });
  assert(t3.notificationsSkippedBelowThreshold === 1, "T3 soglia deve produrre skipped");
  await sql`UPDATE expiry_alert_settings SET min_pieces_threshold = 5 WHERE company_id = ${TEST_IDS.originCompany}`;
  results.push({ id: "T3", result: "PASS", raw: t3 });

  const t4 = await runExpiryAlertForCompany({ companyId: TEST_IDS.soketoCompany, mode: "alignment", trigger: "dry_run", dryRun: true, now });
  assert(t4.retailersEvaluated === 0 && t4.itemsFlagged === 0, "T4 company scope deve escludere fixture E-Keto");
  results.push({ id: "T4", result: "PASS", raw: t4 });

  await sql`UPDATE retailers SET "expiryAlertOptOut" = true WHERE id = ${TEST_IDS.normalRetailer}`;
  const t5 = await runExpiryAlertForCompany({ companyId: TEST_IDS.originCompany, mode: "alignment", trigger: "dry_run", dryRun: true, now });
  assert(t5.retailersEvaluated === 0, "T5 opt-out deve escludere il retailer");
  await sql`UPDATE retailers SET "expiryAlertOptOut" = false WHERE id = ${TEST_IDS.normalRetailer}`;
  results.push({ id: "T5", result: "PASS", raw: t5 });

  await sql`
    INSERT INTO expiry_alert_runs (company_id, mode, run_date, period_start, period_end, trigger, status, created_at)
    VALUES (${TEST_IDS.originCompany}, 'alert', ${today}::date, ${today}::date, ${inThirtyDays}::date, 'cron', 'running', now() - interval '3 hours')
  `;
  const t6 = await runExpiryAlertForCompany({ companyId: TEST_IDS.originCompany, mode: "alert", trigger: "cron", dryRun: true, now, periodStart: today, periodEnd: inThirtyDays });
  assert(t6.recoveredRunIds.length === 1, "T6 deve recuperare il run cron stale");
  results.push({ id: "T6", result: "PASS", raw: t6 });

  const [{ count: emailCount }] = await sql`SELECT COUNT(*)::int AS count FROM email_log`;
  assert(emailCount === 0, "T7 dry-run non deve creare email_log");
  results.push({ id: "T7", result: "PASS", raw: { emailCount } });

  const [{ id: notificationId, recipient_email: recipientEmail, retailer_name: retailerName }] = await sql`
    SELECT id, recipient_email, retailer_name FROM expiry_alert_notifications
    WHERE status = 'pending' ORDER BY created_at LIMIT 1
  `;
  const idempotencyKey = buildM13IdempotencyKey({ mode: "alignment", companyId: TEST_IDS.originCompany, runDate: today, retailerId: TEST_IDS.normalRetailer });
  const reservationInput = { idempotencyKey, notificationId, recipientEmail, recipientName: retailerName, subject: "T8", textBody: "Test isolato", metadata: { test: "T8" } };
  const firstReservation = await prepareM13NotificationDelivery(database, reservationInput);
  const duplicateReservation = await prepareM13NotificationDelivery(database, reservationInput);
  assert(firstReservation.reserved && !duplicateReservation.reserved, "T8 unique email_log deve bloccare il duplicato");
  const [t8Notification] = await sql`SELECT status, skip_reason FROM expiry_alert_notifications WHERE id = ${notificationId}`;
  assert(t8Notification.status === "skipped" && t8Notification.skip_reason === "already_sent_in_window", "T8 deve marcare skipped");
  results.push({ id: "T8", result: "PASS", raw: { firstReservation, duplicateReservation, t8Notification, idempotencyKey } });

  const [{ email_log_id: emailLogId }] = await sql`SELECT email_log_id FROM expiry_alert_notifications WHERE id = ${notificationId}`;
  await markM13EmailProviderAccepted(database, emailLogId, "local-provider-message-id", now);
  const [t9Log] = await sql`SELECT provider_message_id, status FROM email_log WHERE id = ${emailLogId}`;
  assert(t9Log.provider_message_id === "local-provider-message-id" && t9Log.status === "sent", "T9 provider status non aggiornato");
  results.push({ id: "T9", result: "PASS", raw: t9Log });

  // T10: il gateway reale è coperto dalla suite Vitest m13EmailDelivery.test.ts, eseguita separatamente.
  results.push({ id: "T10", result: "PENDING_EXTERNAL_UNIT", raw: "Eseguire Vitest gateway disabilitato" });
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
}

main().finally(() => sql.end({ timeout: 5 }));
