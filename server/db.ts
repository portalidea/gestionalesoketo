import { eq, and, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  users,
  retailers,
  InsertRetailer,
  products,
  InsertProduct,
  inventory,
  InsertInventory,
  stockMovements,
  InsertStockMovement,
  alerts,
  InsertAlert,
  syncLogs,
  InsertSyncLog,
} from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
//
// Pool config tuned for serverless (Vercel) + Supabase pgbouncer:
//   - prepare: false   → pgbouncer transaction mode non supporta prepared
//   - max: 5           → permette query parallele dentro la stessa istanza
//                        (es. dashboard.getStats + alerts.getActive in
//                        parallelo dalla home, o Promise.all interno)
//   - idle_timeout: 20 → chiude conn idle dopo 20s; evita di tenere
//                        connessioni che il pooler ha già reciso
//   - max_lifetime: 5min → cycling regolare per non avere conn stantie
//   - connect_timeout: 10 → fail-fast se Supabase non risponde
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _client = postgres(process.env.DATABASE_URL, {
        prepare: false,
        max: 5,
        idle_timeout: 20,
        max_lifetime: 60 * 5,
        connect_timeout: 10,
      });
      _db = drizzle(_client);
    } catch (error) {
      // Loggato sempre (anche in produzione) per visibilità in Vercel logs.
      console.error("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============= USERS =============

export async function getUserById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(users.email);
}

export async function updateUserRole(id: string, role: "admin" | "operator" | "viewer") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.id, id));
}

export async function deleteUser(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Cancellando da auth.users il trigger CASCADE rimuove anche public.users.
  // Qui gestiamo solo public.users; la rimozione da auth deve passare per
  // supabaseAdmin.auth.admin.deleteUser nel router.
  await db.delete(users).where(eq(users.id, id));
}

// ============= RETAILERS =============

export async function getAllRetailers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(retailers).orderBy(retailers.name);
}

export async function getRetailerById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(retailers).where(eq(retailers.id, id)).limit(1);
  return result[0];
}

export async function createRetailer(data: InsertRetailer) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(retailers).values(data).returning();
  return row;
}

export async function updateRetailer(id: string, data: Partial<InsertRetailer>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(retailers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(retailers.id, id));
}

export async function deleteRetailer(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(retailers).where(eq(retailers.id, id));
}

// ============= PRODUCTS =============

export async function getAllProducts() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(products).orderBy(products.name);
}

export async function getProductById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return result[0];
}

export async function getProductBySku(sku: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(products).where(eq(products.sku, sku)).limit(1);
  return result[0];
}

export async function createProduct(data: InsertProduct) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(products).values(data).returning();
  return row;
}

export async function updateProduct(id: string, data: Partial<InsertProduct>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(products)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(products.id, id));
}

export async function deleteProduct(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(products).where(eq(products.id, id));
}

// ============= INVENTORY =============

export async function getInventoryByRetailer(retailerId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inventory).where(eq(inventory.retailerId, retailerId));
}

export async function getInventoryItem(retailerId: string, productId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(inventory)
    .where(and(eq(inventory.retailerId, retailerId), eq(inventory.productId, productId)))
    .limit(1);
  return result[0];
}

export async function upsertInventory(data: InsertInventory) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getInventoryItem(data.retailerId, data.productId);
  if (existing) {
    await db
      .update(inventory)
      .set({ ...data, lastUpdated: new Date() })
      .where(eq(inventory.id, existing.id));
    return existing.id;
  } else {
    const [row] = await db.insert(inventory).values(data).returning({ id: inventory.id });
    return row.id;
  }
}

// ============= STOCK MOVEMENTS =============

export async function createStockMovement(data: InsertStockMovement) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(stockMovements).values(data).returning();
  return row;
}

export async function getStockMovementsByRetailer(retailerId: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.retailerId, retailerId))
    .orderBy(desc(stockMovements.timestamp))
    .limit(limit);
}

export async function getStockMovementsByProduct(productId: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId))
    .orderBy(desc(stockMovements.timestamp))
    .limit(limit);
}

// ============= ALERTS =============

export async function getActiveAlerts() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(alerts)
    .where(eq(alerts.status, "ACTIVE"))
    .orderBy(desc(alerts.createdAt));
}

export async function getAlertsByRetailer(retailerId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(alerts)
    .where(eq(alerts.retailerId, retailerId))
    .orderBy(desc(alerts.createdAt));
}

export async function createAlert(data: InsertAlert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(alerts).values(data).returning();
  return row;
}

export async function updateAlertStatus(
  id: string,
  status: "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED",
  userId?: string,
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const updateData: Record<string, unknown> = { status };
  if (status === "ACKNOWLEDGED") {
    updateData.acknowledgedAt = new Date();
    updateData.acknowledgedBy = userId;
  } else if (status === "RESOLVED") {
    updateData.resolvedAt = new Date();
  }

  await db.update(alerts).set(updateData).where(eq(alerts.id, id));
}

// ============= SYNC LOGS =============

export async function createSyncLog(data: InsertSyncLog) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(syncLogs).values(data).returning();
  return row;
}

export async function getSyncLogsByRetailer(retailerId: string, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(syncLogs)
    .where(eq(syncLogs.retailerId, retailerId))
    .orderBy(desc(syncLogs.startedAt))
    .limit(limit);
}

// ============= DASHBOARD STATS =============

const EMPTY_DASHBOARD_STATS = {
  totalRetailers: 0,
  totalProducts: 0,
  activeAlerts: 0,
  totalInventoryValue: "0.00",
  lowStockItems: 0,
  expiringItems: 0,
};

/**
 * Aggregato KPI per la home dashboard. Sostituisce un loop N+1 (13 retailer →
 * getInventoryByRetailer → getProductById per item) con 4 query parallele.
 * Tempo atteso: ~300ms vs ~2s con il pattern vecchio.
 */
export async function getDashboardStats() {
  const t0 = Date.now();
  const db = await getDb();
  if (!db) return EMPTY_DASHBOARD_STATS;

  try {
    const [retailerCountRows, productCountRows, alertCountRows, inventoryRows] =
      await Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(retailers),
        db.select({ c: sql<number>`count(*)::int` }).from(products),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(alerts)
          .where(eq(alerts.status, "ACTIVE")),
        db
          .select({
            quantity: inventory.quantity,
            expirationDate: inventory.expirationDate,
            unitPrice: products.unitPrice,
            minStockThreshold: products.minStockThreshold,
          })
          .from(inventory)
          .innerJoin(products, eq(inventory.productId, products.id)),
      ]);

    let totalInventoryValue = 0;
    let lowStockItems = 0;
    let expiringItems = 0;
    const now = Date.now();
    for (const item of inventoryRows) {
      const price = item.unitPrice ? parseFloat(item.unitPrice) : NaN;
      if (!Number.isNaN(price)) {
        totalInventoryValue += price * item.quantity;
      }
      if (item.quantity < (item.minStockThreshold ?? 10)) {
        lowStockItems++;
      }
      if (item.expirationDate) {
        const days = Math.floor(
          (new Date(item.expirationDate).getTime() - now) / 86_400_000,
        );
        if (days > 0 && days <= 30) expiringItems++;
      }
    }

    const result = {
      totalRetailers: retailerCountRows[0]?.c ?? 0,
      totalProducts: productCountRows[0]?.c ?? 0,
      activeAlerts: alertCountRows[0]?.c ?? 0,
      totalInventoryValue: totalInventoryValue.toFixed(2),
      lowStockItems,
      expiringItems,
    };
    console.log(`[dashboard] getStats ${Date.now() - t0}ms`, {
      retailers: result.totalRetailers,
      products: result.totalProducts,
      alerts: result.activeAlerts,
      inventoryRows: inventoryRows.length,
    });
    return result;
  } catch (error) {
    console.error(
      `[dashboard] getStats failed after ${Date.now() - t0}ms:`,
      error,
    );
    throw error;
  }
}
