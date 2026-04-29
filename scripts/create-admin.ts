/**
 * Crea il primo admin SoKeto su Supabase + promuove a role 'admin'
 * nella tabella public.users.
 *
 * Idempotente: se l'utente esiste già, ne aggiorna solo il ruolo.
 *
 * Esecuzione:
 *   pnpm exec tsx scripts/create-admin.ts info@soketo.it
 *   pnpm exec tsx scripts/create-admin.ts                   # usa OWNER_EMAIL da .env.local
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { createClient } from "@supabase/supabase-js";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { users } from "../drizzle/schema";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) {
  throw new Error(
    "Servono SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL nell'env.",
  );
}

const adminEmail = process.argv[2] ?? process.env.OWNER_EMAIL;
if (!adminEmail) {
  throw new Error(
    "Email admin non specificata. Passala come argomento o definisci OWNER_EMAIL in .env.local.",
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sqlClient = postgres(DATABASE_URL, { prepare: false, max: 1 });
const db = drizzle(sqlClient);

async function findUserByEmail(email: string) {
  // Supabase Admin API non ha un getByEmail diretto: paginiamo listUsers.
  // Per il numero di utenti previsto (decine al massimo) è ok.
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 200) return null;
    page++;
  }
}

async function main() {
  console.log(`[create-admin] Target: ${adminEmail}`);

  let authUser = await findUserByEmail(adminEmail!);

  if (!authUser) {
    console.log("[create-admin] Utente non esistente, lo creo via Admin API…");
    const { data, error } = await supabase.auth.admin.createUser({
      email: adminEmail,
      email_confirm: true, // non serve conferma per l'admin bootstrap
    });
    if (error) throw error;
    if (!data.user) throw new Error("createUser: nessun user restituito");
    authUser = data.user;
    console.log(`[create-admin] Creato auth.users.id = ${authUser.id}`);
  } else {
    console.log(`[create-admin] Utente esistente, auth.users.id = ${authUser.id}`);
  }

  // Il trigger handle_new_user dovrebbe aver creato la riga in public.users.
  // Promuoviamo a admin (idempotente).
  const result = await db
    .update(users)
    .set({ role: "admin", updatedAt: new Date() })
    .where(eq(users.id, authUser.id))
    .returning({ id: users.id, email: users.email, role: users.role });

  if (result.length === 0) {
    // Fallback: il trigger non è ancora attivo o l'utente è stato creato fuori
    // dal flusso normale. Inseriamo a mano.
    console.log("[create-admin] Riga public.users mancante, la inserisco a mano…");
    const inserted = await db
      .insert(users)
      .values({
        id: authUser.id,
        email: authUser.email!,
        role: "admin",
      })
      .returning();
    console.log("[create-admin] Riga inserita:", inserted[0]);
  } else {
    console.log("[create-admin] Aggiornato role:", result[0]);
  }

  // Per finalizzare il login dell'admin appena creato manda un magic link.
  const { error: linkError } = await supabase.auth.signInWithOtp({
    email: adminEmail!,
    options: { shouldCreateUser: false },
  });
  if (linkError) {
    console.warn(
      "[create-admin] Impossibile inviare magic link automatico:",
      linkError.message,
    );
    console.warn(
      "  → vai su /login e richiedi il link manualmente.",
    );
  } else {
    console.log("[create-admin] Magic link di accesso inviato a", adminEmail);
  }

  await sqlClient.end();
  console.log("[create-admin] Done.");
}

main().catch((err) => {
  console.error("[create-admin] FATAL:", err);
  process.exit(1);
});
