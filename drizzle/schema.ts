import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Retailers table - Anagrafica rivenditori
 */
export const retailers = mysqlTable("retailers", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  businessType: varchar("businessType", { length: 100 }), // ristorante, farmacia, negozio, etc.
  address: text("address"),
  city: varchar("city", { length: 100 }),
  province: varchar("province", { length: 2 }),
  postalCode: varchar("postalCode", { length: 10 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  contactPerson: varchar("contactPerson", { length: 255 }),
  // Credenziali per integrazione Fatture in Cloud OAuth2
  fattureInCloudCompanyId: varchar("fattureInCloudCompanyId", { length: 100 }),
  fattureInCloudAccessToken: text("fattureInCloudAccessToken"),
  fattureInCloudRefreshToken: text("fattureInCloudRefreshToken"),
  fattureInCloudTokenExpiresAt: timestamp("fattureInCloudTokenExpiresAt"),
  lastSyncAt: timestamp("lastSyncAt"),
  syncEnabled: int("syncEnabled").default(0).notNull(), // 1 = enabled, 0 = disabled
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Retailer = typeof retailers.$inferSelect;
export type InsertRetailer = typeof retailers.$inferInsert;

/**
 * Products table - Anagrafica centralizzata prodotti Sucketo
 */
export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  sku: varchar("sku", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }), // pane, pasta, dolci, etc.
  // Informazioni nutrizionali specifiche per prodotti Sucketo
  isLowCarb: int("isLowCarb").default(1).notNull(),
  isGlutenFree: int("isGlutenFree").default(1).notNull(),
  isKeto: int("isKeto").default(1).notNull(),
  sugarContent: varchar("sugarContent", { length: 50 }).default("0%"),
  // Gestione fornitori
  supplierId: int("supplierId"),
  supplierName: varchar("supplierName", { length: 255 }),
  // Prezzi e unità
  unitPrice: varchar("unitPrice", { length: 20 }),
  unit: varchar("unit", { length: 50 }), // kg, pz, confezione, etc.
  // Soglie alert
  minStockThreshold: int("minStockThreshold").default(10),
  expiryWarningDays: int("expiryWarningDays").default(30), // giorni prima della scadenza per alert
  imageUrl: text("imageUrl"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/**
 * Inventory table - Stato magazzino per ogni rivenditore
 */
export const inventory = mysqlTable("inventory", {
  id: int("id").autoincrement().primaryKey(),
  retailerId: int("retailerId").notNull(),
  productId: int("productId").notNull(),
  quantity: int("quantity").default(0).notNull(),
  expirationDate: timestamp("expirationDate"),
  batchNumber: varchar("batchNumber", { length: 100 }),
  lastUpdated: timestamp("lastUpdated").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Inventory = typeof inventory.$inferSelect;
export type InsertInventory = typeof inventory.$inferInsert;

/**
 * Stock Movements table - Log completo movimenti magazzino
 */
export const stockMovements = mysqlTable("stockMovements", {
  id: int("id").autoincrement().primaryKey(),
  inventoryId: int("inventoryId").notNull(),
  retailerId: int("retailerId").notNull(),
  productId: int("productId").notNull(),
  type: mysqlEnum("type", ["IN", "OUT", "ADJUSTMENT"]).notNull(),
  quantity: int("quantity").notNull(),
  previousQuantity: int("previousQuantity"),
  newQuantity: int("newQuantity"),
  sourceDocument: varchar("sourceDocument", { length: 255 }), // numero fattura, DDT, etc.
  sourceDocumentType: varchar("sourceDocumentType", { length: 50 }), // invoice, delivery_note, etc.
  notes: text("notes"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  createdBy: int("createdBy"), // user id
});

export type StockMovement = typeof stockMovements.$inferSelect;
export type InsertStockMovement = typeof stockMovements.$inferInsert;

/**
 * Alerts table - Sistema alert per scorte e scadenze
 */
export const alerts = mysqlTable("alerts", {
  id: int("id").autoincrement().primaryKey(),
  retailerId: int("retailerId").notNull(),
  productId: int("productId").notNull(),
  type: mysqlEnum("type", ["LOW_STOCK", "EXPIRING", "EXPIRED"]).notNull(),
  status: mysqlEnum("status", ["ACTIVE", "ACKNOWLEDGED", "RESOLVED"]).default("ACTIVE").notNull(),
  message: text("message"),
  currentQuantity: int("currentQuantity"),
  thresholdQuantity: int("thresholdQuantity"),
  expirationDate: timestamp("expirationDate"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledgedAt"),
  acknowledgedBy: int("acknowledgedBy"), // user id
  resolvedAt: timestamp("resolvedAt"),
});

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;

/**
 * Sync Log table - Log sincronizzazioni con Fatture in Cloud
 */
export const syncLogs = mysqlTable("syncLogs", {
  id: int("id").autoincrement().primaryKey(),
  retailerId: int("retailerId").notNull(),
  syncType: varchar("syncType", { length: 50 }).notNull(), // products, stock, full
  status: mysqlEnum("status", ["SUCCESS", "FAILED", "PARTIAL"]).notNull(),
  recordsProcessed: int("recordsProcessed").default(0),
  recordsFailed: int("recordsFailed").default(0),
  errorMessage: text("errorMessage"),
  startedAt: timestamp("startedAt").notNull(),
  completedAt: timestamp("completedAt"),
  duration: int("duration"), // in secondi
});

export type SyncLog = typeof syncLogs.$inferSelect;
export type InsertSyncLog = typeof syncLogs.$inferInsert;