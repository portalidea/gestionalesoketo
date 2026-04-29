import { eq, and, desc } from "drizzle-orm";
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
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _client = postgres(process.env.DATABASE_URL, {
        prepare: false, // pgbouncer (Supabase pooler) compat
        max: 1,
      });
      _db = drizzle(_client);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
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
