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
  const { runScheduledDispatcher } = await import("../server/cron-alerts");

  await sql`DELETE FROM expiry_alert_items`;
  await sql`DELETE FROM expiry_alert_notifications`;
  await sql`DELETE FROM expiry_alert_suppressions`;
  await sql`DELETE FROM expiry_alert_runs`;
  await sql`DELETE FROM email_events`;
  await sql`DELETE FROM email_log`;
  await seedHotfixM13();

  const now = new Date();
  now.setUTCDate(10);
  now.setUTCHours(5, 0, 0, 0);
  const expiryInWindow = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await sql`
    UPDATE "productBatches"
    SET "expirationDate" = ${expiryInWindow}::date
    WHERE id = ${TEST_IDS.batchSoon}
  `;

  const result = await runScheduledDispatcher({ now, m13CronEnabled: true });
  const runs = await sql`
    SELECT id, company_id, mode, trigger, status, emails_sent, emails_failed, items_flagged
    FROM expiry_alert_runs
    WHERE company_id = ${TEST_IDS.originCompany} AND trigger = 'cron'
    ORDER BY created_at DESC
  `;
  const notifications = await sql`
    SELECT id, status, skip_reason, items_count
    FROM expiry_alert_notifications
    WHERE run_id = ${runs[0]?.id}
  `;
  const suppressions = await sql`
    SELECT old_batch_code, new_batch_code, reason
    FROM expiry_alert_suppressions
    WHERE run_id = ${runs[0]?.id}
  `;
  const [{ count: emailLogCount }] = await sql`SELECT COUNT(*)::int AS count FROM email_log`;

  assert(result.expiryAlerts.scheduled, "Il dispatcher deve pianificare M13 il giorno 10.");
  assert(result.expiryAlerts.enabled, "Il dispatcher deve riconoscere M13_CRON_ENABLED=true.");
  assert(result.expiryAlerts.results.length > 0, "Il dispatcher deve eseguire M13 per le company attive.");
  assert(runs.length === 1, "Il dispatcher deve creare un solo run M13 per la company fixture.");
  assert(runs[0]?.mode === "alert" && runs[0]?.trigger === "cron", "Il run deve essere alert/cron.");
  assert(runs[0]?.status === "completed", "Il run M13 deve completare.");
  assert(runs[0]?.emails_sent === 0 && runs[0]?.emails_failed === 0, "Il run non deve inviare email.");
  assert(runs[0]?.items_flagged === 1, "Il dispatcher deve persistere il lotto in finestra.");
  assert(notifications.length === 1 && notifications[0]?.status === "pending", "Il dispatcher deve creare una notifica operativa.");
  assert(emailLogCount === 0, "Il dispatcher M13 non deve creare righe email_log.");

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    dispatcher: result,
    raw: { runs, notifications, suppressions, emailLogCount },
  }, null, 2));
}

main().finally(() => sql.end({ timeout: 5 }));
