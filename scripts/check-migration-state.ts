import { config } from "dotenv";
config({ path: "/Users/admin/Projects/gestionalesoketo/.env.local" });

import postgres from "postgres";

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  console.log("=== DATABASE_URL target ===");
  console.log("Host    :", url.host);
  console.log("DB path :", url.pathname);
  console.log("");

  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

  try {
    console.log("=== Tabelle in schema public ===");
    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    console.log(tables.map((t) => t.tablename).join(", "));
    console.log("");

    console.log("=== Migration applicate (drizzle.__drizzle_migrations) ===");
    try {
      const migs = await sql`
        SELECT id, hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY id
      `;
      for (const m of migs) {
        console.log(`  id=${m.id}  hash=${(m.hash as string).slice(0, 12)}...  at=${m.created_at}`);
      }
      console.log(`Totale: ${migs.length}`);
    } catch (e) {
      console.log("ERR drizzle.__drizzle_migrations:", (e as Error).message);
    }
    console.log("");

    console.log("=== Test esistenza nuove tabelle 0003 ===");
    for (const t of ["producers", "productBatches", "locations", "inventoryByBatch"]) {
      try {
        const r = await sql.unsafe(`SELECT count(*)::int AS c FROM "${t}"`);
        console.log(`  ${t}: count=${r[0]?.c}  (ESISTE → 0003 applicata!)`);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        console.log(`  ${t}: ${msg.split("\n")[0]}`);
      }
    }
    console.log("");

    console.log("=== Enum stock_movement_type ===");
    const enums = await sql`
      SELECT unnest(enum_range(NULL::stock_movement_type))::text AS val
    `;
    console.log("Valori:", enums.map((e) => e.val).join(", "));
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
