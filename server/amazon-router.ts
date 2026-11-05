import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { adminProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  amazonImportConfigs,
  amazonImportRuns,
  amazonImportRowObservations,
  amazonStockAllocations,
  companies,
  marketplaceOrders,
  marketplaceOrderItems,
  productBatches,
  products,
  salesStores,
} from "../drizzle/schema";
import { EKETO_COMPANY_ID } from "../shared/const";
import { uuidSchema } from "../shared/schemas";
import { getAmazonImportProductSummary } from "./services/amazonImportSummaryService";

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Data non valida");
const pagination = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(100_000).default(0),
};
const period = z
  .object({ storeId: uuidSchema, dateFrom: dateInput, dateTo: dateInput })
  .refine(value => {
    const days =
      (Date.parse(value.dateTo) - Date.parse(value.dateFrom)) / 86_400_000;
    return days >= 0 && days <= 92;
  }, "Seleziona un periodo di massimo 93 giorni");
const stockStatus = z.enum([
  "pending",
  "not_shipped",
  "pre_cutoff",
  "review_required",
  "dry_run",
  "processed",
  "cancelled",
  "post_stock_alert",
]);

async function database() {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB non disponibile",
    });
  return db;
}
async function requireEketo(db: Database, companyId: string) {
  if (companyId !== EKETO_COMPANY_ID)
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Amazon è disponibile solo nell’azienda attiva E-Keto. Cambia azienda per continuare.",
    });
  // companies has name/isActive, not a company code. Never trust a client-supplied company.
  const [company] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.isActive, true)))
    .limit(1);
  if (!company)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Azienda E-Keto non attiva",
    });
  return company;
}
async function authorizedStore(
  db: Database,
  companyId: string,
  storeId: string
) {
  await requireEketo(db, companyId);
  const [store] = await db
    .select({
      id: salesStores.id,
      name: salesStores.name,
      dryRun: amazonImportConfigs.dryRun,
      enabled: amazonImportConfigs.enabled,
    })
    .from(salesStores)
    .innerJoin(
      amazonImportConfigs,
      eq(amazonImportConfigs.storeId, salesStores.id)
    )
    .where(
      and(
        eq(salesStores.id, storeId),
        eq(salesStores.channel, "amazon"),
        eq(salesStores.companyId, companyId),
        eq(salesStores.isActive, true)
      )
    )
    .limit(1);
  if (!store)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Store Amazon non trovato nell’azienda attiva",
    });
  return store;
}
function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
function sourceText(value: unknown, ...keys: string[]): string | null {
  const row = jsonObject(value);
  for (const key of keys)
    if (
      (typeof row[key] === "string" || typeof row[key] === "number") &&
      String(row[key]).trim()
    )
      return String(row[key]);
  return null;
}
const allocationSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().optional(),
  batchId: z.string().optional(),
  batchNumber: z.string().optional(),
  pieces: z.number().optional(),
  quantity: z.number().optional(),
  quantityPieces: z.number().optional(),
  expirationDate: z.string().nullable().optional(),
  productionDate: z.string().nullable().optional(),
});
function previewAllocations(value: unknown) {
  const parsed = z.array(allocationSchema).safeParse(value);
  return parsed.success
    ? parsed.data.map(entry => ({
        ...entry,
        pieces: entry.pieces ?? entry.quantityPieces ?? entry.quantity ?? 0,
      }))
    : [];
}
function periodFilter(
  column: typeof amazonImportRuns.createdAt,
  input: z.infer<typeof period>
) {
  return and(
    sql`${column} >= (${input.dateFrom}::date::timestamp AT TIME ZONE 'Europe/Rome')`,
    sql`${column} < ((${input.dateTo}::date + 1)::timestamp AT TIME ZONE 'Europe/Rome')`
  );
}

export const amazonRouter = router({
  store: router({
    get: adminProcedure.query(async ({ ctx }) => {
      const db = await database();
      const company = await requireEketo(db, ctx.activeCompanyId);
      const stores = await db
        .select({
          id: salesStores.id,
          name: salesStores.name,
          storeIdentifier: salesStores.storeIdentifier,
          sellerAccountId: amazonImportConfigs.sellerAccountId,
          purchaseCutoff: amazonImportConfigs.purchaseCutoff,
          dryRun: amazonImportConfigs.dryRun,
          enabled: amazonImportConfigs.enabled,
          checkpointAt: amazonImportConfigs.checkpointAt,
          updatedAt: amazonImportConfigs.updatedAt,
          updatedBy: amazonImportConfigs.updatedBy,
        })
        .from(salesStores)
        .innerJoin(
          amazonImportConfigs,
          eq(amazonImportConfigs.storeId, salesStores.id)
        )
        .where(
          and(
            eq(salesStores.channel, "amazon"),
            eq(salesStores.companyId, ctx.activeCompanyId),
            eq(salesStores.isActive, true)
          )
        )
        .orderBy(asc(salesStores.createdAt))
        .limit(100);
      return { companyName: company.name, stores };
    }),
    configure: adminProcedure
      .input(
        z.object({
          storeId: uuidSchema.optional(),
          name: z.string().trim().min(1).max(255),
          sellerAccountId: z.string().trim().min(1).max(255),
          purchaseCutoff: dateInput.default("2026-09-01"),
          enabled: z.boolean().default(false),
          dryRun: z.boolean().default(true),
          confirmRealStock: z.boolean().default(false),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const db = await database();
        await requireEketo(db, ctx.activeCompanyId);
        if (input.storeId)
          await authorizedStore(db, ctx.activeCompanyId, input.storeId);
        if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
        const operatorId = ctx.user.id;
        if (!input.dryRun && !input.confirmRealStock)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Conferma manualmente il passaggio reale: anche la coda pendente e i dry-run storici idonei potranno scaricare stock.",
          });
        try {
          const storeId = await db.transaction(async tx => {
            let id = input.storeId;
            if (id) {
              // Match worker lock ordering: config first, then store. Authorization is
              // rechecked below before any write; a foreign ID can never be modified.
              await tx
                .select({ storeId: amazonImportConfigs.storeId })
                .from(amazonImportConfigs)
                .where(eq(amazonImportConfigs.storeId, id))
                .limit(1)
                .for("update");
              const [existing] = await tx
                .select({
                  id: salesStores.id,
                  sellerAccountId: amazonImportConfigs.sellerAccountId,
                  purchaseCutoff: amazonImportConfigs.purchaseCutoff,
                })
                .from(salesStores)
                .innerJoin(
                  amazonImportConfigs,
                  eq(amazonImportConfigs.storeId, salesStores.id)
                )
                .where(
                  and(
                    eq(salesStores.id, id),
                    eq(salesStores.channel, "amazon"),
                    eq(salesStores.companyId, ctx.activeCompanyId),
                    eq(salesStores.isActive, true)
                  )
                )
                .limit(1)
                .for("update");
              if (!existing)
                throw new TRPCError({
                  code: "NOT_FOUND",
                  message: "Store Amazon non trovato nell’azienda attiva",
                });
              if (existing.sellerAccountId !== input.sellerAccountId)
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message:
                    "Il Seller Account ID identifica lo store e non può essere cambiato. Crea un nuovo store per un altro account.",
                });
              if (existing.purchaseCutoff !== input.purchaseCutoff) {
                const [receipt] = await tx
                  .select({ id: amazonImportRuns.id })
                  .from(amazonImportRuns)
                  .where(
                    and(
                      eq(amazonImportRuns.storeId, id),
                      isNotNull(amazonImportRuns.documentSha256)
                    )
                  )
                  .limit(1);
                if (receipt)
                  throw new TRPCError({
                    code: "BAD_REQUEST",
                    message:
                      "Cutoff non modificabile dopo il primo report ricevuto: il checkpoint potrebbe lasciare buchi nello storico. Serve una migrazione manuale verificata; nessun reset o scarico automatico.",
                  });
              }
              await tx
                .update(salesStores)
                .set({ name: input.name, updatedAt: new Date() })
                .where(
                  and(
                    eq(salesStores.id, id),
                    eq(salesStores.companyId, ctx.activeCompanyId),
                    eq(salesStores.channel, "amazon")
                  )
                );
            } else {
              const [created] = await tx
                .insert(salesStores)
                .values({
                  channel: "amazon",
                  name: input.name,
                  storeIdentifier: input.sellerAccountId,
                  companyId: ctx.activeCompanyId,
                  isActive: true,
                  apiCredentials: null,
                })
                .returning({ id: salesStores.id });
              id = created.id;
            }
            await tx
              .insert(amazonImportConfigs)
              .values({
                storeId: id,
                sellerAccountId: input.sellerAccountId,
                purchaseCutoff: input.purchaseCutoff,
                dryRun: input.dryRun,
                enabled: input.enabled,
                updatedBy: operatorId,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: amazonImportConfigs.storeId,
                set: {
                  purchaseCutoff: input.purchaseCutoff,
                  dryRun: input.dryRun,
                  enabled: input.enabled,
                  updatedBy: operatorId,
                  updatedAt: new Date(),
                },
              });
            return id;
          });
          return {
            storeId,
            message:
              "Configurazione Amazon salvata. Nessuna credenziale creata; nessuna scadenza automatica della modalità prova.",
          };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          const details = jsonObject(error);
          if (
            details.code === "23505" ||
            jsonObject(details.cause).code === "23505"
          )
            throw new TRPCError({
              code: "CONFLICT",
              message: "Seller Account ID già associato a uno store",
            });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Impossibile salvare la configurazione Amazon",
          });
        }
      }),
  }),
  summary: adminProcedure.input(period).query(async ({ input, ctx }) => {
    const db = await database();
    await authorizedStore(db, ctx.activeCompanyId, input.storeId);
    const daily = await db
      .select({
        date: sql<string>`(${amazonImportRuns.createdAt} AT TIME ZONE 'Europe/Rome')::date::text`,
        status: amazonImportRuns.status,
        dryRun: amazonImportRuns.dryRun,
        runs: sql<number>`count(*)::int`,
      })
      .from(amazonImportRuns)
      .where(
        and(
          eq(amazonImportRuns.storeId, input.storeId),
          periodFilter(amazonImportRuns.createdAt, input)
        )
      )
      .groupBy(
        sql`(${amazonImportRuns.createdAt} AT TIME ZONE 'Europe/Rome')::date`,
        amazonImportRuns.status,
        amazonImportRuns.dryRun
      )
      .orderBy(
        sql`(${amazonImportRuns.createdAt} AT TIME ZONE 'Europe/Rome')::date DESC`
      )
      .limit(2_000);
    const outcomes = await db
      .select({
        outcome: amazonImportRowObservations.outcome,
        rows: sql<number>`count(*)::int`,
      })
      .from(amazonImportRowObservations)
      .innerJoin(
        amazonImportRuns,
        eq(amazonImportRuns.id, amazonImportRowObservations.runId)
      )
      .where(
        and(
          eq(amazonImportRuns.storeId, input.storeId),
          periodFilter(amazonImportRuns.createdAt, input)
        )
      )
      .groupBy(amazonImportRowObservations.outcome)
      .orderBy(desc(sql`count(*)`))
      .limit(100);
    // Real quantities come only from the immutable allocation ledger, never from joined run/item totals.
    const [actual] = await db
      .select({
        pieces: sql<number>`coalesce(sum(${amazonStockAllocations.pieces}), 0)::int`,
      })
      .from(amazonStockAllocations)
      .innerJoin(
        amazonImportRuns,
        eq(amazonImportRuns.id, amazonStockAllocations.runId)
      )
      .where(
        and(
          eq(amazonImportRuns.storeId, input.storeId),
          periodFilter(amazonImportRuns.createdAt, input)
        )
      )
      .limit(1);
    const [planned] = await db.execute<{ pieces: number }>(sql`
      SELECT COALESCE(SUM(COALESCE(a->>'pieces', a->>'quantityPieces', a->>'quantity', '0')::integer),0)::int AS pieces
      FROM (
        SELECT DISTINCT ON (ro.item_id) ro.item_id, ro.planned_allocations
        FROM amazon_import_row_observations ro JOIN amazon_import_runs r ON r.id = ro.run_id
        WHERE r.store_id = ${input.storeId}::uuid AND ro.outcome = 'dry_run' AND ro.item_id IS NOT NULL
          AND r.created_at >= (${input.dateFrom}::date::timestamp AT TIME ZONE 'Europe/Rome')
          AND r.created_at < ((${input.dateTo}::date + 1)::timestamp AT TIME ZONE 'Europe/Rome')
        ORDER BY ro.item_id, ro.created_at DESC, ro.id DESC
      ) latest
      JOIN marketplace_order_items i ON i.id = latest.item_id AND i."amazonStockStatus" = 'dry_run'
      JOIN marketplace_orders mo ON mo.id = i."marketplaceOrderId" AND mo."storeId" = ${input.storeId}::uuid
      CROSS JOIN LATERAL jsonb_array_elements(latest.planned_allocations) a
      LIMIT 1
    `);
    const productSummary = await getAmazonImportProductSummary(db, input);
    return {
      ...productSummary,
      daily,
      outcomes,
      actualPieces: actual?.pieces ?? 0,
      plannedPieces: planned?.pieces ?? 0,
    };
  }),
  runs: router({
    list: adminProcedure
      .input(period.safeExtend(pagination))
      .query(async ({ input, ctx }) => {
        const db = await database();
        await authorizedStore(db, ctx.activeCompanyId, input.storeId);
        const filter = and(
          eq(amazonImportRuns.storeId, input.storeId),
          periodFilter(amazonImportRuns.createdAt, input)
        );
        const [count] = await db
          .select({ total: sql<number>`count(*)::int` })
          .from(amazonImportRuns)
          .where(filter)
          .limit(1);
        const items = await db
          .select({
            id: amazonImportRuns.id,
            windowStart: amazonImportRuns.windowStart,
            windowEnd: amazonImportRuns.windowEnd,
            status: amazonImportRuns.status,
            dryRun: amazonImportRuns.dryRun,
            summary: amazonImportRuns.summary,
            error: amazonImportRuns.error,
            createdAt: amazonImportRuns.createdAt,
          })
          .from(amazonImportRuns)
          .where(filter)
          .orderBy(desc(amazonImportRuns.createdAt), desc(amazonImportRuns.id))
          .limit(input.limit)
          .offset(input.offset);
        return { items, total: count?.total ?? 0 };
      }),
    observations: adminProcedure
      .input(
        z.object({ storeId: uuidSchema, runId: uuidSchema, ...pagination })
      )
      .query(async ({ input, ctx }) => {
        const db = await database();
        await authorizedStore(db, ctx.activeCompanyId, input.storeId);
        const [run] = await db
          .select({ id: amazonImportRuns.id })
          .from(amazonImportRuns)
          .where(
            and(
              eq(amazonImportRuns.id, input.runId),
              eq(amazonImportRuns.storeId, input.storeId)
            )
          )
          .limit(1);
        if (!run)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Import non trovato nello store autorizzato",
          });
        const [count] = await db
          .select({ total: sql<number>`count(*)::int` })
          .from(amazonImportRowObservations)
          .where(eq(amazonImportRowObservations.runId, input.runId))
          .limit(1);
        const rows = await db
          .select({
            id: amazonImportRowObservations.id,
            itemId: amazonImportRowObservations.itemId,
            source: amazonImportRowObservations.sourceRow,
            outcome: amazonImportRowObservations.outcome,
            reason: amazonImportRowObservations.reason,
            planned: amazonImportRowObservations.plannedAllocations,
            sku: marketplaceOrderItems.channelSku,
            quantity: marketplaceOrderItems.channelQuantity,
            pieces: marketplaceOrderItems.piecesQuantity,
            actualPieces: marketplaceOrderItems.amazonPiecesProcessed,
            productName: products.name,
            purchaseDate: marketplaceOrderItems.amazonPurchaseDate,
            updatedAt: marketplaceOrderItems.amazonUpdatedAt,
          })
          .from(amazonImportRowObservations)
          .leftJoin(
            marketplaceOrderItems,
            eq(marketplaceOrderItems.id, amazonImportRowObservations.itemId)
          )
          .leftJoin(products, eq(products.id, marketplaceOrderItems.productId))
          .where(eq(amazonImportRowObservations.runId, input.runId))
          .orderBy(
            asc(amazonImportRowObservations.createdAt),
            asc(amazonImportRowObservations.id)
          )
          .limit(input.limit)
          .offset(input.offset);
        const itemIds = rows.flatMap(row => (row.itemId ? [row.itemId] : []));
        const previews = rows.map(row => previewAllocations(row.planned));
        const batchIds = Array.from(
          new Set(
            previews.flatMap(entries =>
              entries.flatMap(entry => (entry.batchId ? [entry.batchId] : []))
            )
          )
        );
        const plannedBatches = batchIds.length
          ? await db
              .select({
                id: productBatches.id,
                batchNumber: productBatches.batchNumber,
                productName: products.name,
                productionDate: productBatches.productionDate,
                expirationDate: productBatches.expirationDate,
              })
              .from(productBatches)
              .innerJoin(products, eq(products.id, productBatches.productId))
              .where(
                and(
                  inArray(productBatches.id, batchIds),
                  eq(productBatches.companyId, ctx.activeCompanyId)
                )
              )
              .limit(5_000)
          : [];
        const allocations = itemIds.length
          ? await db
              .select({
                itemId: amazonStockAllocations.itemId,
                productName: products.name,
                batchNumber: productBatches.batchNumber,
                expirationDate: productBatches.expirationDate,
                productionDate: productBatches.productionDate,
                pieces: amazonStockAllocations.pieces,
                amazonUpdatedAt: amazonStockAllocations.amazonUpdatedAt,
              })
              .from(amazonStockAllocations)
              .innerJoin(
                products,
                eq(products.id, amazonStockAllocations.productId)
              )
              .innerJoin(
                productBatches,
                eq(productBatches.id, amazonStockAllocations.batchId)
              )
              .innerJoin(
                amazonImportRuns,
                eq(amazonImportRuns.id, amazonStockAllocations.runId)
              )
              .where(
                and(
                  inArray(amazonStockAllocations.itemId, itemIds),
                  eq(amazonImportRuns.storeId, input.storeId),
                  eq(productBatches.companyId, ctx.activeCompanyId)
                )
              )
              .orderBy(asc(productBatches.expirationDate))
              .limit(5_000)
          : [];
        return {
          total: count?.total ?? 0,
          items: rows.map(row => ({
            id: row.id,
            itemId: row.itemId,
            outcome: row.outcome,
            reason: row.reason,
            orderId: sourceText(
              row.source,
              "amazon-order-id",
              "amazonOrderId",
              "orderId"
            ),
            sku: sourceText(row.source, "sku") ?? row.sku,
            productName:
              row.productName ??
              sourceText(row.source, "product-name", "productName"),
            quantity:
              sourceText(row.source, "quantity", "quantity-purchased") ??
              row.quantity,
            pieces: row.pieces,
            purchaseDate:
              sourceText(row.source, "purchase-date", "purchaseDate") ??
              row.purchaseDate?.toISOString(),
            updatedAt:
              sourceText(row.source, "last-updated-date", "updatedAt") ??
              row.updatedAt?.toISOString(),
            fulfillmentChannel: sourceText(
              row.source,
              "fulfillment-channel",
              "fulfillmentChannel"
            ),
            itemStatus: sourceText(row.source, "item-status", "itemStatus"),
            // Current item ledger total can include later runs. Label it as cumulative, not this observation's movement.
            actualPieces: row.actualPieces ?? 0,
            plannedAllocations: previewAllocations(row.planned).map(entry => {
              const batch = plannedBatches.find(
                candidate => candidate.id === entry.batchId
              );
              return {
                ...entry,
                productName: batch?.productName ?? entry.productName,
                batchNumber: batch?.batchNumber ?? entry.batchNumber,
                productionDate: batch?.productionDate ?? entry.productionDate,
                expirationDate: entry.expirationDate ?? batch?.expirationDate,
              };
            }),
            allocations: allocations.filter(
              entry => entry.itemId === row.itemId
            ),
          })),
        };
      }),
  }),
  orders: router({
    list: adminProcedure
      .input(
        period.safeExtend({ ...pagination, status: stockStatus.optional() })
      )
      .query(async ({ input, ctx }) => {
        const db = await database();
        await authorizedStore(db, ctx.activeCompanyId, input.storeId);
        const filter = and(
          eq(marketplaceOrders.storeId, input.storeId),
          eq(salesStores.channel, "amazon"),
          eq(salesStores.companyId, ctx.activeCompanyId),
          sql`${marketplaceOrders.orderDate} >= (${input.dateFrom}::date::timestamp AT TIME ZONE 'Europe/Rome')`,
          sql`${marketplaceOrders.orderDate} < ((${input.dateTo}::date + 1)::timestamp AT TIME ZONE 'Europe/Rome')`,
          input.status
            ? eq(marketplaceOrderItems.amazonStockStatus, input.status)
            : undefined,
          isNotNull(marketplaceOrderItems.amazonOrderItemId)
        );
        const [count] = await db
          .select({ total: sql<number>`count(*)::int` })
          .from(marketplaceOrderItems)
          .innerJoin(
            marketplaceOrders,
            eq(marketplaceOrders.id, marketplaceOrderItems.marketplaceOrderId)
          )
          .innerJoin(salesStores, eq(salesStores.id, marketplaceOrders.storeId))
          .where(filter)
          .limit(1);
        const items = await db
          .select({
            id: marketplaceOrderItems.id,
            orderId: marketplaceOrderItems.amazonOrderId,
            orderItemId: marketplaceOrderItems.amazonOrderItemId,
            sku: marketplaceOrderItems.channelSku,
            productName: products.name,
            quantity: marketplaceOrderItems.channelQuantity,
            pieces: marketplaceOrderItems.piecesQuantity,
            actualPieces: marketplaceOrderItems.amazonPiecesProcessed,
            status: marketplaceOrderItems.amazonStockStatus,
            reason: marketplaceOrderItems.amazonStockReason,
            purchaseDate: marketplaceOrderItems.amazonPurchaseDate,
            updatedAt: marketplaceOrderItems.amazonUpdatedAt,
            itemStatus: marketplaceOrderItems.amazonItemStatus,
            orderStatus: marketplaceOrderItems.amazonOrderStatus,
            fulfillmentChannel: marketplaceOrderItems.amazonFulfillmentChannel,
          })
          .from(marketplaceOrderItems)
          .innerJoin(
            marketplaceOrders,
            eq(marketplaceOrders.id, marketplaceOrderItems.marketplaceOrderId)
          )
          .innerJoin(salesStores, eq(salesStores.id, marketplaceOrders.storeId))
          .leftJoin(products, eq(products.id, marketplaceOrderItems.productId))
          .where(filter)
          .orderBy(
            desc(marketplaceOrders.orderDate),
            desc(marketplaceOrderItems.id)
          )
          .limit(input.limit)
          .offset(input.offset);
        return { items, total: count?.total ?? 0 };
      }),
    requeueReview: adminProcedure
      .input(
        z.object({
          storeId: uuidSchema,
          itemId: uuidSchema,
          confirm: z.literal(true),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const db = await database();
        await authorizedStore(db, ctx.activeCompanyId, input.storeId);
        await db.transaction(async tx => {
          await tx
            .select({ storeId: amazonImportConfigs.storeId })
            .from(amazonImportConfigs)
            .where(eq(amazonImportConfigs.storeId, input.storeId))
            .limit(1)
            .for("update");
          const [changed] = await tx
            .update(marketplaceOrderItems)
            .set({
              amazonStockStatus: "pending",
              amazonStockReason:
                "Revisione rimessa in coda manualmente da admin",
            })
            .where(
              and(
                eq(marketplaceOrderItems.id, input.itemId),
                eq(marketplaceOrderItems.amazonStockStatus, "review_required"),
                eq(marketplaceOrderItems.amazonPiecesProcessed, 0),
                eq(marketplaceOrderItems.amazonFulfillmentChannel, "Merchant"),
                eq(marketplaceOrderItems.amazonItemStatus, "Shipped"),
                inArray(marketplaceOrderItems.amazonOrderStatus, [
                  "Shipped",
                  "PartiallyShipped",
                ]),
                isNotNull(marketplaceOrderItems.amazonLastRunId),
                sql`EXISTS (SELECT 1 FROM marketplace_orders mo JOIN sales_stores ss ON ss.id = mo."storeId"
              WHERE mo.id = ${marketplaceOrderItems.marketplaceOrderId} AND ss.id = ${input.storeId}::uuid
              AND ss.channel = 'amazon' AND ss."companyId" = ${ctx.activeCompanyId}::uuid AND ss."isActive" = true)`,
                sql`NOT EXISTS (SELECT 1 FROM amazon_stock_allocations a WHERE a.item_id = ${marketplaceOrderItems.id})`
              )
            )
            .returning({
              id: marketplaceOrderItems.id,
              runId: marketplaceOrderItems.amazonLastRunId,
            });
          if (!changed?.runId)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Riga non idonea: sono ammesse solo revisioni Merchant/Shipped non cancellate e mai scaricate",
            });
          // Only the current receipt is reopened; previous review history is retained.
          await tx
            .update(amazonImportRowObservations)
            .set({ outcome: "pending", reason: "explicit_admin_retry" })
            .where(
              and(
                eq(amazonImportRowObservations.itemId, changed.id),
                eq(amazonImportRowObservations.runId, changed.runId),
                eq(amazonImportRowObservations.outcome, "review_required")
              )
            );
        });
        return {
          message:
            "Riga rimessa in coda. Nessuno stock scaricato: usa Processa coda dopo la verifica della mappatura e della disponibilità.",
        };
      }),
  }),
  processQueue: adminProcedure
    .input(
      z.object({
        storeId: uuidSchema,
        limit: z.number().int().min(1).max(50).default(50),
        confirmRealStock: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await database();
      const store = await authorizedStore(
        db,
        ctx.activeCompanyId,
        input.storeId
      );
      if (!store.enabled)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Abilita l’import Amazon prima di processare la coda",
        });
      // Mode can change between this read and the core worker's config lock.
      // Always require consent, even when the UI currently observes dry-run.
      if (!input.confirmRealStock)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Conferma l’elaborazione e il possibile scarico reale se la configurazione viene cambiata: coda pendente e dry-run storici idonei",
        });
      // The core service owns idempotency, cutoff, eligibility, FEFO and transactional stock writes.
      const { processPendingAmazonItems } = await import(
        "./services/amazonOrderImportService"
      );
      const result = await processPendingAmazonItems(
        input.storeId,
        input.limit
      );
      const counts = `Tentate: ${result.attempted}; scaricate: ${result.processed}; prova: ${result.dryRun}; revisioni: ${result.reviewRequired}; escluse: ${result.skipped}; errori: ${result.errors.length}.`;
      return {
        result,
        message: `${counts} Verifica gli esiti e i pezzi realmente scaricati nel registro. Cancellazioni e resi non sono stornati automaticamente.`,
      };
    }),
});
