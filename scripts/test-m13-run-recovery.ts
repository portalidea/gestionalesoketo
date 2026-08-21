import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { companies, expiryAlertRuns } from "../drizzle/schema";
import { recoverStaleExpiryAlertCronRuns } from "../server/services/expiryAlertRunRecovery";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: questo script deve girare solo sul database isolato.");

const companyA = "00000000-0000-0000-0000-0000000000f4";
const companyB = "00000000-0000-0000-0000-0000000000f5";
const now = new Date("2099-03-01T10:00:00.000Z");
const window = { companyId: companyA, periodStart: "2099-03-01", periodEnd: "2099-03-31" };

const client = postgres(databaseUrl, { prepare: false, max: 1 });
const db = drizzle(client);

async function main() {
  try {
    await db.delete(expiryAlertRuns).where(inArray(expiryAlertRuns.companyId, [companyA, companyB]));
    await db.delete(companies).where(inArray(companies.id, [companyA, companyB]));

    await db.insert(companies).values([
      { id: companyA, name: "TEST M13 Recovery A", isActive: true },
      { id: companyB, name: "TEST M13 Recovery B", isActive: true },
    ]);

    const [staleA, recentA, staleOtherCompany, staleOtherWindow] = await db
      .insert(expiryAlertRuns)
      .values([
        { companyId: companyA, mode: "alert", runDate: "2099-03-01", periodStart: "2099-03-01", periodEnd: "2099-03-31", trigger: "cron", status: "running", createdAt: new Date("2099-03-01T07:59:59.000Z") },
        { companyId: companyA, mode: "alert", runDate: "2099-03-01", periodStart: "2099-03-01", periodEnd: "2099-03-31", trigger: "manual", status: "running", createdAt: new Date("2099-03-01T09:00:00.000Z") },
        { companyId: companyB, mode: "alert", runDate: "2099-03-01", periodStart: "2099-03-01", periodEnd: "2099-03-31", trigger: "cron", status: "running", createdAt: new Date("2099-03-01T07:00:00.000Z") },
        { companyId: companyA, mode: "alert", runDate: "2099-02-01", periodStart: "2099-02-01", periodEnd: "2099-02-28", trigger: "cron", status: "running", createdAt: new Date("2099-03-01T07:00:00.000Z") },
      ])
      .returning({ id: expiryAlertRuns.id });

    const recoveredIds = await recoverStaleExpiryAlertCronRuns(db, window, now);
    assert.deepEqual(recoveredIds, [staleA.id]);

    const rows = await db
      .select({ id: expiryAlertRuns.id, status: expiryAlertRuns.status, errorMessage: expiryAlertRuns.errorMessage })
      .from(expiryAlertRuns)
      .where(and(inArray(expiryAlertRuns.id, [staleA.id, recentA.id, staleOtherCompany.id, staleOtherWindow.id])));
    const result = new Map(rows.map((row) => [row.id, row]));

    assert.equal(result.get(staleA.id)?.status, "failed");
    assert.match(result.get(staleA.id)?.errorMessage ?? "", /oltre 2 ore/);
    assert.equal(result.get(recentA.id)?.status, "running");
    assert.equal(result.get(staleOtherCompany.id)?.status, "running");
    assert.equal(result.get(staleOtherWindow.id)?.status, "running");

    console.log("PASS: recupero M13 limita l'update alla company e finestra cron obsolete.");
  } finally {
    await db.delete(expiryAlertRuns).where(inArray(expiryAlertRuns.companyId, [companyA, companyB]));
    await db.delete(companies).where(inArray(companies.id, [companyA, companyB]));
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
