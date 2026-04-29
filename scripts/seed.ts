/**
 * Seed dei dati legacy estratti da dump_manus_DATA.sql.
 *
 * Strategia:
 *  - Idempotente: se le tabelle target hanno già record, lo script esce senza fare nulla.
 *  - Genera nuovi UUID per ogni record, mantenendo le foreign relation (inventory → retailers/products)
 *    tramite mapping oldIntId → newUuid.
 *  - Preserva createdAt/updatedAt originali (non rilevanti per la logica, ma utili per audit).
 *  - L'utente legacy (Manus owner test) NON viene importato: sarà ricreato via Supabase Auth.
 *
 * Esecuzione: pnpm exec tsx scripts/seed.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { inventory, products, retailers } from "../drizzle/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(databaseUrl, { prepare: false, max: 1 });
const db = drizzle(client);

type RetailerRow = {
  oldId: number;
  name: string;
  businessType: string | null;
  city: string | null;
  province: string | null;
  email: string | null;
  syncEnabled: number;
  createdAt: string;
};

const retailerData: RetailerRow[] = [
  { oldId: 1, name: "Test Farmacia", businessType: "Farmacia", city: "Milano", province: "MI", email: "test@farmacia.it", syncEnabled: 1, createdAt: "2026-02-17 11:57:26" },
  { oldId: 30001, name: "Test Farmacia Details", businessType: "Farmacia", city: "Milano", province: "MI", email: "details@test.it", syncEnabled: 1, createdAt: "2026-02-17 20:03:42" },
  { oldId: 30002, name: "Test Farmacia", businessType: "Farmacia", city: "Milano", province: "MI", email: "test@farmacia.it", syncEnabled: 1, createdAt: "2026-02-17 20:03:42" },
  { oldId: 30003, name: "Test Stats Retailer", businessType: "Ristorante", city: "Roma", province: null, email: null, syncEnabled: 1, createdAt: "2026-02-17 20:03:42" },
  { oldId: 30004, name: "Test Farmacia Details", businessType: "Farmacia", city: "Milano", province: "MI", email: "details@test.it", syncEnabled: 1, createdAt: "2026-02-17 20:04:28" },
  { oldId: 30005, name: "Test Stats Retailer", businessType: "Ristorante", city: "Roma", province: null, email: null, syncEnabled: 1, createdAt: "2026-02-17 20:04:28" },
  { oldId: 30006, name: "Test Farmacia", businessType: "Farmacia", city: "Milano", province: "MI", email: "test@farmacia.it", syncEnabled: 1, createdAt: "2026-02-17 20:04:28" },
  { oldId: 30007, name: "Test Farmacia Details", businessType: "Farmacia", city: "Milano", province: "MI", email: "details@test.it", syncEnabled: 1, createdAt: "2026-02-17 20:05:05" },
  { oldId: 30008, name: "Test Stats Retailer", businessType: "Ristorante", city: "Roma", province: null, email: null, syncEnabled: 1, createdAt: "2026-02-17 20:05:05" },
  { oldId: 30009, name: "Test Farmacia", businessType: "Farmacia", city: "Milano", province: "MI", email: "test@farmacia.it", syncEnabled: 1, createdAt: "2026-02-17 20:05:05" },
  { oldId: 30010, name: "Test Farmacia Details", businessType: "Farmacia", city: "Milano", province: "MI", email: "details@test.it", syncEnabled: 0, createdAt: "2026-02-17 20:32:45" },
  { oldId: 30011, name: "Test Stats Retailer", businessType: "Ristorante", city: "Roma", province: null, email: null, syncEnabled: 0, createdAt: "2026-02-17 20:32:45" },
  { oldId: 30012, name: "Test Farmacia", businessType: "Farmacia", city: "Milano", province: "MI", email: "test@farmacia.it", syncEnabled: 0, createdAt: "2026-02-17 20:32:45" },
];

type ProductRow = {
  oldId: number;
  sku: string;
  name: string;
  category: string | null;
  unitPrice: string;
  unit: string;
  minStockThreshold: number;
  createdAt: string;
};

const productData: ProductRow[] = [
  { oldId: 1, sku: "TEST-001", name: "Pane Keto Test", category: "Pane", unitPrice: "5.99", unit: "pz", minStockThreshold: 10, createdAt: "2026-02-17 11:57:26" },
  { oldId: 30001, sku: "TEST-STATS-001", name: "Prodotto Test Stats", category: null, unitPrice: "10.00", unit: "pz", minStockThreshold: 5, createdAt: "2026-02-17 20:03:42" },
  { oldId: 30003, sku: "TEST-STATS-1771358668855", name: "Prodotto Test Stats", category: null, unitPrice: "10.00", unit: "pz", minStockThreshold: 5, createdAt: "2026-02-17 20:04:28" },
  { oldId: 30004, sku: "TEST-1771358668912", name: "Pane Keto Test", category: "Pane", unitPrice: "5.99", unit: "pz", minStockThreshold: 10, createdAt: "2026-02-17 20:04:28" },
  { oldId: 30005, sku: "TEST-STATS-1771358705397", name: "Prodotto Test Stats", category: null, unitPrice: "10.00", unit: "pz", minStockThreshold: 5, createdAt: "2026-02-17 20:05:05" },
  { oldId: 30006, sku: "TEST-1771358705434", name: "Pane Keto Test", category: "Pane", unitPrice: "5.99", unit: "pz", minStockThreshold: 10, createdAt: "2026-02-17 20:05:05" },
  { oldId: 30007, sku: "TEST-STATS-1771360365559", name: "Prodotto Test Stats", category: null, unitPrice: "10.00", unit: "pz", minStockThreshold: 5, createdAt: "2026-02-17 20:32:45" },
  { oldId: 30008, sku: "TEST-1771360365598", name: "Pane Keto Test", category: "Pane", unitPrice: "5.99", unit: "pz", minStockThreshold: 10, createdAt: "2026-02-17 20:32:45" },
];

type InventoryRow = {
  oldRetailerId: number;
  oldProductId: number;
  quantity: number;
  createdAt: string;
};

const inventoryData: InventoryRow[] = [
  { oldRetailerId: 30008, oldProductId: 30005, quantity: 3, createdAt: "2026-02-17 20:05:05" },
  { oldRetailerId: 30011, oldProductId: 30007, quantity: 3, createdAt: "2026-02-17 20:32:45" },
];

async function main() {
  console.log("[seed] Connessione a", databaseUrl!.replace(/:[^:@]+@/, ":***@"));

  const existingRetailers = await db.select({ id: retailers.id }).from(retailers).limit(1);
  if (existingRetailers.length > 0) {
    console.log("[seed] Tabella retailers già popolata — skip seed (idempotente).");
    await client.end();
    return;
  }

  const retailerIdMap = new Map<number, string>();
  for (const r of retailerData) {
    const ts = new Date(`${r.createdAt}Z`);
    const [row] = await db
      .insert(retailers)
      .values({
        name: r.name,
        businessType: r.businessType,
        city: r.city,
        province: r.province,
        email: r.email,
        syncEnabled: r.syncEnabled,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: retailers.id });
    retailerIdMap.set(r.oldId, row.id);
  }
  console.log(`[seed] Inseriti ${retailerData.length} retailers.`);

  const productIdMap = new Map<number, string>();
  for (const p of productData) {
    const ts = new Date(`${p.createdAt}Z`);
    const [row] = await db
      .insert(products)
      .values({
        sku: p.sku,
        name: p.name,
        category: p.category,
        unitPrice: p.unitPrice,
        unit: p.unit,
        minStockThreshold: p.minStockThreshold,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: products.id });
    productIdMap.set(p.oldId, row.id);
  }
  console.log(`[seed] Inseriti ${productData.length} products.`);

  for (const inv of inventoryData) {
    const retailerUuid = retailerIdMap.get(inv.oldRetailerId);
    const productUuid = productIdMap.get(inv.oldProductId);
    if (!retailerUuid || !productUuid) {
      throw new Error(
        `[seed] Mapping mancante per inventory: retailer=${inv.oldRetailerId} product=${inv.oldProductId}`,
      );
    }
    const ts = new Date(`${inv.createdAt}Z`);
    await db.insert(inventory).values({
      retailerId: retailerUuid,
      productId: productUuid,
      quantity: inv.quantity,
      createdAt: ts,
      lastUpdated: ts,
    });
  }
  console.log(`[seed] Inseriti ${inventoryData.length} inventory rows.`);

  await client.end();
  console.log("[seed] Done.");
}

main().catch((err) => {
  console.error("[seed] FATAL:", err);
  process.exit(1);
});
