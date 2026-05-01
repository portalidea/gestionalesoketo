/**
 * Verifica post-apply migration 0005 (Phase B M3).
 * Sanity check su: pacchetti seed, vatRate prodotti, colonne retailers,
 * tabelle nuove, RLS, indici.
 */
import { config } from "dotenv";
config({ path: "/Users/admin/Projects/gestionalesoketo/.env.local" });

import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  let failed = 0;
  const expect = async (label: string, fn: () => Promise<boolean | string>) => {
    const r = await fn();
    if (r === true) console.log(`  ✅ ${label}`);
    else {
      console.log(`  ❌ ${label} → ${r}`);
      failed++;
    }
  };

  try {
    console.log("=== 1. pricingPackages seed ===");
    const pkgs = await sql<{ name: string; discountPercent: string }[]>`
      SELECT "name", "discountPercent"::text FROM "pricingPackages" ORDER BY "sortOrder"
    `;
    await expect("4 pacchetti seed", async () => pkgs.length === 4 || `count=${pkgs.length}`);
    console.log("  pacchetti:", pkgs.map((p) => `${p.name}=${p.discountPercent}%`).join(", "));

    console.log("\n=== 2. products.vatRate ===");
    const prods = await sql<{ sku: string; vatRate: string }[]>`
      SELECT sku, "vatRate"::text FROM products
    `;
    await expect("SMOKE-001 vatRate=10.00", async () => {
      const smoke = prods.find((p) => p.sku === "SMOKE-001");
      return (smoke && smoke.vatRate === "10.00") || `smoke=${JSON.stringify(smoke)}`;
    });

    console.log("\n=== 3. retailers nuove colonne ===");
    const retCols = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='retailers'
        AND column_name IN ('pricingPackageId','ficClientId')
    `;
    await expect("retailers.pricingPackageId+ficClientId", async () =>
      retCols.length === 2 || `cols=${JSON.stringify(retCols)}`,
    );

    console.log("\n=== 4. tabelle nuove ===");
    for (const t of ["pricingPackages", "systemIntegrations", "proformaQueue"]) {
      await expect(`tabella ${t}`, async () => {
        const r = await sql.unsafe(`SELECT count(*)::int AS c FROM "${t}"`);
        return typeof r[0]?.c === "number" || `r=${JSON.stringify(r)}`;
      });
    }

    console.log("\n=== 5. enum proforma_queue_status ===");
    const enums = await sql<{ val: string }[]>`
      SELECT unnest(enum_range(NULL::proforma_queue_status))::text AS val
    `;
    await expect("4 valori enum", async () =>
      enums.length === 4 || `vals=${enums.map((e) => e.val).join(",")}`,
    );

    console.log("\n=== 6. RLS abilitata ===");
    for (const t of ["pricingPackages", "systemIntegrations", "proformaQueue"]) {
      await expect(`RLS on ${t}`, async () => {
        const r = await sql<{ relrowsecurity: boolean }[]>`
          SELECT c.relrowsecurity FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='public' AND c.relname=${t}
        `;
        return r[0]?.relrowsecurity === true || `r=${JSON.stringify(r)}`;
      });
    }

    console.log("\n=== 7. CHECK constraint products.vatRate ===");
    await expect("rifiuta vatRate=15", async () => {
      try {
        await sql`UPDATE products SET "vatRate" = 15.00 WHERE sku = 'SMOKE-001'`;
        return "CHECK NON applicato — vatRate=15 accettato!";
      } catch (e) {
        return /products_vatRate_valid/.test((e as Error).message);
      }
    });

    console.log("\n=== 8. seed Idempotency ===");
    await expect("seed re-run no error", async () => {
      try {
        await sql`
          INSERT INTO "pricingPackages" ("name","discountPercent","sortOrder")
          VALUES ('Starter', 99.00, 99)
          ON CONFLICT ("name") DO NOTHING
        `;
        const c = await sql<{ count: string }[]>`SELECT count(*)::text FROM "pricingPackages"`;
        return c[0]?.count === "4" || `count=${c[0]?.count}`;
      } catch (e) {
        return (e as Error).message;
      }
    });

    console.log("\n=== 9. stockMovements proforma columns ===");
    const mvCols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='stockMovements'
        AND column_name IN ('ficProformaId','ficProformaNumber')
    `;
    await expect("stockMovements.ficProformaId+Number", async () =>
      mvCols.length === 2 || `cols=${JSON.stringify(mvCols)}`,
    );

    console.log("\n=== 10. indici ===");
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname IN
        ('retailers_pricingPackageId_idx','proformaQueue_status_idx')
    `;
    await expect("2 indici parziali", async () =>
      idx.length === 2 || `idx=${JSON.stringify(idx)}`,
    );

    console.log("");
    if (failed === 0) console.log("🎉 ALL CHECKS PASSED");
    else console.log(`⚠️  ${failed} checks falliti`);
  } finally {
    await sql.end();
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
