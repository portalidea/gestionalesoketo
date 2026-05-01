/**
 * Dump data-only del DB applicativo SoKeto su file SQL.
 * Schema recuperabile dalle migration Drizzle in `drizzle/` (la sequenza
 * 0000_initial_postgres.sql → 0001 → 0002 ricostruisce schema + RLS +
 * trigger). Questo dump emette solo INSERT statements.
 *
 * Disaster recovery procedure:
 *   1. Crea nuovo progetto Supabase
 *   2. Applica drizzle migrations (`pnpm exec drizzle-kit migrate`)
 *   3. Applica questo dump:  psql $DATABASE_URL < backups/migration-final-YYYY-MM-DD.sql
 *
 * Uso: pnpm exec tsx scripts/dump-data.ts [output-path]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { writeFileSync } from "node:fs";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

const TABLES = [
  "users",
  "retailers",
  "products",
  "producers",
  "productBatches",
  "locations",
  "inventoryByBatch",
  "stockMovements",
  "alerts",
  "syncLogs",
];

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (typeof v === "object")
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  // string
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function dumpTable(name: string): Promise<{ rows: number; sql: string }> {
  // information_schema.columns: ordine ordinale
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${name}
    ORDER BY ordinal_position
  `;
  const colNames = cols.map((c) => c.column_name as string);
  if (colNames.length === 0) return { rows: 0, sql: `-- (table ${name} not found)\n` };

  const rows = (await sql.unsafe(`SELECT * FROM "${name}"`)) as Record<
    string,
    unknown
  >[];

  let out = `\n-- ============================================================\n`;
  out += `-- ${name} (${rows.length} rows)\n`;
  out += `-- ============================================================\n`;

  if (rows.length === 0) {
    out += `-- (no rows)\n`;
    return { rows: 0, sql: out };
  }

  const colList = colNames.map((c) => `"${c}"`).join(", ");
  for (const row of rows) {
    const values = colNames.map((c) => literal(row[c])).join(", ");
    out += `INSERT INTO "${name}" (${colList}) VALUES (${values});\n`;
  }
  return { rows: rows.length, sql: out };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const out = process.argv[2] ?? `backups/migration-final-${today}.sql`;

  let sqlOut = `-- ============================================================\n`;
  sqlOut += `-- SoKeto Inventory Manager — data-only dump\n`;
  sqlOut += `-- Generated: ${new Date().toISOString()}\n`;
  sqlOut += `-- Schema recovery: applicare drizzle/0000_*.sql, 0001_*.sql, 0002_*.sql\n`;
  sqlOut += `-- ============================================================\n`;

  let totalRows = 0;
  const summary: string[] = [];
  for (const t of TABLES) {
    const { rows, sql: tableSql } = await dumpTable(t);
    sqlOut += tableSql;
    totalRows += rows;
    summary.push(`  ${t}: ${rows} rows`);
  }

  writeFileSync(out, sqlOut);
  console.log(`✅ Dump scritto in ${out}`);
  console.log(`   Tabelle: ${TABLES.length}, righe totali: ${totalRows}`);
  console.log(summary.join("\n"));

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
