/**
 * Test end-to-end del trigger handle_new_user.
 *
 * 1. Crea utente test via supabase.auth.admin.createUser (no email inviata).
 * 2. Verifica che il trigger abbia creato la riga in public.users con
 *    role='operator', email matching, name derivato da local-part.
 * 3. Cancella l'utente via supabase.auth.admin.deleteUser; la FK
 *    ON DELETE CASCADE rimuove anche la riga public.users.
 * 4. Verifica che entrambe le tabelle siano effettivamente pulite.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

const testEmail = `trigger-test-${Date.now()}@soketo.test`;

function ok(msg: string) {
  console.log(`✅ ${msg}`);
}
function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  console.log(`\n--- creo utente test: ${testEmail} ---`);
  const { data, error } = await supabase.auth.admin.createUser({
    email: testEmail,
    email_confirm: true,
  });
  if (error) fail(`createUser: ${error.message}`);
  if (!data.user) fail("createUser: nessun user restituito");
  const userId = data.user.id;
  ok(`auth.users creato, id=${userId}`);

  // Lascio un piccolo respiro al trigger (dovrebbe essere sincrono ma per sicurezza).
  await new Promise((r) => setTimeout(r, 200));

  console.log(`\n--- verifica riga public.users ---`);
  const rows = await sql`
    SELECT id, email, name, role, "createdAt"
    FROM public.users
    WHERE id = ${userId};
  `;
  if (rows.length === 0)
    fail(`public.users vuoto per id=${userId} → trigger NON ha popolato`);
  const u = rows[0];
  ok(`public.users id=${u.id}`);

  if (u.email !== testEmail)
    fail(`email mismatch: atteso=${testEmail} attuale=${u.email}`);
  ok(`email = ${u.email}`);

  if (u.role !== "operator")
    fail(`role mismatch: atteso=operator attuale=${u.role}`);
  ok(`role = ${u.role} (default applicato dallo schema)`);

  const expectedName = testEmail.split("@")[0];
  if (u.name !== expectedName)
    fail(`name mismatch: atteso=${expectedName} attuale=${u.name}`);
  ok(`name = ${u.name} (derivato da local-part email)`);

  console.log(`\n--- cleanup: delete user ---`);
  const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
  if (delErr) fail(`deleteUser: ${delErr.message}`);
  ok(`auth.users id=${userId} deleted`);

  await new Promise((r) => setTimeout(r, 200));

  const after = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM auth.users WHERE id = ${userId})  AS auth_remaining,
      (SELECT COUNT(*)::int FROM public.users WHERE id = ${userId}) AS public_remaining;
  `;
  if (after[0].auth_remaining !== 0)
    fail(`auth.users non rimosso: ${after[0].auth_remaining} righe restanti`);
  if (after[0].public_remaining !== 0)
    fail(
      `public.users non rimosso (FK CASCADE rotto?): ${after[0].public_remaining} righe restanti`,
    );
  ok(`CASCADE delete OK: auth=0 public=0`);

  console.log("\n🎯 Trigger handle_new_user funziona end-to-end.");
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
