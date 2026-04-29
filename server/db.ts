import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  InsertUser,
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
import { ENV } from "./_core/env";

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

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }
    // updatedAt non si aggiorna automaticamente in Postgres: settiamolo esplicitamente.
    updateSet.updatedAt = new Date();

    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
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
