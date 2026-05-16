import { eq, and, or, desc, gte, lte, ilike, inArray, sql, type SQL } from "drizzle-orm";
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
  // Phase B M5.5
  productSupplierCodes,
  InsertProductSupplierCode,
  // Phase B M3
  pricingPackages,
  PricingPackage,
  InsertPricingPackage,
  systemIntegrations,
  SystemIntegration,
  InsertSystemIntegration,
  proformaQueue,
  ProformaQueue,
  InsertProformaQueue,
  // Phase B M6.1
  orders,
  Order,
  orderItems,
  OrderItem,
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
  // Phase B M2.5: arricchito con stats per la vista tabellare /retailers.
  // Lookup retailer location implicito via locations.retailerId =
  // retailers.id.
  // NOTA: literal "retailers"."id" qualificato — vedi nota in
  // getAllProducts. Bug M2.5.1: drizzle non qualifica `${retailers.id}`
  // → ambiguous con altre colonne id nelle subquery.
  const activeBatchCountExpr = sql<number>`COALESCE((
    SELECT COUNT(*)::int
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    WHERE l."retailerId" = "retailers"."id"
      AND ibb."quantity" > 0
  ), 0)`;
  const totalStockExpr = sql<number>`COALESCE((
    SELECT SUM(ibb."quantity")::int
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    WHERE l."retailerId" = "retailers"."id"
  ), 0)`;
  // unitPrice è varchar, cast a numeric per calcolo valore (NaN safe via
  // NULLIF sull'empty string).
  const inventoryValueExpr = sql<string>`COALESCE((
    SELECT SUM(ibb."quantity" * NULLIF(p."unitPrice", '')::numeric)::numeric(18,2)
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
    INNER JOIN "products" p ON p."id" = pb."productId"
    WHERE l."retailerId" = "retailers"."id"
  ), 0)::text`;

  return db
    .select({
      id: retailers.id,
      name: retailers.name,
      businessType: retailers.businessType,
      address: retailers.address,
      city: retailers.city,
      province: retailers.province,
      postalCode: retailers.postalCode,
      phone: retailers.phone,
      email: retailers.email,
      contactPerson: retailers.contactPerson,
      fattureInCloudCompanyId: retailers.fattureInCloudCompanyId,
      fattureInCloudAccessToken: retailers.fattureInCloudAccessToken,
      fattureInCloudRefreshToken: retailers.fattureInCloudRefreshToken,
      fattureInCloudTokenExpiresAt: retailers.fattureInCloudTokenExpiresAt,
      lastSyncAt: retailers.lastSyncAt,
      syncEnabled: retailers.syncEnabled,
      notes: retailers.notes,
      pricingPackageId: retailers.pricingPackageId,
      ficClientId: retailers.ficClientId,
      createdAt: retailers.createdAt,
      updatedAt: retailers.updatedAt,
      activeBatchCount: activeBatchCountExpr,
      totalStock: totalStockExpr,
      inventoryValue: inventoryValueExpr,
    })
    .from(retailers)
    .orderBy(retailers.name);
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
  // Phase B M2.5: arricchito con campi calcolati per la vista tabellare
  // /products. Subquery aggregate per ogni prodotto. Pattern accettabile
  // per cataloghi dell'ordine di decine di righe; se cresce molto, da
  // refactorare in CTE singola query.
  // NOTA: usiamo "products"."id" (literal qualificato) invece di
  // `${products.id}` perché drizzle, su query outer single-FROM, emette
  // solo "id" non qualificato → ambiguous nelle subquery che hanno
  // altre colonne id (inventoryByBatch.id, productBatches.id,
  // locations.id). Bug M2.5.1.
  const centralStockExpr = sql<number>`COALESCE((
    SELECT SUM(ibb."quantity")::int
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
    WHERE pb."productId" = "products"."id"
      AND l."type" = 'central_warehouse'
  ), 0)`;
  const totalStockExpr = sql<number>`COALESCE((
    SELECT SUM(ibb."quantity")::int
    FROM "inventoryByBatch" ibb
    INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
    WHERE pb."productId" = "products"."id"
  ), 0)`;
  const batchCountExpr = sql<number>`COALESCE((
    SELECT COUNT(*)::int
    FROM "inventoryByBatch" ibb
    INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
    WHERE pb."productId" = "products"."id"
      AND ibb."quantity" > 0
  ), 0)`;
  const nearestExpirationExpr = sql<string | null>`(
    SELECT MIN(pb."expirationDate")::text
    FROM "productBatches" pb
    INNER JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb."id"
    WHERE pb."productId" = "products"."id"
      AND ibb."quantity" > 0
  )`;

  return db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      description: products.description,
      category: products.category,
      isLowCarb: products.isLowCarb,
      isGlutenFree: products.isGlutenFree,
      isKeto: products.isKeto,
      sugarContent: products.sugarContent,
      supplierId: products.supplierId,
      supplierName: products.supplierName,
      unitPrice: products.unitPrice,
      unit: products.unit,
      minStockThreshold: products.minStockThreshold,
      expiryWarningDays: products.expiryWarningDays,
      imageUrl: products.imageUrl,
      vatRate: products.vatRate,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
      centralStock: centralStockExpr,
      totalStock: totalStockExpr,
      activeBatchCount: batchCountExpr,
      nearestExpiration: nearestExpirationExpr,
    })
    .from(products)
    .orderBy(products.name);
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

/**
 * M5.5: Crea prodotto con codici fornitore e lotto iniziale opzionale.
 * Tutto in una sola transazione atomica.
 */
export async function createProductExtended(input: {
  productData: InsertProduct;
  supplierCodes: { producerId: string; supplierCode: string }[];
  initialBatch?: {
    batchNumber: string;
    expirationDate: string;
    quantity: number;
    locationId: string;
    producerId: string;
  };
  createdBy: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.transaction(async (tx) => {
    // 1. Create product
    const [product] = await tx.insert(products).values(input.productData).returning();

    // 2. Create supplier codes
    if (input.supplierCodes.length > 0) {
      await tx.insert(productSupplierCodes).values(
        input.supplierCodes.map((sc) => ({
          productId: product.id,
          producerId: sc.producerId,
          supplierCode: sc.supplierCode,
        })),
      );
    }

    // 3. Create initial batch + inventory + movement
    if (input.initialBatch) {
      const ib = input.initialBatch;
      const [batch] = await tx
        .insert(productBatches)
        .values({
          productId: product.id,
          producerId: ib.producerId,
          batchNumber: ib.batchNumber,
          expirationDate: ib.expirationDate,
          initialQuantity: ib.quantity,
          notes: "Lotto iniziale aggiunto in creazione prodotto",
        })
        .returning();

      await tx.insert(inventoryByBatch).values({
        locationId: ib.locationId,
        batchId: batch.id,
        quantity: ib.quantity,
      });

      await tx.insert(stockMovements).values({
        productId: product.id,
        type: "RECEIPT_FROM_PRODUCER",
        quantity: ib.quantity,
        newQuantity: ib.quantity,
        previousQuantity: 0,
        batchId: batch.id,
        toLocationId: ib.locationId,
        createdBy: input.createdBy,
        notesInternal: "Lotto iniziale aggiunto in creazione prodotto",
      });
    }

    return product;
  });
}

// ============= PRODUCT SUPPLIER CODES (M5.5) =============

export async function getSupplierCodesByProduct(productId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: productSupplierCodes.id,
      productId: productSupplierCodes.productId,
      producerId: productSupplierCodes.producerId,
      producerName: producers.name,
      supplierCode: productSupplierCodes.supplierCode,
      createdAt: productSupplierCodes.createdAt,
    })
    .from(productSupplierCodes)
    .leftJoin(producers, eq(productSupplierCodes.producerId, producers.id))
    .where(eq(productSupplierCodes.productId, productId))
    .orderBy(productSupplierCodes.createdAt);
}

export async function addSupplierCode(data: {
  productId: string;
  producerId: string;
  supplierCode: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(productSupplierCodes).values(data).returning();
  return row;
}

export async function removeSupplierCode(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(productSupplierCodes).where(eq(productSupplierCodes.id, id));
}

/**
 * M5.5: Cerca match per codice fornitore in product_supplier_codes.
 * Usato dal DDT import per match prioritario prima del fuzzy match.
 */
export async function findProductBySupplierCode(
  supplierCode: string,
  producerId: string,
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ productId: productSupplierCodes.productId })
    .from(productSupplierCodes)
    .where(
      and(
        eq(productSupplierCodes.supplierCode, supplierCode),
        eq(productSupplierCodes.producerId, producerId),
      ),
    )
    .limit(1);
  return row?.productId ?? null;
}

// ============= PRODUCERS (Phase B M1) =============

export async function getAllProducers() {
  const db = await getDb();
  if (!db) return [];
  // Phase B M2.5: count lotti totali (anche scaricati a 0) per la
  // vista tabellare /producers.
  // NOTA: literal "producers"."id" qualificato — vedi nota in
  // getAllProducts (bug M2.5.1).
  const batchCountExpr = sql<number>`COALESCE((
    SELECT COUNT(*)::int
    FROM "productBatches" pb
    WHERE pb."producerId" = "producers"."id"
  ), 0)`;
  return db
    .select({
      id: producers.id,
      name: producers.name,
      contactName: producers.contactName,
      email: producers.email,
      phone: producers.phone,
      address: producers.address,
      vatNumber: producers.vatNumber,
      notes: producers.notes,
      createdAt: producers.createdAt,
      updatedAt: producers.updatedAt,
      batchCount: batchCountExpr,
    })
    .from(producers)
    .orderBy(producers.name);
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

  const retailerStockExpr = sql<number>`COALESCE((
    SELECT SUM(ibb."quantity")::int
    FROM "inventoryByBatch" ibb
    INNER JOIN "locations" l ON l."id" = ibb."locationId"
    WHERE ibb."batchId" = ${productBatches.id}
      AND l."type" = 'retailer'
  ), 0)`;

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
      retailerStock: retailerStockExpr,
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

/**
 * Phase B M2: lotti del prodotto disponibili al magazzino centrale per
 * un trasferimento, ordinati FEFO (First Expired First Out).
 *
 * Returns: solo lotti con `centralStock > 0`, ordinati per
 * `expirationDate ASC`. La UI usa il primo come default suggerimento.
 */
export async function getBatchesAvailableForTransfer(productId: string) {
  const db = await getDb();
  if (!db) return [];

  const warehouse = await getCentralWarehouseLocation();
  if (!warehouse) return [];

  const rows = await db
    .select({
      batchId: productBatches.id,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      productionDate: productBatches.productionDate,
      initialQuantity: productBatches.initialQuantity,
      centralStock: inventoryByBatch.quantity,
      producerId: productBatches.producerId,
      producerName: producers.name,
    })
    .from(productBatches)
    .innerJoin(
      inventoryByBatch,
      and(
        eq(inventoryByBatch.batchId, productBatches.id),
        eq(inventoryByBatch.locationId, warehouse.id),
      ),
    )
    .leftJoin(producers, eq(productBatches.producerId, producers.id))
    .where(
      and(
        eq(productBatches.productId, productId),
        sql`${inventoryByBatch.quantity} > 0`,
      ),
    )
    .orderBy(productBatches.expirationDate);

  return rows;
}

/**
 * Phase B M2: trasferimento atomico magazzino centrale → retailer.
 *
 * Transaction:
 *   1. SELECT FOR UPDATE su inventoryByBatch(central, batch) → currQty
 *   2. Verifica currQty >= quantity (else throw)
 *   3. UPDATE inventoryByBatch(central, batch): qty -= quantity
 *   4. UPSERT inventoryByBatch(retailer location, batch): qty += quantity
 *   5. INSERT stockMovements TRANSFER con batchId / from / to / qty +
 *      notesInternal "Trasferito {batchNumber} ×{qty} → {retailerName}"
 */
export async function transferBatchToRetailer(input: {
  productId: string;
  batchId: string;
  retailerId: string;
  quantity: number;
  notes: string | null;
  createdBy: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const warehouse = await getCentralWarehouseLocation();
  if (!warehouse) throw new Error("Magazzino centrale non configurato");

  const retailerLoc = await getRetailerLocation(input.retailerId);
  if (!retailerLoc) throw new Error("Rivenditore senza location associata");

  return await db.transaction(async (tx) => {
    // Lock + read central stock
    const centralRows = await tx
      .select()
      .from(inventoryByBatch)
      .where(
        and(
          eq(inventoryByBatch.locationId, warehouse.id),
          eq(inventoryByBatch.batchId, input.batchId),
        ),
      )
      .for("update");

    const central = centralRows[0];
    if (!central || central.quantity < input.quantity) {
      throw new Error(
        `Stock centrale insufficiente: disponibili ${central?.quantity ?? 0}, richiesti ${input.quantity}`,
      );
    }

    // Decrementa centrale
    await tx
      .update(inventoryByBatch)
      .set({ quantity: central.quantity - input.quantity, updatedAt: new Date() })
      .where(eq(inventoryByBatch.id, central.id));

    // Upsert retailer
    const retailerRows = await tx
      .select()
      .from(inventoryByBatch)
      .where(
        and(
          eq(inventoryByBatch.locationId, retailerLoc.id),
          eq(inventoryByBatch.batchId, input.batchId),
        ),
      )
      .for("update");
    const existing = retailerRows[0];
    if (existing) {
      await tx
        .update(inventoryByBatch)
        .set({
          quantity: existing.quantity + input.quantity,
          updatedAt: new Date(),
        })
        .where(eq(inventoryByBatch.id, existing.id));
    } else {
      await tx.insert(inventoryByBatch).values({
        locationId: retailerLoc.id,
        batchId: input.batchId,
        quantity: input.quantity,
      });
    }

    // Lookup batch + retailer per audit. Guard esplicito su batch:
    // se non esiste, transaction rollback e throw chiaro.
    const [batch] = await tx
      .select({
        batchNumber: productBatches.batchNumber,
        productId: productBatches.productId,
      })
      .from(productBatches)
      .where(eq(productBatches.id, input.batchId));
    if (!batch) {
      throw new Error(`Lotto ${input.batchId} non trovato`);
    }
    const [retailer] = await tx
      .select({ name: retailers.name })
      .from(retailers)
      .where(eq(retailers.id, input.retailerId));

    const auditNote = `Trasferito lotto ${batch.batchNumber} ×${input.quantity} → ${retailer?.name ?? "?"}`;

    // Log movimento. Usiamo `batch.productId` come fonte di verità
    // (FK certificata) anziché `input.productId` per evitare incoerenze
    // se il caller passasse un productId sbagliato.
    const [movement] = await tx
      .insert(stockMovements)
      .values({
        productId: batch.productId,
        type: "TRANSFER",
        quantity: input.quantity,
        previousQuantity: central.quantity,
        newQuantity: central.quantity - input.quantity,
        retailerId: input.retailerId,
        batchId: input.batchId,
        fromLocationId: warehouse.id,
        toLocationId: retailerLoc.id,
        notes: input.notes,
        notesInternal: auditNote,
        createdBy: input.createdBy,
      })
      .returning();

    return movement;
  });
}

/**
 * Phase B M2: write-off lotto scaduto / non più vendibile.
 *
 * Atomico: decrementa stock e logga EXPIRY_WRITE_OFF. Funziona sia su
 * location centrale (warehouse) sia su location retailer.
 */
export async function expiryWriteOff(input: {
  batchId: string;
  locationId: string;
  quantity: number;
  notes: string | null;
  createdBy: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.transaction(async (tx) => {
    const stockRows = await tx
      .select()
      .from(inventoryByBatch)
      .where(
        and(
          eq(inventoryByBatch.locationId, input.locationId),
          eq(inventoryByBatch.batchId, input.batchId),
        ),
      )
      .for("update");

    const stock = stockRows[0];
    if (!stock || stock.quantity < input.quantity) {
      throw new Error(
        `Stock insufficiente: disponibili ${stock?.quantity ?? 0}, richiesti ${input.quantity}`,
      );
    }

    await tx
      .update(inventoryByBatch)
      .set({ quantity: stock.quantity - input.quantity, updatedAt: new Date() })
      .where(eq(inventoryByBatch.id, stock.id));

    // Lookup batch + location per audit + productId NOT NULL su stockMovements.
    // Guard esplicito: se batch non esiste, transaction rollback e throw chiaro
    // (non popoliamo productId con valori "fallback" che farebbero record orphan).
    const [batch] = await tx
      .select({
        batchNumber: productBatches.batchNumber,
        productId: productBatches.productId,
        expirationDate: productBatches.expirationDate,
      })
      .from(productBatches)
      .where(eq(productBatches.id, input.batchId));
    if (!batch) {
      throw new Error(`Lotto ${input.batchId} non trovato`);
    }
    const [loc] = await tx
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, input.locationId));

    const auditNote = `Scarto lotto ${batch.batchNumber} (scad ${batch.expirationDate}) ×${input.quantity} da ${loc?.name ?? "?"}`;

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        productId: batch.productId,
        type: "EXPIRY_WRITE_OFF",
        quantity: input.quantity,
        previousQuantity: stock.quantity,
        newQuantity: stock.quantity - input.quantity,
        batchId: input.batchId,
        fromLocationId: input.locationId,
        notes: input.notes,
        notesInternal: auditNote,
        createdBy: input.createdBy,
      })
      .returning();

    return movement;
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
 *
 * Phase B M2: shape estesa con `batchId`, `locationId`, `producerName` per
 * supportare in UI azione "Scarta" (EXPIRY_WRITE_OFF) e raggruppamento
 * per prodotto con espansione per lotto. Mantiene i campi legacy
 * (`expirationDate` come Date object, `batchNumber`, `product.*`)
 * per la shape già usata da RetailerDetail.tsx.
 */
export async function getInventoryByBatchByRetailer(retailerId: string) {
  const location = await getRetailerLocation(retailerId);
  if (!location) return [];
  const rows = await getInventoryByLocationId(location.id);

  return rows.map((r) => ({
    id: r.id,
    locationId: r.locationId,
    batchId: r.batchId,
    quantity: r.quantity,
    expirationDate: r.expirationDate ? new Date(r.expirationDate) : null,
    batchNumber: r.batchNumber,
    producerName: r.producerName,
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
      piecesPerUnit: products.piecesPerUnit,
      sellableUnitLabel: products.sellableUnitLabel,
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
      piecesPerUnit: number | null;
      sellableUnitLabel: string | null;
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
        piecesPerUnit: r.piecesPerUnit,
        sellableUnitLabel: r.sellableUnitLabel,
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
 * Phase B M2: helper interno che restituisce i movimenti che
 * intercettano una specifica location, joinati con product/batch/loc.
 *
 * Filtro: `fromLocationId = loc OR toLocationId = loc`. Inclusivo di
 * TRANSFER (in entrata o uscita), EXPIRY_WRITE_OFF, e in futuro
 * RETAIL_OUT (M4) e altri.
 */
export async function getStockMovementsByLocationId(
  locationId: string,
  limit = 100,
) {
  const db = await getDb();
  if (!db) return [];

  const fromLoc = sql<string>`from_loc.name`.as("fromLocationName");
  const toLoc = sql<string>`to_loc.name`.as("toLocationName");

  return db
    .select({
      id: stockMovements.id,
      type: stockMovements.type,
      quantity: stockMovements.quantity,
      previousQuantity: stockMovements.previousQuantity,
      newQuantity: stockMovements.newQuantity,
      timestamp: stockMovements.timestamp,
      notes: stockMovements.notes,
      notesInternal: stockMovements.notesInternal,
      productId: products.id,
      productSku: products.sku,
      productName: products.name,
      batchId: productBatches.id,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      fromLocationId: stockMovements.fromLocationId,
      toLocationId: stockMovements.toLocationId,
      fromLocationName: sql<string | null>`from_loc.name`,
      toLocationName: sql<string | null>`to_loc.name`,
      ficProformaId: stockMovements.ficProformaId,
      ficProformaNumber: stockMovements.ficProformaNumber,
    })
    .from(stockMovements)
    .leftJoin(products, eq(stockMovements.productId, products.id))
    .leftJoin(productBatches, eq(stockMovements.batchId, productBatches.id))
    .leftJoin(
      sql`${locations} AS from_loc`,
      sql`from_loc.id = ${stockMovements.fromLocationId}`,
    )
    .leftJoin(
      sql`${locations} AS to_loc`,
      sql`to_loc.id = ${stockMovements.toLocationId}`,
    )
    .where(
      or(
        eq(stockMovements.fromLocationId, locationId),
        eq(stockMovements.toLocationId, locationId),
      ),
    )
    .orderBy(desc(stockMovements.timestamp))
    .limit(limit);
}

/**
 * Phase B M2.5: lista globale movimenti con filtri opzionali e
 * paginazione. Usata da `/movements`.
 *
 * Filtri supportati:
 *   - type:        single value enum
 *   - locationId:  movimenti dove from o to = locationId
 *   - batchSearch: ILIKE %x% su productBatches.batchNumber
 *   - startDate / endDate: range su stockMovements.timestamp
 *
 * Returns: { items: [...enriched...], total: number } per
 * paginazione client-side.
 */
export async function getStockMovementsAll(filters: {
  type?:
    | "IN"
    | "OUT"
    | "ADJUSTMENT"
    | "RECEIPT_FROM_PRODUCER"
    | "TRANSFER"
    | "EXPIRY_WRITE_OFF";
  locationId?: string;
  batchSearch?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
  offset: number;
}): Promise<{
  items: Awaited<ReturnType<typeof getStockMovementsByLocationId>>;
  total: number;
}> {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };

  const conditions: SQL[] = [];
  if (filters.type) conditions.push(eq(stockMovements.type, filters.type));
  if (filters.locationId) {
    const locOr = or(
      eq(stockMovements.fromLocationId, filters.locationId),
      eq(stockMovements.toLocationId, filters.locationId),
    );
    if (locOr) conditions.push(locOr);
  }
  if (filters.batchSearch && filters.batchSearch.trim().length > 0) {
    conditions.push(
      ilike(productBatches.batchNumber, `%${filters.batchSearch.trim()}%`),
    );
  }
  if (filters.startDate) {
    conditions.push(gte(stockMovements.timestamp, new Date(filters.startDate)));
  }
  if (filters.endDate) {
    // Includi tutto il giorno endDate
    const end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);
    conditions.push(lte(stockMovements.timestamp, end));
  }
  const whereExpr = conditions.length > 0 ? and(...conditions) : undefined;

  // Items: stessa shape di getStockMovementsByLocationId
  const items = await db
    .select({
      id: stockMovements.id,
      type: stockMovements.type,
      quantity: stockMovements.quantity,
      previousQuantity: stockMovements.previousQuantity,
      newQuantity: stockMovements.newQuantity,
      timestamp: stockMovements.timestamp,
      notes: stockMovements.notes,
      notesInternal: stockMovements.notesInternal,
      productId: products.id,
      productSku: products.sku,
      productName: products.name,
      batchId: productBatches.id,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      fromLocationId: stockMovements.fromLocationId,
      toLocationId: stockMovements.toLocationId,
      fromLocationName: sql<string | null>`from_loc.name`,
      toLocationName: sql<string | null>`to_loc.name`,
      ficProformaId: stockMovements.ficProformaId,
      ficProformaNumber: stockMovements.ficProformaNumber,
    })
    .from(stockMovements)
    .leftJoin(products, eq(stockMovements.productId, products.id))
    .leftJoin(productBatches, eq(stockMovements.batchId, productBatches.id))
    .leftJoin(
      sql`${locations} AS from_loc`,
      sql`from_loc.id = ${stockMovements.fromLocationId}`,
    )
    .leftJoin(
      sql`${locations} AS to_loc`,
      sql`to_loc.id = ${stockMovements.toLocationId}`,
    )
    .where(whereExpr)
    .orderBy(desc(stockMovements.timestamp))
    .limit(filters.limit)
    .offset(filters.offset);

  // Count totale per paginazione (stesso WHERE, niente JOIN su locations
  // ma il join su productBatches serve per il filtro batchSearch)
  const countRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(stockMovements)
    .leftJoin(productBatches, eq(stockMovements.batchId, productBatches.id))
    .where(whereExpr);

  return { items, total: countRows[0]?.c ?? 0 };
}

/**
 * Storico movimenti di un retailer (lookup interno della retailer
 * location).
 *
 * Phase B M1 → M2: refactor da query su legacy `retailerId` field a
 * query location-based. Mantiene la stessa shape di output ma ora
 * include movements di tipo TRANSFER (in entrata) e in futuro
 * RETAIL_OUT (M4) tramite from/toLocationId.
 *
 * Fallback per movements legacy con `retailerId` popolato e
 * `from/toLocationId` NULL: include anche quelli.
 */
export async function getStockMovementsByRetailer(retailerId: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];

  const retailerLoc = await getRetailerLocation(retailerId);
  if (!retailerLoc) return [];

  return db
    .select({
      id: stockMovements.id,
      type: stockMovements.type,
      quantity: stockMovements.quantity,
      previousQuantity: stockMovements.previousQuantity,
      newQuantity: stockMovements.newQuantity,
      timestamp: stockMovements.timestamp,
      notes: stockMovements.notes,
      notesInternal: stockMovements.notesInternal,
      productId: products.id,
      productSku: products.sku,
      productName: products.name,
      batchId: productBatches.id,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      fromLocationId: stockMovements.fromLocationId,
      toLocationId: stockMovements.toLocationId,
      fromLocationName: sql<string | null>`from_loc.name`,
      toLocationName: sql<string | null>`to_loc.name`,
      ficProformaId: stockMovements.ficProformaId,
      ficProformaNumber: stockMovements.ficProformaNumber,
    })
    .from(stockMovements)
    .leftJoin(products, eq(stockMovements.productId, products.id))
    .leftJoin(productBatches, eq(stockMovements.batchId, productBatches.id))
    .leftJoin(
      sql`${locations} AS from_loc`,
      sql`from_loc.id = ${stockMovements.fromLocationId}`,
    )
    .leftJoin(
      sql`${locations} AS to_loc`,
      sql`to_loc.id = ${stockMovements.toLocationId}`,
    )
    .where(
      or(
        eq(stockMovements.fromLocationId, retailerLoc.id),
        eq(stockMovements.toLocationId, retailerLoc.id),
        eq(stockMovements.retailerId, retailerId),
      ),
    )
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
// In-memory cache per query aggregate dashboard (TTL 2 min)
const _dashboardCache = new Map<string, { data: unknown; expiresAt: number }>();
function cachedDashboard<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const cached = _dashboardCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[dashboardCache] HIT ${key}`);
    return Promise.resolve(cached.data as T);
  }
  console.log(`[dashboardCache] MISS ${key}`);
  return fetcher().then((data) => {
    _dashboardCache.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  });
}
const CACHE_TTL = 2 * 60 * 1000; // 2 min

export function getDashboardStats() {
  return cachedDashboard("stats", CACHE_TTL, _getDashboardStatsImpl);
}
async function _getDashboardStatsImpl() {
  const db = await getDb();
  if (!db) return EMPTY_DASHBOARD_STATS;

  try {
    console.time("[getDashboardStats] counts");
    const [retailerCountRows, productCountRows, alertCountRows] =
      await Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(retailers),
        db.select({ c: sql<number>`count(*)::int` }).from(products),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(alerts)
          .where(eq(alerts.status, "ACTIVE")),
      ]);
    console.timeEnd("[getDashboardStats] counts");

    // Singola query aggregata SQL per inventoryValue, lowStock, expiring
    // Evita fetch di tutte le righe inventoryByBatch + loop JS
    console.time("[getDashboardStats] inventory-aggregate");
    const aggRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(ibb."quantity" * p."unitPrice"::numeric), 0)::text AS "totalValue",
        COUNT(DISTINCT CASE
          WHEN pb."expirationDate" IS NOT NULL
            AND (pb."expirationDate"::date - CURRENT_DATE) BETWEEN 1 AND 30
            AND ibb."quantity" > 0
          THEN pb."id"
        END)::int AS "expiringItems"
      FROM "inventoryByBatch" ibb
      INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
      INNER JOIN "products" p ON p."id" = pb."productId"
      INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'retailer'
    `);
    console.timeEnd("[getDashboardStats] inventory-aggregate");

    console.time("[getDashboardStats] low-stock");
    const lowStockRows = await db.execute(sql`
      SELECT COUNT(*)::int AS "cnt"
      FROM (
        SELECT ibb."locationId", pb."productId",
          SUM(ibb."quantity") AS total_qty,
          MAX(p."minStockThreshold") AS threshold
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'retailer'
        WHERE p."minStockThreshold" IS NOT NULL AND p."minStockThreshold" > 0
        GROUP BY ibb."locationId", pb."productId"
        HAVING SUM(ibb."quantity") < MAX(p."minStockThreshold")
      ) sub
    `);
    console.timeEnd("[getDashboardStats] low-stock");

    const agg = (aggRows as unknown as Array<{ totalValue: string; expiringItems: number }>)[0];
    const lowStock = (lowStockRows as unknown as Array<{ cnt: number }>)[0];

    return {
      totalRetailers: retailerCountRows[0]?.c ?? 0,
      totalProducts: productCountRows[0]?.c ?? 0,
      activeAlerts: alertCountRows[0]?.c ?? 0,
      totalInventoryValue: parseFloat(agg?.totalValue ?? "0").toFixed(2),
      lowStockItems: lowStock?.cnt ?? 0,
      expiringItems: agg?.expiringItems ?? 0,
    };
  } catch (error) {
    console.error("[dashboard] getStats failed:", error);
    throw error;
  }
}

/**
 * Phase B M3: lookup minimale di un batch per arricchire descrizione
 * proforma e audit trail. Ritorna solo i campi user-facing (batchNumber +
 * expirationDate string YYYY-MM-DD).
 */
export async function getBatchByIdMinimal(
  batchId: string,
): Promise<{ batchNumber: string; expirationDate: string } | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db
    .select({
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
    })
    .from(productBatches)
    .where(eq(productBatches.id, batchId))
    .limit(1);
  return r[0];
}

// ============= PRICING PACKAGES (Phase B M3) =============

export async function getAllPricingPackages(): Promise<PricingPackage[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pricingPackages).orderBy(pricingPackages.sortOrder);
}

export async function getPricingPackageById(id: string): Promise<PricingPackage | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(pricingPackages).where(eq(pricingPackages.id, id)).limit(1);
  return r[0];
}

export async function createPricingPackage(data: InsertPricingPackage): Promise<PricingPackage> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.insert(pricingPackages).values(data).returning();
  return row;
}

export async function updatePricingPackage(
  id: string,
  data: Partial<InsertPricingPackage>,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(pricingPackages)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(pricingPackages.id, id));
}

export async function deletePricingPackage(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // ON DELETE SET NULL su retailers.pricingPackageId: i retailer associati
  // restano senza pacchetto e dovranno riassegnare prima del prossimo proforma.
  await db.delete(pricingPackages).where(eq(pricingPackages.id, id));
}

export async function assignPackageToRetailer(
  retailerId: string,
  packageId: string | null,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(retailers)
    .set({ pricingPackageId: packageId, updatedAt: new Date() })
    .where(eq(retailers.id, retailerId));
}

export async function assignFicClientToRetailer(
  retailerId: string,
  ficClientId: number | null,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(retailers)
    .set({ ficClientId, updatedAt: new Date() })
    .where(eq(retailers.id, retailerId));
}

/**
 * Calcola anteprima prezzi proforma per un retailer.
 *
 * Server-side authoritative: tutta la math gira qui, frontend solo display.
 * Arrotondamenti a 2 decimali per ogni linea (coerenza FiC); i totali
 * sommano linee già arrotondate.
 *
 * Throw esplicito (con messaggi user-facing in italiano) sui casi:
 * - retailer senza pacchetto → PRECONDITION
 * - prodotto inesistente → riferimento sbagliato dal caller
 * - prodotto senza unitPrice valorizzato → impossibile calcolare
 */
export async function calculatePricingForRetailer(input: {
  retailerId: string;
  items: Array<{ productId: string; qty: number }>;
}): Promise<{
  items: Array<{
    productId: string;
    productSku: string;
    productName: string;
    qty: number;
    unitPriceBase: string;
    discountPercent: string;
    unitPriceFinal: string;
    vatRate: string;
    lineTotalNet: string;
    lineTotalGross: string;
  }>;
  subtotalNet: string;
  vatAmount: string;
  total: string;
  packageId: string;
  packageName: string;
  packageDiscount: string;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [retailer] = await db
    .select()
    .from(retailers)
    .where(eq(retailers.id, input.retailerId))
    .limit(1);
  if (!retailer) throw new Error("Rivenditore non trovato");
  if (!retailer.pricingPackageId) {
    throw new Error("Rivenditore senza pacchetto commerciale assegnato");
  }

  const [pkg] = await db
    .select()
    .from(pricingPackages)
    .where(eq(pricingPackages.id, retailer.pricingPackageId))
    .limit(1);
  if (!pkg) throw new Error("Pacchetto commerciale del rivenditore non trovato");

  const productIds = Array.from(new Set(input.items.map((i) => i.productId)));
  if (productIds.length === 0) throw new Error("Nessun prodotto da quotare");
  const prodRows = await db
    .select()
    .from(products)
    .where(sql`${products.id} = ANY(${productIds}::uuid[])`);
  const prodMap = new Map(prodRows.map((p) => [p.id, p] as const));

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const discount = parseFloat(pkg.discountPercent);

  let subtotalNet = 0;
  let total = 0;
  const lines: Awaited<ReturnType<typeof calculatePricingForRetailer>>["items"] = [];

  for (const it of input.items) {
    const p = prodMap.get(it.productId);
    if (!p) throw new Error(`Prodotto ${it.productId} non trovato`);
    const basePriceRaw = p.unitPrice ? parseFloat(p.unitPrice) : NaN;
    if (!Number.isFinite(basePriceRaw) || basePriceRaw <= 0) {
      throw new Error(
        `Prodotto ${p.sku} senza prezzo base configurato — impossibile calcolare proforma`,
      );
    }
    const vatRate = parseFloat(p.vatRate);
    const unitPriceFinal = round2(basePriceRaw * (1 - discount / 100));
    const lineNet = round2(unitPriceFinal * it.qty);
    const lineGross = round2(lineNet * (1 + vatRate / 100));

    subtotalNet += lineNet;
    total += lineGross;

    lines.push({
      productId: p.id,
      productSku: p.sku,
      productName: p.name,
      qty: it.qty,
      unitPriceBase: basePriceRaw.toFixed(2),
      discountPercent: discount.toFixed(2),
      unitPriceFinal: unitPriceFinal.toFixed(2),
      vatRate: vatRate.toFixed(2),
      lineTotalNet: lineNet.toFixed(2),
      lineTotalGross: lineGross.toFixed(2),
    });
  }

  const subtotalRounded = round2(subtotalNet);
  const totalRounded = round2(total);
  const vatAmount = round2(totalRounded - subtotalRounded);

  return {
    items: lines,
    subtotalNet: subtotalRounded.toFixed(2),
    vatAmount: vatAmount.toFixed(2),
    total: totalRounded.toFixed(2),
    packageId: pkg.id,
    packageName: pkg.name,
    packageDiscount: discount.toFixed(2),
  };
}

// ============= SYSTEM INTEGRATIONS (Phase B M3) =============

export async function getSystemIntegration(
  type: string,
): Promise<SystemIntegration | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db
    .select()
    .from(systemIntegrations)
    .where(eq(systemIntegrations.type, type))
    .limit(1);
  return r[0];
}

export async function upsertSystemIntegration(
  data: InsertSystemIntegration,
): Promise<SystemIntegration> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getSystemIntegration(data.type);
  if (existing) {
    const [row] = await db
      .update(systemIntegrations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(systemIntegrations.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await db.insert(systemIntegrations).values(data).returning();
  return row;
}

export async function deleteSystemIntegration(type: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Defense-in-depth (M3.0.4): usa .returning() per ottenere conto reale delle
  // righe cancellate. Throw esplicito se 0: copre il caso ipotetico di RLS
  // silenzioso (oggi connection postgres con BYPASSRLS=true, ma se in futuro
  // si passa a service_role o ad altra connection, lo vediamo subito).
  const deleted = await db
    .delete(systemIntegrations)
    .where(eq(systemIntegrations.type, type))
    .returning({ id: systemIntegrations.id });
  console.log(`[systemIntegrations] DELETE type=${type} affected=${deleted.length}`);
  return deleted.length;
}

// ============= PROFORMA QUEUE (Phase B M3) =============

export async function enqueueProforma(input: {
  transferMovementId: string;
  payload: unknown;
  initialError?: string;
}): Promise<ProformaQueue> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db
    .insert(proformaQueue)
    .values({
      transferMovementId: input.transferMovementId,
      payload: input.payload as object,
      status: input.initialError ? "failed" : "pending",
      attempts: input.initialError ? 1 : 0,
      lastError: input.initialError ?? null,
      lastAttemptAt: input.initialError ? new Date() : null,
    })
    .returning();
  return row;
}

export async function getProformaQueueList(filter?: {
  status?: "pending" | "processing" | "success" | "failed";
}): Promise<ProformaQueue[]> {
  const db = await getDb();
  if (!db) return [];
  const q = db.select().from(proformaQueue).orderBy(desc(proformaQueue.createdAt));
  if (filter?.status) {
    return q.where(eq(proformaQueue.status, filter.status)) as unknown as Promise<
      ProformaQueue[]
    >;
  }
  return q;
}

export async function getProformaQueueByMovement(
  movementId: string,
): Promise<ProformaQueue | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db
    .select()
    .from(proformaQueue)
    .where(eq(proformaQueue.transferMovementId, movementId))
    .limit(1);
  return r[0];
}

export async function markProformaQueueFailed(
  id: string,
  error: string,
): Promise<ProformaQueue | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db
    .update(proformaQueue)
    .set({
      status: "failed",
      attempts: sql`${proformaQueue.attempts} + 1`,
      lastError: error.slice(0, 4000),
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proformaQueue.id, id))
    .returning();
  return row;
}

export async function markProformaQueueProcessing(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(proformaQueue)
    .set({
      status: "processing",
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proformaQueue.id, id));
}

export async function markProformaQueueSuccess(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(proformaQueue)
    .set({
      status: "success",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(proformaQueue.id, id));
}

export async function setStockMovementProforma(
  movementId: string,
  ficProformaId: number,
  ficProformaNumber: string,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(stockMovements)
    .set({ ficProformaId, ficProformaNumber })
    .where(eq(stockMovements.id, movementId));
}


// ============= M6.1 — RETAILER PORTAL =============

/**
 * Lista utenti associati a un retailer (per admin card utenti portale).
 */
export async function getUsersByRetailerId(retailerId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(users)
    .where(
      and(
        eq(users.retailerId, retailerId),
        inArray(users.role, ["retailer_admin", "retailer_user"]),
      ),
    )
    .orderBy(users.email);
}

/**
 * Crea utente retailer in public.users (dopo Supabase Auth invite).
 */
export async function createRetailerUser(data: {
  id: string;
  email: string;
  name: string | null;
  role: "retailer_admin" | "retailer_user";
  retailerId: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db
    .insert(users)
    .values({
      id: data.id,
      email: data.email,
      name: data.name,
      role: data.role,
      retailerId: data.retailerId,
    })
    .returning();
  return row;
}

/**
 * Dashboard stats per il portale retailer.
 */
export async function getRetailerDashboardStats(retailerId: string) {
  const db = await getDb();
  if (!db) return { totalOrders: 0, pendingOrders: 0, activeStock: 0, inventoryValue: "0.00" };

  const [orderStats] = await db
    .select({
      totalOrders: sql<number>`count(*)::int`,
      pendingOrders: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'pending')::int`,
    })
    .from(orders)
    .where(eq(orders.retailerId, retailerId));

  const [stockStats] = await db
    .select({
      activeStock: sql<number>`COALESCE(SUM(ibb."quantity"), 0)::int`,
      inventoryValue: sql<string>`COALESCE(
        SUM(ibb."quantity" * NULLIF(p."unitPrice", '')::numeric)::numeric(18,2),
        0
      )::text`,
    })
    .from(inventoryByBatch)
    .innerJoin(locations, eq(inventoryByBatch.locationId, locations.id))
    .innerJoin(productBatches, eq(inventoryByBatch.batchId, productBatches.id))
    .innerJoin(products, eq(productBatches.productId, products.id))
    .where(
      and(
        eq(locations.retailerId, retailerId),
        sql`ibb."quantity" > 0`,
      ),
    );

  return {
    totalOrders: orderStats?.totalOrders ?? 0,
    pendingOrders: orderStats?.pendingOrders ?? 0,
    activeStock: stockStats?.activeStock ?? 0,
    inventoryValue: stockStats?.inventoryValue ?? "0.00",
  };
}

/**
 * Dashboard: prodotti con stock totale (magazzino centrale) sotto soglia minima.
 * Ritorna solo prodotti con minStockThreshold > 0 e stock < soglia.
 */
export function getProductsUnderThreshold(limit = 20) {
  return cachedDashboard(`stockAlerts:${limit}`, CACHE_TTL, () => _getProductsUnderThresholdImpl(limit));
}
async function _getProductsUnderThresholdImpl(limit = 20) {
  const db = await getDb();
  if (!db) return [];

  const rows = await db.execute(sql`
    SELECT
      p."id",
      p."name",
      p."sku",
      p."minStockThreshold",
      p."piecesPerUnit",
      COALESCE(SUM(ibb."quantity"), 0)::int AS "totalStock"
    FROM "products" p
    LEFT JOIN "productBatches" pb ON pb."productId" = p."id"
    LEFT JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb."id"
      AND ibb."locationId" IN (SELECT l."id" FROM "locations" l WHERE l."type" = 'central_warehouse')
    WHERE p."minStockThreshold" IS NOT NULL AND p."minStockThreshold" > 0
    GROUP BY p."id", p."name", p."sku", p."minStockThreshold", p."piecesPerUnit"
    HAVING COALESCE(SUM(ibb."quantity"), 0) < p."minStockThreshold"
    ORDER BY COALESCE(SUM(ibb."quantity"), 0) ASC
    LIMIT ${limit}
  `);

  return rows as unknown as Array<{
    id: string;
    name: string;
    sku: string;
    minStockThreshold: number;
    piecesPerUnit: number | null;
    totalStock: number;
  }>;
}

/**
 * Dashboard: lotti con scadenza imminente (entro expiryWarningDays del prodotto).
 * Ritorna solo lotti con stock > 0 nel magazzino centrale.
 */
export function getExpiringBatches(limit = 20) {
  return cachedDashboard(`expiringBatches:${limit}`, CACHE_TTL, () => _getExpiringBatchesImpl(limit));
}
async function _getExpiringBatchesImpl(limit = 20) {
  const db = await getDb();
  if (!db) return [];

  const rows = await db.execute(sql`
    SELECT
      pb."id" AS "batchId",
      pb."batchNumber",
      pb."expirationDate"::text,
      p."id" AS "productId",
      p."name" AS "productName",
      p."sku" AS "productSku",
      p."expiryWarningDays",
      COALESCE(SUM(ibb."quantity"), 0)::int AS "stock",
      (pb."expirationDate"::date - CURRENT_DATE)::int AS "daysToExpiry"
    FROM "productBatches" pb
    INNER JOIN "products" p ON p."id" = pb."productId"
    INNER JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb."id"
    INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'central_warehouse'
    WHERE
      pb."expirationDate" IS NOT NULL
      AND (pb."expirationDate"::date - CURRENT_DATE) <= COALESCE(p."expiryWarningDays", 30)
    GROUP BY pb."id", pb."batchNumber", pb."expirationDate", p."id", p."name", p."sku", p."expiryWarningDays"
    HAVING COALESCE(SUM(ibb."quantity"), 0) > 0
    ORDER BY pb."expirationDate" ASC
    LIMIT ${limit}
  `);

  return rows as unknown as Array<{
    batchId: string;
    batchNumber: string;
    expirationDate: string;
    productId: string;
    productName: string;
    productSku: string;
    expiryWarningDays: number | null;
    stock: number;
    daysToExpiry: number;
  }>;
}
