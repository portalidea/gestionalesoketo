import { eq, and, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  users,
  retailers,
  InsertRetailer,
  products,
  InsertProduct,
  stockMovements,
  alerts,
  InsertAlert,
  syncLogs,
  InsertSyncLog,
  // Phase B M1
  producers,
  InsertProducer,
  productBatches,
  ProductBatch,
  locations,
  Location,
  inventoryByBatch,
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
  // Phase B M1: ogni retailer deve avere una location dedicata di tipo
  // 'retailer' per il modello inventoryByBatch. La crea atomicamente
  // contestuale all'INSERT del retailer per non aver mai un retailer
  // senza location.
  await db.insert(locations).values({
    type: "retailer",
    name: row.name,
    retailerId: row.id,
  });
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

/**
 * Conta righe dipendenti per mostrare nel dialog di conferma delete.
 *
 * Phase B M1: il campo `inventory` ora rappresenta i lotti correnti del
 * retailer (`inventoryByBatch` via location), non più la tabella
 * `inventory` legacy. La shape esposta resta la stessa per compatibilità
 * con il dialog frontend.
 */
export async function getRetailerDependentsCount(id: string) {
  const db = await getDb();
  if (!db) return { inventory: 0, stockMovements: 0, alerts: 0, syncLogs: 0 };
  const [inv, mov, alr, syn] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(inventoryByBatch)
      .innerJoin(locations, eq(inventoryByBatch.locationId, locations.id))
      .where(eq(locations.retailerId, id)),
    db.select({ c: sql<number>`count(*)::int` }).from(stockMovements).where(eq(stockMovements.retailerId, id)),
    db.select({ c: sql<number>`count(*)::int` }).from(alerts).where(eq(alerts.retailerId, id)),
    db.select({ c: sql<number>`count(*)::int` }).from(syncLogs).where(eq(syncLogs.retailerId, id)),
  ]);
  return {
    inventory: inv[0]?.c ?? 0,
    stockMovements: mov[0]?.c ?? 0,
    alerts: alr[0]?.c ?? 0,
    syncLogs: syn[0]?.c ?? 0,
  };
}

/**
 * Delete cascade in transaction. Lo schema ha FK reali solo su `locations`
 * (CASCADE) e `inventoryByBatch` (CASCADE via locations). Le altre tabelle
 * applicative non hanno FK a livello DB, quindi vanno pulite app-side.
 *
 * Sequenza:
 *   1. alerts, stockMovements, syncLogs (no FK → DELETE manuale)
 *   2. retailers row → trigger CASCADE elimina locations → CASCADE elimina inventoryByBatch
 */
export async function deleteRetailer(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.transaction(async (tx) => {
    await tx.delete(alerts).where(eq(alerts.retailerId, id));
    await tx.delete(stockMovements).where(eq(stockMovements.retailerId, id));
    await tx.delete(syncLogs).where(eq(syncLogs.retailerId, id));
    await tx.delete(retailers).where(eq(retailers.id, id));
  });
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

// ============= PRODUCERS (Phase B M1) =============

export async function getAllProducers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(producers).orderBy(producers.name);
}

export async function getProducerById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(producers).where(eq(producers.id, id)).limit(1);
  return result[0];
}

export async function createProducer(data: InsertProducer) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(producers).values(data).returning();
  return row;
}

export async function updateProducer(id: string, data: Partial<InsertProducer>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(producers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(producers.id, id));
}

export async function deleteProducer(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // FK productBatches.producerId → ON DELETE SET NULL: i lotti restano,
  // perdono solo il riferimento al produttore.
  await db.delete(producers).where(eq(producers.id, id));
}

// ============= LOCATIONS (Phase B M1) =============

export async function getAllLocations() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(locations).orderBy(locations.type, locations.name);
}

export async function getCentralWarehouseLocation(): Promise<Location | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [row] = await db
    .select()
    .from(locations)
    .where(eq(locations.type, "central_warehouse"))
    .limit(1);
  return row;
}

export async function getRetailerLocation(retailerId: string): Promise<Location | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [row] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.type, "retailer"), eq(locations.retailerId, retailerId)))
    .limit(1);
  return row;
}

// ============= PRODUCT BATCHES (Phase B M1) =============

/**
 * Lista lotti di un prodotto, arricchiti con nome produttore e stock
 * corrente nel magazzino centrale (lookup inventoryByBatch).
 */
export async function getBatchesByProduct(productId: string) {
  const db = await getDb();
  if (!db) return [];

  const warehouse = await getCentralWarehouseLocation();
  if (!warehouse) return [];

  const rows = await db
    .select({
      id: productBatches.id,
      productId: productBatches.productId,
      producerId: productBatches.producerId,
      producerName: producers.name,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      productionDate: productBatches.productionDate,
      initialQuantity: productBatches.initialQuantity,
      notes: productBatches.notes,
      createdAt: productBatches.createdAt,
      centralStock: inventoryByBatch.quantity,
    })
    .from(productBatches)
    .leftJoin(producers, eq(productBatches.producerId, producers.id))
    .leftJoin(
      inventoryByBatch,
      and(
        eq(inventoryByBatch.batchId, productBatches.id),
        eq(inventoryByBatch.locationId, warehouse.id),
      ),
    )
    .where(eq(productBatches.productId, productId))
    .orderBy(productBatches.expirationDate);

  return rows;
}

/**
 * Crea un nuovo lotto + ricezione iniziale al magazzino centrale.
 * Atomico in transaction: productBatch + inventoryByBatch + stockMovement.
 */
export async function createBatchWithReceipt(input: {
  productId: string;
  producerId: string | null;
  batchNumber: string;
  expirationDate: string; // YYYY-MM-DD (date column, no time)
  productionDate: string | null;
  initialQuantity: number;
  notes: string | null;
  createdBy: string;
}): Promise<ProductBatch> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const warehouse = await getCentralWarehouseLocation();
  if (!warehouse) {
    throw new Error("Magazzino centrale non configurato");
  }

  return await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(productBatches)
      .values({
        productId: input.productId,
        producerId: input.producerId,
        batchNumber: input.batchNumber,
        expirationDate: input.expirationDate,
        productionDate: input.productionDate,
        initialQuantity: input.initialQuantity,
        notes: input.notes,
      })
      .returning();

    await tx.insert(inventoryByBatch).values({
      locationId: warehouse.id,
      batchId: batch.id,
      quantity: input.initialQuantity,
    });

    await tx.insert(stockMovements).values({
      productId: input.productId,
      type: "RECEIPT_FROM_PRODUCER",
      quantity: input.initialQuantity,
      newQuantity: input.initialQuantity,
      previousQuantity: 0,
      batchId: batch.id,
      toLocationId: warehouse.id,
      createdBy: input.createdBy,
      notes: input.notes,
    });

    return batch;
  });
}

/**
 * Cancella un lotto solo se "ancora intatto": stock centrale ==
 * initialQuantity AND nessuna riga inventoryByBatch su altre location.
 * Garanzia: il lotto non è mai stato distribuito a un retailer.
 *
 * Atomica in transaction. Cancella anche stockMovements legati al batch
 * (FK SET NULL non basta: vogliamo coerenza storico).
 */
export async function deleteBatchIfFresh(batchId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [batch] = await db.select().from(productBatches).where(eq(productBatches.id, batchId));
  if (!batch) {
    throw new Error("Lotto non trovato");
  }

  const warehouse = await getCentralWarehouseLocation();
  if (!warehouse) {
    throw new Error("Magazzino centrale non configurato");
  }

  const stocks = await db
    .select()
    .from(inventoryByBatch)
    .where(eq(inventoryByBatch.batchId, batchId));

  const central = stocks.find((s) => s.locationId === warehouse.id);
  const others = stocks.filter((s) => s.locationId !== warehouse.id);

  if (others.length > 0 && others.some((s) => s.quantity > 0)) {
    throw new Error(
      "Lotto già distribuito a uno o più rivenditori, eliminazione non consentita",
    );
  }
  if (!central || central.quantity !== batch.initialQuantity) {
    throw new Error(
      "Lotto già parzialmente uscito dal magazzino centrale, eliminazione non consentita",
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(stockMovements).where(eq(stockMovements.batchId, batchId));
    await tx.delete(inventoryByBatch).where(eq(inventoryByBatch.batchId, batchId));
    await tx.delete(productBatches).where(eq(productBatches.id, batchId));
  });
}

// ============= INVENTORY BY BATCH (Phase B M1) =============

/**
 * Inventario per location (warehouse o retailer), arricchito con
 * batch + product + producer info. Usato in /warehouse e
 * RetailerDetail tab Inventario.
 */
export async function getInventoryByLocationId(locationId: string) {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: inventoryByBatch.id,
      locationId: inventoryByBatch.locationId,
      batchId: inventoryByBatch.batchId,
      quantity: inventoryByBatch.quantity,
      updatedAt: inventoryByBatch.updatedAt,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      productionDate: productBatches.productionDate,
      initialQuantity: productBatches.initialQuantity,
      productId: products.id,
      productSku: products.sku,
      productName: products.name,
      productUnit: products.unit,
      productUnitPrice: products.unitPrice,
      productMinStockThreshold: products.minStockThreshold,
      producerId: producers.id,
      producerName: producers.name,
    })
    .from(inventoryByBatch)
    .innerJoin(productBatches, eq(inventoryByBatch.batchId, productBatches.id))
    .innerJoin(products, eq(productBatches.productId, products.id))
    .leftJoin(producers, eq(productBatches.producerId, producers.id))
    .where(eq(inventoryByBatch.locationId, locationId))
    .orderBy(products.name, productBatches.expirationDate);

  return rows;
}

/**
 * Inventario di un retailer (lookup interno della retailer location).
 * Restituisce shape compatibile con il vecchio `getInventoryByRetailer`
 * legacy (campi: id, quantity, expirationDate, batchNumber, product) per
 * consentire al frontend RetailerDetail.tsx di funzionare senza
 * modifiche fino a Step 4.
 */
export async function getInventoryByBatchByRetailer(retailerId: string) {
  const location = await getRetailerLocation(retailerId);
  if (!location) return [];
  const rows = await getInventoryByLocationId(location.id);

  return rows.map((r) => ({
    id: r.id,
    quantity: r.quantity,
    expirationDate: r.expirationDate ? new Date(r.expirationDate) : null,
    batchNumber: r.batchNumber,
    product: {
      id: r.productId,
      sku: r.productSku,
      name: r.productName,
      unit: r.productUnit,
      unitPrice: r.productUnitPrice,
      minStockThreshold: r.productMinStockThreshold,
    },
  }));
}

// ============= WAREHOUSE OVERVIEW (Phase B M1) =============

/**
 * Vista magazzino centrale aggregata per prodotto. Per ogni prodotto:
 *   - stock totale (somma quantity dei lotti del prodotto al warehouse)
 *   - n° lotti attivi (con quantity > 0)
 *   - scadenza più vicina tra i lotti attivi
 *   - lista dei lotti con dettagli
 *
 * Nessun lotto = prodotto omesso dalla vista.
 */
export async function getWarehouseStockOverview() {
  const db = await getDb();
  if (!db) return [];

  const warehouse = await getCentralWarehouseLocation();
  if (!warehouse) return [];

  const rows = await db
    .select({
      productId: products.id,
      productSku: products.sku,
      productName: products.name,
      productCategory: products.category,
      productUnit: products.unit,
      productUnitPrice: products.unitPrice,
      batchId: productBatches.id,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      initialQuantity: productBatches.initialQuantity,
      quantity: inventoryByBatch.quantity,
      producerName: producers.name,
    })
    .from(inventoryByBatch)
    .innerJoin(productBatches, eq(inventoryByBatch.batchId, productBatches.id))
    .innerJoin(products, eq(productBatches.productId, products.id))
    .leftJoin(producers, eq(productBatches.producerId, producers.id))
    .where(eq(inventoryByBatch.locationId, warehouse.id))
    .orderBy(products.name, productBatches.expirationDate);

  // Aggregazione per prodotto
  const byProduct = new Map<
    string,
    {
      productId: string;
      productSku: string;
      productName: string;
      productCategory: string | null;
      productUnit: string | null;
      productUnitPrice: string | null;
      totalStock: number;
      activeBatchCount: number;
      nearestExpiration: string | null;
      batches: Array<{
        batchId: string;
        batchNumber: string;
        expirationDate: string;
        initialQuantity: number;
        quantity: number;
        producerName: string | null;
      }>;
    }
  >();

  for (const r of rows) {
    let entry = byProduct.get(r.productId);
    if (!entry) {
      entry = {
        productId: r.productId,
        productSku: r.productSku,
        productName: r.productName,
        productCategory: r.productCategory,
        productUnit: r.productUnit,
        productUnitPrice: r.productUnitPrice,
        totalStock: 0,
        activeBatchCount: 0,
        nearestExpiration: null,
        batches: [],
      };
      byProduct.set(r.productId, entry);
    }
    entry.totalStock += r.quantity;
    if (r.quantity > 0) entry.activeBatchCount += 1;
    if (
      r.quantity > 0 &&
      (!entry.nearestExpiration || r.expirationDate < entry.nearestExpiration)
    ) {
      entry.nearestExpiration = r.expirationDate;
    }
    entry.batches.push({
      batchId: r.batchId,
      batchNumber: r.batchNumber,
      expirationDate: r.expirationDate,
      initialQuantity: r.initialQuantity,
      quantity: r.quantity,
      producerName: r.producerName,
    });
  }

  return Array.from(byProduct.values()).sort((a, b) =>
    a.productName.localeCompare(b.productName),
  );
}

// ============= STOCK MOVEMENTS =============

/**
 * Storico movimenti di un retailer. Phase B M1: usato in
 * `retailers.getDetails` per la tab Movimenti (read-only). I tipi
 * `IN/OUT/ADJUSTMENT` sono legacy; il nuovo modello userà
 * TRANSFER/RETAIL_OUT (M2). RECEIPT_FROM_PRODUCER non riguarda i
 * retailer (è warehouse-only) quindi non comparirà qui.
 */
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
 * Aggregato KPI per la home dashboard.
 *
 * Phase B M1: rifatto sul nuovo modello (`inventoryByBatch` + `productBatches`),
 * mantenendo la stessa shape esterna. Il join è ristretto alle location di
 * tipo 'retailer' (escludo magazzino centrale dal "valore inventario in giro
 * per i rivenditori"). lowStockItems aggrega per (locationId, productId): un
 * prodotto è "scorta bassa" presso un retailer se la SOMMA delle quantity
 * di tutti i suoi lotti su quella location è sotto threshold.
 *
 * 4 query parallele per mantenere la perf cold ~200-300ms.
 */
export async function getDashboardStats() {
  const db = await getDb();
  if (!db) return EMPTY_DASHBOARD_STATS;

  try {
    const [retailerCountRows, productCountRows, alertCountRows, batchInventoryRows] =
      await Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(retailers),
        db.select({ c: sql<number>`count(*)::int` }).from(products),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(alerts)
          .where(eq(alerts.status, "ACTIVE")),
        db
          .select({
            locationId: inventoryByBatch.locationId,
            productId: productBatches.productId,
            quantity: inventoryByBatch.quantity,
            expirationDate: productBatches.expirationDate,
            unitPrice: products.unitPrice,
            minStockThreshold: products.minStockThreshold,
            locationType: locations.type,
          })
          .from(inventoryByBatch)
          .innerJoin(productBatches, eq(inventoryByBatch.batchId, productBatches.id))
          .innerJoin(products, eq(productBatches.productId, products.id))
          .innerJoin(locations, eq(inventoryByBatch.locationId, locations.id))
          .where(eq(locations.type, "retailer")),
      ]);

    let totalInventoryValue = 0;
    let expiringItems = 0;
    const now = Date.now();

    // Aggrega per (location, product) per low stock
    const stockByPair = new Map<string, { qty: number; threshold: number }>();

    for (const item of batchInventoryRows) {
      const price = item.unitPrice ? parseFloat(item.unitPrice) : NaN;
      if (!Number.isNaN(price)) {
        totalInventoryValue += price * item.quantity;
      }
      if (item.expirationDate) {
        const days = Math.floor(
          (new Date(item.expirationDate).getTime() - now) / 86_400_000,
        );
        if (days > 0 && days <= 30 && item.quantity > 0) expiringItems++;
      }
      const key = `${item.locationId}::${item.productId}`;
      const cur = stockByPair.get(key);
      const threshold = item.minStockThreshold ?? 10;
      if (cur) {
        cur.qty += item.quantity;
      } else {
        stockByPair.set(key, { qty: item.quantity, threshold });
      }
    }

    let lowStockItems = 0;
    for (const v of Array.from(stockByPair.values())) {
      if (v.qty < v.threshold) lowStockItems++;
    }

    return {
      totalRetailers: retailerCountRows[0]?.c ?? 0,
      totalProducts: productCountRows[0]?.c ?? 0,
      activeAlerts: alertCountRows[0]?.c ?? 0,
      totalInventoryValue: totalInventoryValue.toFixed(2),
      lowStockItems,
      expiringItems,
    };
  } catch (error) {
    console.error("[dashboard] getStats failed:", error);
    throw error;
  }
}

