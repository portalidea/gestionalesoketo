/**
 * Esegue un file SQL contro DATABASE_URL.
 * Splitta su `--> statement-breakpoint` (convenzione drizzle-kit / nostra)
 * e applica tutto dentro una singola transazione: se un blocco fallisce,
 * rollback completo.
 *
 * Uso:
 *   pnpm exec tsx scripts/apply-sql.ts drizzle/0005_phase_b_m3_pricing_fic.sql
 *
 * NB: NON gestisce il journal `drizzle.__drizzle_migrations`. Coerente con
 * il pattern usato per 0001/0002/0003/0004 (apply manuale fuori da drizzle-kit
 * per via di RLS / CHECK / DO blocks non supportati da drizzle-kit).
 */
import { config } from "dotenv";
config({ path: "/Users/admin/Projects/gestionalesoketo/.env.local" });

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: tsx scripts/apply-sql.ts <path-to-sql>");
    process.exit(2);
  }

  const path = resolve(file);
  const raw = readFileSync(path, "utf8");

  // Split su statement-breakpoint, scarta blocchi vuoti / di soli commenti
  const blocks = raw
    .split(/-->\s*statement-breakpoint/g)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    // Escludi blocchi che sono solo commenti SQL (dopo strip, niente SQL eseguibile)
    .filter((b) => {
      const stripped = b
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n")
        .trim();
      return stripped.length > 0;
    });

  console.log(`📄 File: ${path}`);
  console.log(`📦 Blocks da eseguire: ${blocks.length}`);

  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

  let executed = 0;
  try {
    await sql.begin(async (tx) => {
      for (const [i, block] of blocks.entries()) {
        const preview = block.split("\n").slice(0, 1)[0]?.slice(0, 80);
        process.stdout.write(`  [${i + 1}/${blocks.length}] ${preview}…  `);
        await tx.unsafe(block);
        executed++;
        process.stdout.write("ok\n");
      }
    });
    console.log(`\n✅ Applicate ${executed}/${blocks.length} statements in transazione.`);
  } catch (e) {
    console.error(`\n❌ Errore al blocco ${executed + 1}/${blocks.length}:`);
    console.error((e as Error).message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
