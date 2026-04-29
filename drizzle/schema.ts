import { sql } from "drizzle-orm";
import { integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Postgres enums (definiti separatamente, riutilizzabili).
 */
export const userRoleEnum = pgEnum("user_role", ["admin", "operator", "viewer"]);
export const stockMovementTypeEnum = pgEnum("stock_movement_type", ["IN", "OUT", "ADJUSTMENT"]);
export const alertTypeEnum = pgEnum("alert_type", ["LOW_STOCK", "EXPIRING", "EXPIRED"]);
export const alertStatusEnum = pgEnum("alert_status", ["ACTIVE", "ACKNOWLEDGED", "RESOLVED"]);
export const syncStatusEnum = pgEnum("sync_status", ["SUCCESS", "FAILED", "PARTIAL"]);

/**
 * Profilo applicativo dell'operatore SoKeto.
 * `id` è 1:1 con `auth.users.id` di Supabase Auth: la riga viene creata da un trigger
 * (vedi migration `0002_auth_supabase_integration.sql`) al primo login con magic link.
 * Niente openId/loginMethod legacy: l'identità è gestita interamente da Supabase Auth.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  name: text("name"),
  role: userRoleEnum("role").default("operator").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Retailers — anagrafica rivenditori.
 */
export const retailers = pgTable("retailers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 255 }).notNull(),
  businessType: varchar("businessType", { length: 100 }),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  province: varchar("province", { length: 2 }),
  postalCode: varchar("postalCode", { length: 10 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  contactPerson: varchar("contactPerson", { length: 255 }),
  fattureInCloudCompanyId: varchar("fattureInCloudCompanyId", { length: 100 }),
  fattureInCloudAccessToken: text("fattureInCloudAccessToken"),
  fattureInCloudRefreshToken: text("fattureInCloudRefreshToken"),
  fattureInCloudTokenExpiresAt: timestamp("fattureInCloudTokenExpiresAt", { withTimezone: true }),
  lastSyncAt: timestamp("lastSyncAt", { withTimezone: true }),
  syncEnabled: integer("syncEnabled").default(0).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export type Retailer = typeof retailers.$inferSelect;
export type InsertRetailer = typeof retailers.$inferInsert;

/**
 * Products — anagrafica centralizzata prodotti SoKeto.
 */
export const products = pgTable("products", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sku: varchar("sku", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }),
  isLowCarb: integer("isLowCarb").default(1).notNull(),
  isGlutenFree: integer("isGlutenFree").default(1).notNull(),
  isKeto: integer("isKeto").default(1).notNull(),
  sugarContent: varchar("sugarContent", { length: 50 }).default("0%"),
  supplierId: integer("supplierId"),
  supplierName: varchar("supplierName", { length: 255 }),
  unitPrice: varchar("unitPrice", { length: 20 }),
  unit: varchar("unit", { length: 50 }),
  minStockThreshold: integer("minStockThreshold").default(10),
  expiryWarningDays: integer("expiryWarningDays").default(30),
  imageUrl: text("imageUrl"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/**
 * Inventory — stato magazzino per coppia (retailer, product).
 */
export const inventory = pgTable("inventory", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  retailerId: uuid("retailerId").notNull(),
  productId: uuid("productId").notNull(),
  quantity: integer("quantity").default(0).notNull(),
  expirationDate: timestamp("expirationDate", { withTimezone: true }),
  batchNumber: varchar("batchNumber", { length: 100 }),
  lastUpdated: timestamp("lastUpdated", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
});

export type Inventory = typeof inventory.$inferSelect;
export type InsertInventory = typeof inventory.$inferInsert;

/**
 * Stock movements — log immutabile movimenti magazzino.
 */
export const stockMovements = pgTable("stockMovements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inventoryId: uuid("inventoryId").notNull(),
  retailerId: uuid("retailerId").notNull(),
  productId: uuid("productId").notNull(),
  type: stockMovementTypeEnum("type").notNull(),
  quantity: integer("quantity").notNull(),
  previousQuantity: integer("previousQuantity"),
  newQuantity: integer("newQuantity"),
  sourceDocument: varchar("sourceDocument", { length: 255 }),
  sourceDocumentType: varchar("sourceDocumentType", { length: 50 }),
  notes: text("notes"),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("createdBy"),
});

export type StockMovement = typeof stockMovements.$inferSelect;
export type InsertStockMovement = typeof stockMovements.$inferInsert;

/**
 * Alerts — scorte basse, scadenze imminenti, prodotti scaduti.
 */
export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  retailerId: uuid("retailerId").notNull(),
  productId: uuid("productId").notNull(),
  type: alertTypeEnum("type").notNull(),
  status: alertStatusEnum("status").default("ACTIVE").notNull(),
  message: text("message"),
  currentQuantity: integer("currentQuantity"),
  thresholdQuantity: integer("thresholdQuantity"),
  expirationDate: timestamp("expirationDate", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledgedAt", { withTimezone: true }),
  acknowledgedBy: uuid("acknowledgedBy"),
  resolvedAt: timestamp("resolvedAt", { withTimezone: true }),
});

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;

/**
 * Sync logs — risultato sync con Fatture in Cloud.
 */
export const syncLogs = pgTable("syncLogs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  retailerId: uuid("retailerId").notNull(),
  syncType: varchar("syncType", { length: 50 }).notNull(),
  status: syncStatusEnum("status").notNull(),
  recordsProcessed: integer("recordsProcessed").default(0),
  recordsFailed: integer("recordsFailed").default(0),
  errorMessage: text("errorMessage"),
  startedAt: timestamp("startedAt", { withTimezone: true }).notNull(),
  completedAt: timestamp("completedAt", { withTimezone: true }),
  duration: integer("duration"),
});

export type SyncLog = typeof syncLogs.$inferSelect;
export type InsertSyncLog = typeof syncLogs.$inferInsert;
