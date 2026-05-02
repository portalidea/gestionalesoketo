/**
 * Diagnosi M3.0.7: indici e EXPLAIN ANALYZE delle query aggregate
 * più lente (getAllRetailers + getAllProducts + dashboard.getStats).
 *
 * Uso: pnpm exec tsx scripts/diag-perf-indexes.ts
 */
import { config } from "dotenv";
config({ path: "/Users/admin/Projects/gestionalesoketo/.env.local" });

import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    console.log("=".repeat(72));
    console.log("1. INDICI ESISTENTI sulle tabelle aggregate");
    console.log("=".repeat(72));
    const idx = await sql<{ tablename: string; indexname: string; indexdef: string }[]>`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('retailers', 'locations', 'inventoryByBatch',
                          'productBatches', 'products', 'stockMovements',
                          'producers', 'pricingPackages', 'systemIntegrations',
                          'proformaQueue')
      ORDER BY tablename, indexname
    `;
    let lastTable = "";
    for (const r of idx) {
      if (r.tablename !== lastTable) {
        console.log(`\n[${r.tablename}]`);
        lastTable = r.tablename;
      }
      console.log(`  ${r.indexname}`);
      console.log(`    ${r.indexdef.replace(/^CREATE.*ON public\./, "ON ")}`);
    }

    console.log("\n" + "=".repeat(72));
    console.log("2. CONTEGGI tabelle (per capire scala)");
    console.log("=".repeat(72));
    for (const t of [
      "retailers",
      "products",
      "locations",
      "inventoryByBatch",
      "productBatches",
      "stockMovements",
      "alerts",
    ]) {
      const r = await sql.unsafe(`SELECT count(*)::int AS c FROM "${t}"`);
      console.log(`  ${t.padEnd(20)} ${r[0]?.c}`);
    }

    console.log("\n" + "=".repeat(72));
    console.log("3. EXPLAIN ANALYZE — query getAllRetailers (M2.5)");
    console.log("=".repeat(72));
    const retailersPlan = await sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT
        r.id, r.name,
        COALESCE((
          SELECT COUNT(*)::int
          FROM "inventoryByBatch" ibb
          INNER JOIN "locations" l ON l.id = ibb."locationId"
          WHERE l."retailerId" = r.id
            AND ibb.quantity > 0
        ), 0) AS active_batch_count,
        COALESCE((
          SELECT SUM(ibb.quantity)::int
          FROM "inventoryByBatch" ibb
          INNER JOIN "locations" l ON l.id = ibb."locationId"
          WHERE l."retailerId" = r.id
        ), 0) AS total_stock,
        COALESCE((
          SELECT SUM(ibb.quantity * NULLIF(p."unitPrice", '')::numeric)::numeric(18,2)
          FROM "inventoryByBatch" ibb
          INNER JOIN "locations" l ON l.id = ibb."locationId"
          INNER JOIN "productBatches" pb ON pb.id = ibb."batchId"
          INNER JOIN "products" p ON p.id = pb."productId"
          WHERE l."retailerId" = r.id
        ), 0) AS inventory_value
      FROM retailers r
      ORDER BY r.name
    `;
    retailersPlan.forEach((row) => console.log("  " + row["QUERY PLAN"]));

    console.log("\n" + "=".repeat(72));
    console.log("4. EXPLAIN ANALYZE — query getAllProducts (M2.5)");
    console.log("=".repeat(72));
    const productsPlan = await sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT
        p.id, p.sku, p.name,
        COALESCE((
          SELECT SUM(ibb.quantity)::int
          FROM "inventoryByBatch" ibb
          INNER JOIN "locations" l ON l.id = ibb."locationId"
          INNER JOIN "productBatches" pb ON pb.id = ibb."batchId"
          WHERE pb."productId" = p.id
            AND l.type = 'central_warehouse'
        ), 0) AS central_stock,
        COALESCE((
          SELECT SUM(ibb.quantity)::int
          FROM "inventoryByBatch" ibb
          INNER JOIN "productBatches" pb ON pb.id = ibb."batchId"
          WHERE pb."productId" = p.id
        ), 0) AS total_stock,
        COALESCE((
          SELECT COUNT(*)::int
          FROM "inventoryByBatch" ibb
          INNER JOIN "productBatches" pb ON pb.id = ibb."batchId"
          WHERE pb."productId" = p.id
            AND ibb.quantity > 0
        ), 0) AS active_batch_count
      FROM products p
      ORDER BY p.name
    `;
    productsPlan.forEach((row) => console.log("  " + row["QUERY PLAN"]));

    console.log("\n" + "=".repeat(72));
    console.log("5. EXPLAIN ANALYZE — getDashboardStats batch query");
    console.log("=".repeat(72));
    const dashPlan = await sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT
        ibb."locationId",
        pb."productId",
        ibb.quantity,
        pb."expirationDate",
        p."unitPrice",
        p."minStockThreshold",
        l.type AS location_type
      FROM "inventoryByBatch" ibb
      INNER JOIN "productBatches" pb ON pb.id = ibb."batchId"
      INNER JOIN "products" p ON p.id = pb."productId"
      INNER JOIN "locations" l ON l.id = ibb."locationId"
      WHERE l.type = 'retailer'
    `;
    dashPlan.forEach((row) => console.log("  " + row["QUERY PLAN"]));
  } finally {
    await sql.end();
  }
}
main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
