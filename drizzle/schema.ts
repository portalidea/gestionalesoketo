import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Postgres enums (definiti separatamente, riutilizzabili).
 *
 * `stock_movement_type` esteso in 0003 con `RECEIPT_FROM_PRODUCER`
 * (Phase B M1: ingressi da produttore al magazzino centrale).
 * I valori `IN/OUT/ADJUSTMENT` sono **deprecated** e restano solo per
 * retrocompatibilità con le righe legacy. M2 aggiungerà
 * `TRANSFER`, `RETAIL_OUT`, `EXPIRY_WRITE_OFF`.
 *
 * `location_type` aggiunto in 0003: distingue tra il magazzino centrale
 * SoKeto (singleton) e le location per-retailer.
 */
export const userRoleEnum = pgEnum("user_role", ["admin", "operator", "viewer"]);
export const stockMovementTypeEnum = pgEnum("stock_movement_type", [
  "IN",
  "OUT",
  "ADJUSTMENT",
  "RECEIPT_FROM_PRODUCER",
  "TRANSFER",
  "EXPIRY_WRITE_OFF",
]);
export const alertTypeEnum = pgEnum("alert_type", ["LOW_STOCK", "EXPIRING", "EXPIRED"]);
export const alertStatusEnum = pgEnum("alert_status", ["ACTIVE", "ACKNOWLEDGED", "RESOLVED"]);
export const syncStatusEnum = pgEnum("sync_status", ["SUCCESS", "FAILED", "PARTIAL"]);
export const locationTypeEnum = pgEnum("location_type", ["central_warehouse", "retailer"]);
export const proformaQueueStatusEnum = pgEnum("proforma_queue_status", [
  "pending",
  "processing",
  "success",
  "failed",
]);

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
  // M3: pacchetto commerciale assegnato (NULL = blocca generazione proforma)
  pricingPackageId: uuid("pricingPackageId").references(() => pricingPackages.id, {
    onDelete: "set null",
  }),
  // M3: ID cliente in anagrafica FiC single-tenant (NULL = blocca generazione proforma)
  ficClientId: integer("ficClientId"),
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
  // M3: aliquota IVA italiana applicata al prodotto. CHECK enforced lato DB
  // su valori 4/5/10/22. Default 10% (alimentari), 22% per birre/bevande.
  vatRate: numeric("vatRate", { precision: 5, scale: 2 }).default("10.00").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/**
 * Producers — anagrafica produttori (Phase B M1).
 * E-Keto Food è il produttore principale, ma il modello supporta
 * lavorazioni per terzi e produttori multipli.
 */
export const producers = pgTable("producers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  contactName: text("contactName"),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 50 }),
  address: text("address"),
  vatNumber: varchar("vatNumber", { length: 50 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export type Producer = typeof producers.$inferSelect;
export type InsertProducer = typeof producers.$inferInsert;

/**
 * Product batches — lotti per prodotto, con scadenza obbligatoria
 * (Phase B M1). `initialQuantity` è la quantità iniziale del lotto al
 * ricevimento dal produttore; lo stock corrente vive in
 * `inventoryByBatch` per location.
 *
 * UNIQUE (productId, batchNumber): un produttore non può ripetere lo
 * stesso codice lotto sullo stesso prodotto.
 */
export const productBatches = pgTable(
  "productBatches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("productId")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    producerId: uuid("producerId").references(() => producers.id, {
      onDelete: "set null",
    }),
    batchNumber: text("batchNumber").notNull(),
    expirationDate: date("expirationDate").notNull(),
    productionDate: date("productionDate"),
    initialQuantity: integer("initialQuantity").notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("productBatches_product_batch_unique").on(t.productId, t.batchNumber),
    check("productBatches_initial_qty_positive", sql`${t.initialQuantity} > 0`),
    index("productBatches_product_expiration_idx").on(t.productId, t.expirationDate),
  ],
);

export type ProductBatch = typeof productBatches.$inferSelect;
export type InsertProductBatch = typeof productBatches.$inferInsert;

/**
 * Locations — magazzino centrale SoKeto (singleton) + 1 per retailer
 * (Phase B M1). Sostituisce semantica del campo `inventory.retailerId`
 * legacy.
 *
 * Vincoli applicati a livello DB:
 * - CHECK: central_warehouse ⇔ retailerId NULL; retailer ⇔ retailerId NOT NULL
 * - UNIQUE partial index su type=central_warehouse (singleton)
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    type: locationTypeEnum("type").notNull(),
    name: text("name").notNull(),
    retailerId: uuid("retailerId").references(() => retailers.id, {
      onDelete: "cascade",
    }),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "locations_type_retailer_coherence",
      sql`(${t.type} = 'central_warehouse' AND ${t.retailerId} IS NULL) OR (${t.type} = 'retailer' AND ${t.retailerId} IS NOT NULL)`,
    ),
    uniqueIndex("locations_central_singleton")
      .on(t.type)
      .where(sql`${t.type} = 'central_warehouse'`),
    index("locations_retailerId_idx")
      .on(t.retailerId)
      .where(sql`${t.retailerId} IS NOT NULL`),
  ],
);

export type Location = typeof locations.$inferSelect;
export type InsertLocation = typeof locations.$inferInsert;

/**
 * Inventory by batch — stato magazzino per coppia (location, batch).
 * Sostituisce `inventory` legacy. Una riga per ogni lotto presente
 * in ogni location.
 */
export const inventoryByBatch = pgTable(
  "inventoryByBatch",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    locationId: uuid("locationId")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    batchId: uuid("batchId")
      .notNull()
      .references(() => productBatches.id, { onDelete: "restrict" }),
    quantity: integer("quantity").default(0).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("inventoryByBatch_location_batch_unique").on(t.locationId, t.batchId),
    check("inventoryByBatch_quantity_nonneg", sql`${t.quantity} >= 0`),
  ],
);

export type InventoryByBatch = typeof inventoryByBatch.$inferSelect;
export type InsertInventoryByBatch = typeof inventoryByBatch.$inferInsert;

/**
 * Stock movements — log immutabile movimenti magazzino.
 *
 * Phase B M1:
 * - `inventoryId` e `retailerId` resi nullable: il nuovo movimento
 *   `RECEIPT_FROM_PRODUCER` (produttore → magazzino centrale) non ha
 *   né inventoryId legacy né retailerId.
 * - Nuovi FK opzionali: `batchId`, `fromLocationId`, `toLocationId`.
 *
 * Phase B M2:
 * - Esteso enum `stock_movement_type` con `TRANSFER` e `EXPIRY_WRITE_OFF`.
 * - Aggiunto campo `notesInternal` per audit log automatici lato backend
 *   (es. "Generato da TRANSFER warehouse→retailer X"), distinto da `notes`
 *   user-facing.
 * - `inventoryId` resta come dead column nullable (drop in M3 col cleanup
 *   completo del refactor FiC).
 */
export const stockMovements = pgTable("stockMovements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inventoryId: uuid("inventoryId"),
  retailerId: uuid("retailerId"),
  productId: uuid("productId").notNull(),
  type: stockMovementTypeEnum("type").notNull(),
  quantity: integer("quantity").notNull(),
  previousQuantity: integer("previousQuantity"),
  newQuantity: integer("newQuantity"),
  sourceDocument: varchar("sourceDocument", { length: 255 }),
  sourceDocumentType: varchar("sourceDocumentType", { length: 50 }),
  notes: text("notes"),
  notesInternal: text("notesInternal"),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("createdBy"),
  batchId: uuid("batchId").references(() => productBatches.id, {
    onDelete: "set null",
  }),
  fromLocationId: uuid("fromLocationId").references(() => locations.id, {
    onDelete: "set null",
  }),
  toLocationId: uuid("toLocationId").references(() => locations.id, {
    onDelete: "set null",
  }),
  // M3: riferimento proforma generata su FiC. NULL se ancora in coda o nessuna.
  ficProformaId: integer("ficProformaId"),
  ficProformaNumber: varchar("ficProformaNumber", { length: 50 }),
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

/**
 * Pricing packages — pacchetti commerciali (Phase B M3).
 * Ogni retailer è assegnato a un pacchetto che determina lo sconto fisso
 * applicato al prezzo base di tutti i prodotti per la generazione proforma.
 * Modify admin-only via RLS (leva commerciale strategica).
 */
export const pricingPackages = pgTable(
  "pricingPackages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 100 }).notNull().unique(),
    discountPercent: numeric("discountPercent", { precision: 5, scale: 2 }).notNull(),
    description: text("description"),
    sortOrder: integer("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "pricingPackages_discount_range",
      sql`${t.discountPercent} >= 0 AND ${t.discountPercent} <= 100`,
    ),
  ],
);

export type PricingPackage = typeof pricingPackages.$inferSelect;
export type InsertPricingPackage = typeof pricingPackages.$inferInsert;

/**
 * System integrations — token OAuth e config delle integrazioni a livello
 * sistema (singleton per type). Phase B M3 introduce single-tenant FiC:
 * type='fattureincloud' con i token dell'account E-Keto Food Srls.
 * RLS admin-only (contiene access/refresh token).
 */
export const systemIntegrations = pgTable("systemIntegrations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type", { length: 50 }).notNull().unique(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  expiresAt: timestamp("expiresAt", { withTimezone: true }),
  accountId: varchar("accountId", { length: 100 }),
  scopes: text("scopes"),
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export type SystemIntegration = typeof systemIntegrations.$inferSelect;
export type InsertSystemIntegration = typeof systemIntegrations.$inferInsert;

/**
 * Proforma queue — coda retry per generazione proforma FiC fallite (M3).
 * Quando una chiamata FiC API fallisce durante un TRANSFER, il movement
 * procede comunque e la richiesta viene salvata qui. Retry MANUALE da UI
 * /movements (no cron Vercel in M3).
 *
 * ON DELETE CASCADE: se il transfer movement viene cancellato, la riga
 * di queue diventa orfana → si cancella insieme.
 */
export const proformaQueue = pgTable(
  "proformaQueue",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    transferMovementId: uuid("transferMovementId")
      .notNull()
      .references(() => stockMovements.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    status: proformaQueueStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("maxAttempts").default(5).notNull(),
    lastError: text("lastError"),
    lastAttemptAt: timestamp("lastAttemptAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "proformaQueue_attempts_nonneg",
      sql`${t.attempts} >= 0 AND ${t.attempts} <= ${t.maxAttempts}`,
    ),
    index("proformaQueue_status_idx")
      .on(t.status)
      .where(sql`${t.status} IN ('pending', 'failed')`),
  ],
);

export type ProformaQueue = typeof proformaQueue.$inferSelect;
export type InsertProformaQueue = typeof proformaQueue.$inferInsert;
