import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

async function main() {
  console.log("=== 1. Trigger su auth.users ===");
  const triggers = await sql`
    SELECT trigger_name, event_manipulation, action_timing, event_object_schema, event_object_table
    FROM information_schema.triggers
    WHERE event_object_schema = 'auth' AND event_object_table = 'users'
    ORDER BY trigger_name;
  `;
  console.table(triggers);

  console.log("\n=== 2. Funzione public.handle_new_user ===");
  const fn = await sql`
    SELECT
      proname,
      pg_get_function_identity_arguments(oid) AS args,
      prosecdef AS security_definer,
      proconfig AS config,
      pg_get_functiondef(oid) AS source
    FROM pg_proc
    WHERE proname = 'handle_new_user' AND pronamespace = 'public'::regnamespace;
  `;
  if (fn.length === 0) {
    console.log("❌ funzione NON trovata");
  } else {
    console.log(`name: ${fn[0].proname}(${fn[0].args})`);
    console.log(`security_definer: ${fn[0].security_definer}`);
    console.log(`config: ${JSON.stringify(fn[0].config)}`);
    console.log("--- source ---");
    console.log(fn[0].source);
  }

  console.log("\n=== 3. Schema public.users (default role, FK) ===");
  const cols = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    ORDER BY ordinal_position;
  `;
  console.table(cols);

  const fks = await sql`
    SELECT conname AS constraint_name,
           pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass AND contype = 'f';
  `;
  console.log("FK su public.users (via pg_constraint):");
  console.table(fks);

  console.log("\n=== 4. Utenti attuali (auth.users JOIN public.users) ===");
  const usersRows = await sql`
    SELECT
      au.id,
      au.email AS auth_email,
      au.created_at AS auth_created_at,
      pu.email AS public_email,
      pu.name AS public_name,
      pu.role AS public_role,
      pu."createdAt" AS public_created_at
    FROM auth.users au
    LEFT JOIN public.users pu ON pu.id = au.id
    ORDER BY au.created_at;
  `;
  console.table(usersRows);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
