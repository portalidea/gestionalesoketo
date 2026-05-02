/**
 * Diagnosi M3.0.4: verifica se DELETE su systemIntegrations
 * funziona davvero attraverso la stessa connection di Drizzle.
 *
 * Uso: pnpm exec tsx scripts/diag-fic-disconnect.ts
 */
import { config } from "dotenv";
config({ path: "/Users/admin/Projects/gestionalesoketo/.env.local" });

import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    console.log("=== STATO PRE-DELETE ===");
    const before = await sql<{ type: string; account_id: string | null; expires_at: Date | null }[]>`
      SELECT "type", "accountId" AS account_id, "expiresAt" AS expires_at
      FROM "systemIntegrations"
    `;
    console.log("Righe in systemIntegrations:", before.length);
    for (const r of before) {
      console.log(`  type=${r.type} accountId=${r.account_id} expiresAt=${r.expires_at}`);
    }

    console.log("\n=== TEST DELETE (rollback in transazione, no scrittura) ===");
    await sql.begin(async (tx) => {
      const deleted = await tx<{ id: string; type: string }[]>`
        DELETE FROM "systemIntegrations"
        WHERE "type" = 'fattureincloud'
        RETURNING "id", "type"
      `;
      console.log(`DELETE righe affette: ${deleted.length}`);
      deleted.forEach((d) => console.log(`  id=${d.id} type=${d.type}`));
      console.log("ROLLBACK forced (questo è solo un dry-run).");
      throw new Error("__rollback_dryrun__");
    }).catch((e) => {
      if ((e as Error).message !== "__rollback_dryrun__") throw e;
    });

    console.log("\n=== STATO POST-DRYRUN (deve essere uguale a PRE) ===");
    const after = await sql`
      SELECT "type", "accountId" FROM "systemIntegrations"
    `;
    console.log("Righe:", after.length);

    console.log("\n=== INFO CONNECTION ROLE ===");
    const role = await sql<{ current_user: string; session_user: string; bypass_rls: boolean }[]>`
      SELECT current_user, session_user,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `;
    console.log("current_user :", role[0]?.current_user);
    console.log("session_user :", role[0]?.session_user);
    console.log("bypass RLS   :", role[0]?.bypass_rls);

    console.log("\n=== POLICY su systemIntegrations ===");
    const pols = await sql<{ policyname: string; cmd: string; qual: string }[]>`
      SELECT policyname, cmd, qual::text FROM pg_policies
      WHERE schemaname='public' AND tablename='systemIntegrations'
    `;
    console.log(`Policy attive: ${pols.length}`);
    pols.forEach((p) => console.log(`  ${p.policyname} (${p.cmd}) → ${p.qual}`));
  } finally {
    await sql.end();
  }
}
main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
