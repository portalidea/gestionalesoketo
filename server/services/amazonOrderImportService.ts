import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { EKETO_COMPANY_ID } from "../../shared/const";
import {
  amazonImportConfigs,
  amazonImportRuns,
  amazonImportRowObservations,
  amazonStockAllocations,
  channelVariants,
  channelVariantComponents,
  companies,
  inventoryByBatch,
  locations,
  marketplaceOrders,
  marketplaceOrderItems,
  productBatches,
  products,
  stockMovements,
  salesStores,
  type AmazonImportConfig,
  type MarketplaceOrderItem,
} from "../../drizzle/schema";
import {
  amazonRomeDate,
  classifyAmazonRow,
  parseAmazonReport,
  planAmazonFefo,
  type AmazonReportRow,
  type AmazonStockStatus,
  type AmazonProductRequirement,
  type AmazonFefoAllocation,
} from "./amazonOrderImportHelpers";
import { AmazonImportError, amazonImportError } from "./amazonImportErrors";

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export interface AmazonImportSummary {
  rows: number;
  outcomes: Record<string, number>;
  pending: number;
  reviewRequired: number;
  completed: boolean;
}
export interface AmazonWorkerSummary {
  attempted: number;
  processed: number;
  dryRun: number;
  reviewRequired: number;
  skipped: number;
  errors: Array<{ itemId: string; message: string }>;
}
interface Mapping {
  variantId: string;
  productId: string | null;
  requirements: AmazonProductRequirement[];
}
interface Snapshot {
  source: Record<string, string>;
  frozenMapping?: Mapping;
}
const message = (error: unknown) => amazonImportError(error).message;
async function database(): Promise<Database> {
  const db = await getDb();
  if (!db) throw new AmazonImportError("DATABASE_UNAVAILABLE");
  return db;
}

/** Config is the serialization point shared by receipts, workers and manual edits.
 * No company/browser scope argument is accepted; the trusted constant is verified.
 */
async function lockConfig(
  tx: Transaction,
  storeId: string
): Promise<AmazonImportConfig> {
  const [config] = await tx
    .select()
    .from(amazonImportConfigs)
    .where(eq(amazonImportConfigs.storeId, storeId))
    .limit(1)
    .for("update");
  if (!config) throw new AmazonImportError("STORE_UNCONFIGURED");
  const [scope] = await tx
    .select({
      channel: salesStores.channel,
      active: salesStores.isActive,
      companyId: salesStores.companyId,
      companyActive: companies.isActive,
    })
    .from(salesStores)
    .innerJoin(companies, eq(companies.id, salesStores.companyId))
    .where(eq(salesStores.id, storeId))
    .limit(1)
    .for("share");
  if (
    !scope ||
    scope.channel !== "amazon" ||
    !scope.active ||
    !scope.companyActive ||
    scope.companyId !== EKETO_COMPANY_ID
  )
    throw new AmazonImportError("STORE_SCOPE");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.purchaseCutoff))
    throw new AmazonImportError("INVALID_CUTOFF");
  return config;
}

async function runSummary(
  tx: Transaction,
  runId: string
): Promise<AmazonImportSummary> {
  const counts = await tx
    .select({
      outcome: amazonImportRowObservations.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(amazonImportRowObservations)
    .where(eq(amazonImportRowObservations.runId, runId))
    .groupBy(amazonImportRowObservations.outcome);
  const outcomes = Object.fromEntries(counts.map(c => [c.outcome, c.count]));
  const pending = outcomes.pending ?? 0;
  return {
    rows: counts.reduce((sum, c) => sum + c.count, 0),
    outcomes,
    pending,
    reviewRequired:
      (outcomes.review_required ?? 0) + (outcomes.post_stock_alert ?? 0),
    completed: pending === 0,
  };
}
async function finishRun(
  tx: Transaction,
  config: AmazonImportConfig,
  runId: string
): Promise<AmazonImportSummary> {
  const [run] = await tx
    .select()
    .from(amazonImportRuns)
    .where(
      and(
        eq(amazonImportRuns.id, runId),
        eq(amazonImportRuns.storeId, config.storeId)
      )
    )
    .limit(1)
    .for("update");
  if (!run) throw new AmazonImportError("RUN_NOT_FOUND");
  const summary = await runSummary(tx, runId);
  if (!run.documentSha256 || ["fatal", "cancelled"].includes(run.status))
    return { ...summary, completed: false };
  await tx
    .update(amazonImportRuns)
    .set({
      summary: sql`${amazonImportRuns.summary} || ${JSON.stringify(summary)}::jsonb`,
      status: summary.completed ? "completed" : "processing",
      updatedAt: new Date(),
    })
    .where(eq(amazonImportRuns.id, runId));
  if (summary.completed)
    await tx
      .update(amazonImportConfigs)
      .set({
        checkpointAt: sql`greatest(coalesce(${amazonImportConfigs.checkpointAt}, ${run.windowEnd.toISOString()}::timestamptz), ${run.windowEnd.toISOString()}::timestamptz)`,
        updatedAt: new Date(),
      })
      .where(eq(amazonImportConfigs.storeId, config.storeId));
  return summary;
}

function rowClassification(row: AmazonReportRow, config: AmazonImportConfig) {
  return classifyAmazonRow(row, config.purchaseCutoff);
}
function statusConflict(
  item: MarketplaceOrderItem,
  row: AmazonReportRow
): boolean {
  return (
    item.amazonItemStatus !== row.itemStatus ||
    item.amazonOrderStatus !== row.orderStatus ||
    item.amazonFulfillmentChannel !== row.fulfillmentChannel ||
    item.channelSku !== row.sku ||
    item.channelQuantity !== row.quantity ||
    item.amazonPurchaseDate?.getTime() !== row.purchaseDate.getTime()
  );
}
function stockFrozen(item: MarketplaceOrderItem): boolean {
  return (
    item.amazonPiecesProcessed > 0 ||
    item.amazonStockStatus === "processed" ||
    item.amazonStockStatus === "post_stock_alert"
  );
}
async function observe(
  tx: Transaction,
  runId: string,
  row: AmazonReportRow,
  itemId: string | null,
  outcome: string,
  reason: string | null,
  plan: AmazonFefoAllocation[] = []
) {
  await tx.insert(amazonImportRowObservations).values({
    runId,
    rowKey: row.rowKey,
    itemId,
    sourceRow: row.source,
    outcome,
    reason,
    plannedAllocations: plan,
  });
}

/** Header is a display aggregate only: stock remains strictly item-managed. */
async function reconcileOrder(tx: Transaction, orderId: string) {
  const [counts] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      processed: sql<number>`count(*) filter (where ${marketplaceOrderItems.amazonStockStatus} = 'processed')::int`,
      pending: sql<number>`count(*) filter (where ${marketplaceOrderItems.amazonStockStatus} = 'pending')::int`,
      dryRun: sql<number>`count(*) filter (where ${marketplaceOrderItems.amazonStockStatus} = 'dry_run')::int`,
      reviews: sql<number>`count(*) filter (where ${marketplaceOrderItems.amazonStockStatus} in ('review_required','post_stock_alert'))::int`,
      gross: sql<string>`coalesce(sum(coalesce(${marketplaceOrderItems.lineTotal}, 0) + CASE WHEN (${marketplaceOrderItems.amazonSourceSnapshot}->'source'->>'item-tax') ~ '^[0-9]+[.][0-9]{2}$' THEN (${marketplaceOrderItems.amazonSourceSnapshot}->'source'->>'item-tax')::numeric ELSE 0 END), 0)::text`,
    })
    .from(marketplaceOrderItems)
    .where(eq(marketplaceOrderItems.marketplaceOrderId, orderId));
  const status = counts.reviews
    ? counts.processed
      ? "partial"
      : "review_required"
    : counts.pending
      ? counts.processed
        ? "partial"
        : "pending"
      : counts.dryRun
        ? "dry_run"
        : counts.processed
          ? "processed"
          : "skipped";
  await tx
    .update(marketplaceOrders)
    .set({
      totalGross: counts.gross,
      stockProcessingStatus: status,
      stockProcessingError: counts.reviews
        ? "Amazon item review required"
        : null,
      ...(status === "processed" ? { stockProcessedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(marketplaceOrders.id, orderId));
}

/** Parse completely BEFORE opening a transaction. Receipt, every item and every
 * observation become durable together, without touching stock or an external API.
 * Worker calls are deliberately separate so cancellations in the receipt win.
 */
export async function ingestAmazonReport(input: {
  storeId: string;
  runId: string;
  reportId: string;
  reportDocumentId: string;
  body: Buffer;
  compression?: string;
}): Promise<AmazonImportSummary> {
  if (!input.reportId.trim()) throw new AmazonImportError("REPORT_ID_INVALID");
  if (!input.reportDocumentId.trim())
    throw new AmazonImportError("DOCUMENT_ID_INVALID");
  const rows = parseAmazonReport(input.body, input.compression);
  const digest = createHash("sha256").update(input.body).digest("hex");
  const db = await database();
  return db.transaction(async tx => {
    const config = await lockConfig(tx, input.storeId);
    if (!config.enabled) throw new AmazonImportError("STORE_DISABLED");
    const [run] = await tx
      .select()
      .from(amazonImportRuns)
      .where(
        and(
          eq(amazonImportRuns.id, input.runId),
          eq(amazonImportRuns.storeId, input.storeId)
        )
      )
      .limit(1)
      .for("update");
    if (!run) throw new AmazonImportError("RUN_NOT_FOUND");
    if (run.reportId && run.reportId !== input.reportId)
      throw new AmazonImportError("REPORT_ID_MISMATCH");
    if (run.documentSha256) {
      if (
        run.documentSha256 !== digest ||
        run.reportId !== input.reportId ||
        run.reportDocumentId !== input.reportDocumentId
      )
        throw new AmazonImportError("DOCUMENT_REPLAY_MISMATCH");
      return runSummary(tx, run.id);
    }
    if (!["requested", "pending", "processing"].includes(run.status))
      throw new AmazonImportError("EXECUTION_STATE");
    await tx
      .update(amazonImportRuns)
      .set({
        reportId: input.reportId,
        reportDocumentId: input.reportDocumentId,
        documentSha256: digest,
        dryRun: config.dryRun,
        status: "processing",
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(amazonImportRuns.id, run.id));
    const touchedOrders = new Set<string>();
    for (const row of rows) {
      // Le righe già gestite a mano non diventano vendite marketplace importate:
      // restano soltanto nell'audit del report, anche se ripetute/annullate.
      if (
        row.source["purchase-date"] &&
        amazonRomeDate(row.purchaseDate) < config.purchaseCutoff
      ) {
        await observe(
          tx,
          run.id,
          row,
          null,
          "pre_cutoff",
          "pre-cutoff, già gestite a mano"
        );
        continue;
      }
      if (row.quarantineReason) {
        const [known] =
          row.orderId && row.orderItemId
            ? await tx
                .select()
                .from(marketplaceOrderItems)
                .where(
                  and(
                    eq(
                      marketplaceOrderItems.amazonSellerAccountId,
                      config.sellerAccountId
                    ),
                    eq(marketplaceOrderItems.amazonOrderId, row.orderId),
                    eq(marketplaceOrderItems.amazonOrderItemId, row.orderItemId)
                  )
                )
                .limit(1)
                .for("update")
            : [];
        if (
          known &&
          row.updatedAt.getTime() >= known.amazonUpdatedAt!.getTime()
        ) {
          const outcome = stockFrozen(known)
            ? "post_stock_alert"
            : "review_required";
          await tx
            .update(marketplaceOrderItems)
            .set({
              amazonStockStatus: outcome,
              amazonStockReason: row.quarantineReason,
              amazonUpdatedAt: row.updatedAt,
              amazonLastRunId: run.id,
            })
            .where(eq(marketplaceOrderItems.id, known.id));
          await tx
            .update(amazonImportRowObservations)
            .set({ outcome, reason: row.quarantineReason })
            .where(
              and(
                eq(amazonImportRowObservations.itemId, known.id),
                eq(amazonImportRowObservations.outcome, "pending")
              )
            );
          touchedOrders.add(known.marketplaceOrderId);
          await observe(
            tx,
            run.id,
            row,
            known.id,
            outcome,
            row.quarantineReason
          );
        } else
          await observe(
            tx,
            run.id,
            row,
            known?.id ?? null,
            "review_required",
            row.quarantineReason
          );
        continue;
      }
      const [existing] = await tx
        .select()
        .from(marketplaceOrderItems)
        .where(
          and(
            eq(
              marketplaceOrderItems.amazonSellerAccountId,
              config.sellerAccountId
            ),
            eq(marketplaceOrderItems.amazonOrderId, row.orderId),
            eq(marketplaceOrderItems.amazonOrderItemId, row.orderItemId)
          )
        )
        .limit(1)
        .for("update");
      const classification = rowClassification(row, config);
      if (!existing) {
        const [order] = await tx
          .insert(marketplaceOrders)
          .values({
            storeId: input.storeId,
            channelOrderId: row.orderId,
            channelOrderNumber: row.orderId,
            orderDate: row.purchaseDate,
            currency:
              row.source.currency ||
              rows.find(
                candidate =>
                  candidate.orderId === row.orderId &&
                  ["EUR", "GBP"].includes(candidate.source.currency)
              )?.source.currency ||
              "EUR",
            stockProcessingStatus: "amazon_item_managed",
          })
          .onConflictDoUpdate({
            target: [
              marketplaceOrders.storeId,
              marketplaceOrders.channelOrderId,
            ],
            set: { channelOrderNumber: row.orderId },
          })
          .returning({
            id: marketplaceOrders.id,
            currency: marketplaceOrders.currency,
          });
        if (row.source.currency && row.source.currency !== order.currency) {
          await observe(
            tx,
            run.id,
            row,
            null,
            "review_required",
            "order_currency_mismatch"
          );
          continue;
        }
        const [item] = await tx
          .insert(marketplaceOrderItems)
          .values({
            marketplaceOrderId: order.id,
            channelSku: row.sku,
            channelQuantity: row.quantity,
            piecesQuantity: 0,
            unitPrice: row.unitPrice,
            lineTotal: row.lineTotal,
            amazonSellerAccountId: config.sellerAccountId,
            amazonOrderId: row.orderId,
            amazonOrderItemId: row.orderItemId,
            amazonPurchaseDate: row.purchaseDate,
            amazonUpdatedAt: row.updatedAt,
            amazonItemStatus: row.itemStatus,
            amazonOrderStatus: row.orderStatus,
            amazonFulfillmentChannel: row.fulfillmentChannel,
            amazonStockStatus: classification.status,
            amazonStockReason: classification.reason,
            amazonSourceSnapshot: { source: row.source } satisfies Snapshot,
            amazonLastRunId: run.id,
          })
          .returning({ id: marketplaceOrderItems.id });
        await observe(
          tx,
          run.id,
          row,
          item.id,
          classification.status,
          classification.reason
        );
        touchedOrders.add(order.id);
        continue;
      }
      touchedOrders.add(existing.marketplaceOrderId);
      const age = row.updatedAt.getTime() - existing.amazonUpdatedAt!.getTime();
      if (age < 0) {
        await observe(
          tx,
          run.id,
          row,
          existing.id,
          "stale_snapshot",
          "older_amazon_update"
        );
        continue;
      }
      if (
        row.source.currency &&
        row.source.currency !==
          (existing.amazonSourceSnapshot as Snapshot)?.source.currency
      ) {
        const outcome = stockFrozen(existing)
          ? "post_stock_alert"
          : "review_required";
        await publishOutcome(tx, existing, outcome, "order_currency_mismatch");
        await observe(
          tx,
          run.id,
          row,
          existing.id,
          outcome,
          "order_currency_mismatch"
        );
        continue;
      }
      const changed = statusConflict(existing, row);
      if (!age && !changed) {
        const outcome =
          existing.amazonStockStatus === "dry_run" && !config.dryRun
            ? "pending"
            : existing.amazonStockStatus!;
        await observe(
          tx,
          run.id,
          row,
          existing.id,
          outcome,
          existing.amazonStockReason,
          existing.amazonFefoPreview as AmazonFefoAllocation[]
        );
        continue;
      }
      let status = classification.status;
      let reason = classification.reason;
      const frozen = stockFrozen(existing);
      if (frozen) {
        status =
          changed || existing.amazonStockStatus === "post_stock_alert"
            ? "post_stock_alert"
            : "processed";
        reason =
          status === "post_stock_alert"
            ? "amazon_changed_after_stock_no_reversal"
            : null;
      } else if (!age && changed) {
        status = "review_required";
        reason = "equal_timestamp_conflict";
      } else if (
        existing.amazonStockStatus === "review_required" &&
        status === "pending"
      ) {
        status = "review_required";
        reason = existing.amazonStockReason ?? "explicit_admin_retry_required";
      } else if (
        existing.amazonStockStatus === "cancelled" &&
        status === "pending"
      ) {
        status = "review_required";
        reason = "shipped_after_cancellation_requires_review";
      }
      // At equal conflicting timestamps, preserve an observed cancellation in
      // the authoritative current snapshot, regardless of report row order.
      const keepCancellation =
        age === 0 &&
        (existing.amazonOrderStatus === "Cancelled" ||
          existing.amazonItemStatus === "Cancelled");
      const previousSnapshot = existing.amazonSourceSnapshot as Snapshot | null;
      await tx
        .update(marketplaceOrderItems)
        .set({
          ...(!frozen && classification.status !== "cancelled"
            ? {
                channelSku: row.sku,
                channelQuantity: row.quantity,
                unitPrice: row.unitPrice,
                lineTotal: row.lineTotal,
                productId: null,
                channelVariantId: null,
                piecesQuantity: 0,
                amazonFefoPreview: [],
              }
            : {}),
          amazonPurchaseDate: row.purchaseDate,
          amazonUpdatedAt: row.updatedAt,
          amazonItemStatus: keepCancellation
            ? existing.amazonItemStatus
            : row.itemStatus,
          amazonOrderStatus: keepCancellation
            ? existing.amazonOrderStatus
            : row.orderStatus,
          amazonFulfillmentChannel: keepCancellation
            ? existing.amazonFulfillmentChannel
            : row.fulfillmentChannel,
          amazonStockStatus: status,
          amazonStockReason: reason,
          amazonLastRunId: run.id,
          amazonSourceSnapshot: {
            source: keepCancellation
              ? (previousSnapshot?.source ?? row.source)
              : row.source,
            ...(previousSnapshot?.frozenMapping
              ? { frozenMapping: previousSnapshot.frozenMapping }
              : {}),
          } satisfies Snapshot,
        })
        .where(eq(marketplaceOrderItems.id, existing.id));
      // Pending rows in this or an earlier receipt cannot consume a snapshot
      // which a later row in the same atomic receipt cancelled/quarantined.
      if (status !== "pending")
        await tx
          .update(amazonImportRowObservations)
          .set({ outcome: status, reason })
          .where(
            and(
              eq(amazonImportRowObservations.itemId, existing.id),
              eq(amazonImportRowObservations.outcome, "pending")
            )
          );
      await observe(tx, run.id, row, existing.id, status, reason);
    }
    for (const orderId of Array.from(touchedOrders))
      await reconcileOrder(tx, orderId);
    return finishRun(tx, config, run.id);
  });
}

async function mappingForItem(
  tx: Transaction,
  storeId: string,
  item: MarketplaceOrderItem
): Promise<Mapping | null> {
  const [variant] = await tx
    .select({
      id: channelVariants.id,
      productId: channelVariants.productId,
      multiplier: channelVariants.multiplier,
      isBundle: channelVariants.isBundle,
    })
    .from(channelVariants)
    .where(
      and(
        eq(channelVariants.storeId, storeId),
        eq(channelVariants.channelSku, item.channelSku),
        eq(channelVariants.isActive, true)
      )
    )
    .limit(1)
    .for("share");
  if (!variant) return null;
  let requirements: AmazonProductRequirement[];
  if (variant.isBundle) {
    const components = await tx
      .select({
        productId: channelVariantComponents.productId,
        quantity: channelVariantComponents.quantity,
      })
      .from(channelVariantComponents)
      .where(eq(channelVariantComponents.channelVariantId, variant.id))
      .orderBy(asc(channelVariantComponents.productId))
      .for("share");
    if (!components.length) return null;
    requirements = components.map(c => ({
      productId: c.productId,
      pieces: c.quantity * item.channelQuantity,
    }));
  } else {
    if (!variant.productId || variant.multiplier <= 0) return null;
    requirements = [
      {
        productId: variant.productId,
        pieces: variant.multiplier * item.channelQuantity,
      },
    ];
  }
  if (
    requirements.some(
      r =>
        !Number.isSafeInteger(r.pieces) ||
        r.pieces <= 0 ||
        r.pieces > 2147483647
    ) ||
    requirements.reduce((s, r) => s + r.pieces, 0) > 2147483647
  )
    return null;
  const productIds = Array.from(new Set(requirements.map(r => r.productId)));
  // Products has no isActive column; only active channel variants are eligible.
  const active = await tx
    .select({ id: products.id })
    .from(products)
    .where(inArray(products.id, productIds))
    .limit(productIds.length)
    .for("share");
  if (active.length !== productIds.length) return null;
  return {
    variantId: variant.id,
    productId: variant.isBundle ? null : variant.productId,
    requirements,
  };
}

async function publishOutcome(
  tx: Transaction,
  item: MarketplaceOrderItem,
  status: AmazonStockStatus,
  reason: string | null,
  plan: AmazonFefoAllocation[] = []
) {
  await tx
    .update(marketplaceOrderItems)
    .set({
      amazonStockStatus: status,
      amazonStockReason: reason,
      amazonFefoPreview: plan,
    })
    .where(eq(marketplaceOrderItems.id, item.id));
  const observations = await tx
    .update(amazonImportRowObservations)
    .set({ outcome: status, reason, plannedAllocations: plan })
    .where(
      and(
        eq(amazonImportRowObservations.itemId, item.id),
        inArray(amazonImportRowObservations.outcome, [
          "pending",
          ...(status === "processed" ? ["dry_run"] : []),
        ])
      )
    )
    .returning({ runId: amazonImportRowObservations.runId });
  await reconcileOrder(tx, item.marketplaceOrderId);
  return Array.from(
    new Set([item.amazonLastRunId!, ...observations.map(o => o.runId)])
  );
}

/** Bounded queue: reviews never retry automatically. Live mode also picks up
 * persisted dry-run items. Config+item+all component stock are locked in one TX;
 * every component is planned first, then ledger+movement+decrement commit once.
 */
export async function processPendingAmazonItems(
  storeId: string,
  limit = 50
): Promise<AmazonWorkerSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Amazon worker limit must be 1..200");
  const db = await database();
  const summary: AmazonWorkerSummary = {
    attempted: 0,
    processed: 0,
    dryRun: 0,
    reviewRequired: 0,
    skipped: 0,
    errors: [],
  };
  const candidates = await db.transaction(async tx => {
    const config = await lockConfig(tx, storeId);
    if (!config.enabled) return [];
    return tx
      .select({ id: marketplaceOrderItems.id })
      .from(marketplaceOrderItems)
      .innerJoin(
        marketplaceOrders,
        eq(marketplaceOrders.id, marketplaceOrderItems.marketplaceOrderId)
      )
      .where(
        and(
          eq(marketplaceOrders.storeId, storeId),
          eq(
            marketplaceOrderItems.amazonSellerAccountId,
            config.sellerAccountId
          ),
          inArray(
            marketplaceOrderItems.amazonStockStatus,
            config.dryRun ? ["pending"] : ["pending", "dry_run"]
          )
        )
      )
      .orderBy(
        asc(marketplaceOrderItems.amazonUpdatedAt),
        asc(marketplaceOrderItems.id)
      )
      .limit(limit);
  });
  for (const candidate of candidates) {
    summary.attempted++;
    try {
      const status = await db.transaction(async tx => {
        const config = await lockConfig(tx, storeId);
        if (!config.enabled) return "skipped";
        const [item] = await tx
          .select()
          .from(marketplaceOrderItems)
          .where(
            and(
              eq(marketplaceOrderItems.id, candidate.id),
              eq(
                marketplaceOrderItems.amazonSellerAccountId,
                config.sellerAccountId
              )
            )
          )
          .limit(1)
          .for("update");
        if (
          !item ||
          !item.amazonLastRunId ||
          !["pending", ...(!config.dryRun ? ["dry_run"] : [])].includes(
            item.amazonStockStatus ?? ""
          ) ||
          stockFrozen(item)
        )
          return "skipped";
        const [order] = await tx
          .select({ storeId: marketplaceOrders.storeId })
          .from(marketplaceOrders)
          .where(eq(marketplaceOrders.id, item.marketplaceOrderId))
          .limit(1);
        if (order?.storeId !== storeId)
          throw new Error("Amazon item/store mismatch");
        const classification = classifyAmazonRow(
          {
            purchaseDate: item.amazonPurchaseDate!,
            itemStatus: item.amazonItemStatus!,
            orderStatus: item.amazonOrderStatus!,
            fulfillmentChannel: item.amazonFulfillmentChannel!,
          },
          config.purchaseCutoff
        );
        if (classification.status !== "pending") {
          const runs = await publishOutcome(
            tx,
            item,
            classification.status,
            classification.reason
          );
          for (const runId of runs) await finishRun(tx, config, runId);
          return classification.status;
        }
        const mapping = await mappingForItem(tx, storeId, item);
        const [warehouse] = await tx
          .select({ id: locations.id })
          .from(locations)
          .where(
            and(
              eq(locations.companyId, EKETO_COMPANY_ID),
              eq(locations.type, "central_warehouse"),
              eq(locations.isActive, true)
            )
          )
          .limit(1)
          .for("share");
        if (!mapping || !warehouse) {
          const runs = await publishOutcome(
            tx,
            item,
            "review_required",
            !mapping
              ? "missing_or_invalid_sku_mapping"
              : "missing_active_eketo_central_warehouse"
          );
          for (const runId of runs) await finishRun(tx, config, runId);
          return "review_required";
        }
        const pieces = mapping.requirements.reduce(
          (sum, r) => sum + r.pieces,
          0
        );
        await tx
          .update(marketplaceOrderItems)
          .set({
            productId: mapping.productId,
            channelVariantId: mapping.variantId,
            piecesQuantity: pieces,
          })
          .where(eq(marketplaceOrderItems.id, item.id));
        const lotsQuery = tx
          .select({
            productId: productBatches.productId,
            batchId: productBatches.id,
            inventoryId: inventoryByBatch.id,
            batchNumber: productBatches.batchNumber,
            expirationDate: productBatches.expirationDate,
            quantity: inventoryByBatch.quantity,
          })
          .from(inventoryByBatch)
          .innerJoin(
            productBatches,
            eq(productBatches.id, inventoryByBatch.batchId)
          )
          .where(
            and(
              eq(inventoryByBatch.companyId, EKETO_COMPANY_ID),
              eq(productBatches.companyId, EKETO_COMPANY_ID),
              eq(inventoryByBatch.locationId, warehouse.id),
              inArray(
                productBatches.productId,
                mapping.requirements.map(r => r.productId)
              ),
              gte(productBatches.expirationDate, amazonRomeDate(new Date())),
              gt(inventoryByBatch.quantity, 0)
            )
          )
          .orderBy(
            asc(productBatches.productId),
            asc(productBatches.expirationDate),
            asc(productBatches.id)
          );
        const lots = config.dryRun
          ? await lotsQuery
          : await lotsQuery.for("update", { of: inventoryByBatch });
        const reservations = new Map<string, number>();
        if (config.dryRun) {
          // ALL earlier dry-run receipts contribute. Paginate instead of silently
          // truncating a multi-window backfill; hard cap fails closed for review.
          let offset = 0;
          while (true) {
            const previous = await tx
              .select({
                id: marketplaceOrderItems.id,
                preview: marketplaceOrderItems.amazonFefoPreview,
              })
              .from(marketplaceOrderItems)
              .where(
                and(
                  eq(
                    marketplaceOrderItems.amazonSellerAccountId,
                    config.sellerAccountId
                  ),
                  eq(marketplaceOrderItems.amazonStockStatus, "dry_run")
                )
              )
              .orderBy(asc(marketplaceOrderItems.id))
              .limit(500)
              .offset(offset);
            for (const p of previous)
              if (p.id !== item.id)
                for (const a of p.preview as AmazonFefoAllocation[]) {
                  const total =
                    (reservations.get(a.inventoryId) ?? 0) + a.pieces;
                  if (
                    !Number.isSafeInteger(total) ||
                    total < 0 ||
                    total > 2147483647
                  )
                    throw new Error("Amazon preview reservation overflow");
                  reservations.set(a.inventoryId, total);
                }
            if (previous.length < 500) break;
            offset += previous.length;
            if (offset >= 20000)
              throw new Error(
                "Amazon preview reservation cap requires administrative reconciliation"
              );
          }
        }
        const plan = planAmazonFefo(mapping.requirements, lots, reservations);
        if (plan.shortfalls.length) {
          const runs = await publishOutcome(
            tx,
            item,
            "review_required",
            `insufficient_stock:${JSON.stringify({ requirements: mapping.requirements, shortfalls: plan.shortfalls })}`
          );
          for (const runId of runs) await finishRun(tx, config, runId);
          return "review_required";
        }
        await tx
          .update(marketplaceOrderItems)
          .set({
            productId: mapping.productId,
            channelVariantId: mapping.variantId,
            piecesQuantity: pieces,
            ...(!config.dryRun
              ? {
                  amazonPiecesProcessed: pieces,
                  amazonSourceSnapshot: {
                    source: (item.amazonSourceSnapshot as Snapshot).source,
                    frozenMapping: mapping,
                  } satisfies Snapshot,
                }
              : {}),
          })
          .where(eq(marketplaceOrderItems.id, item.id));
        if (!config.dryRun)
          for (const allocation of plan.allocations) {
            const updated = await tx
              .update(inventoryByBatch)
              .set({
                quantity: sql`${inventoryByBatch.quantity} - ${allocation.pieces}`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(inventoryByBatch.id, allocation.inventoryId),
                  eq(inventoryByBatch.companyId, EKETO_COMPANY_ID),
                  sql`${inventoryByBatch.quantity} >= ${allocation.pieces}`
                )
              )
              .returning({ id: inventoryByBatch.id });
            if (updated.length !== 1)
              throw new Error(
                "Amazon concurrent stock change: transaction rolled back"
              );
            const [movement] = await tx
              .insert(stockMovements)
              .values({
                productId: allocation.productId,
                batchId: allocation.batchId,
                fromLocationId: warehouse.id,
                companyId: EKETO_COMPANY_ID,
                marketplaceOrderId: item.marketplaceOrderId,
                type: "AMAZON_EXIT",
                quantity: allocation.pieces,
                previousQuantity: allocation.availableBefore,
                newQuantity: allocation.availableBefore - allocation.pieces,
                sourceDocument: item.amazonOrderId!,
                sourceDocumentType: "AMAZON_ORDER",
                timestamp: item.amazonUpdatedAt!,
                notes: `Amazon ${item.amazonOrderId}; data aggiornamento Amazon`,
                notesInternal: `Amazon item ${item.amazonOrderItemId}; SKU ${item.channelSku}; lotto ${allocation.batchNumber}; data aggiornamento Amazon=${item.amazonUpdatedAt!.toISOString()}`,
              })
              .returning({ id: stockMovements.id });
            await tx.insert(amazonStockAllocations).values({
              itemId: item.id,
              runId: item.amazonLastRunId,
              productId: allocation.productId,
              batchId: allocation.batchId,
              stockMovementId: movement.id,
              pieces: allocation.pieces,
              amazonUpdatedAt: item.amazonUpdatedAt!,
            });
          }
        const outcome = config.dryRun ? "dry_run" : "processed";
        const runs = await publishOutcome(
          tx,
          item,
          outcome,
          config.dryRun ? "dry_run_no_stock_movements" : null,
          plan.allocations
        );
        for (const runId of runs) await finishRun(tx, config, runId);
        return outcome;
      });
      if (status === "processed") summary.processed++;
      else if (status === "dry_run") summary.dryRun++;
      else if (status === "review_required") summary.reviewRequired++;
      else summary.skipped++;
    } catch (error: unknown) {
      // Original transaction rolled back. Persist a terminal review separately,
      // never leave a poison line repeatedly consuming the bounded queue.
      summary.errors.push({ itemId: candidate.id, message: message(error) });
      try {
        await db.transaction(async tx => {
          const config = await lockConfig(tx, storeId);
          const [item] = await tx
            .select()
            .from(marketplaceOrderItems)
            .where(eq(marketplaceOrderItems.id, candidate.id))
            .limit(1)
            .for("update");
          if (
            item &&
            !stockFrozen(item) &&
            ["pending", "dry_run"].includes(item.amazonStockStatus ?? "")
          ) {
            const runs = await publishOutcome(
              tx,
              item,
              "review_required",
              `stock_transaction_failed:${message(error)}`
            );
            for (const runId of runs) await finishRun(tx, config, runId);
            summary.reviewRequired++;
          }
        });
      } catch (reviewError: unknown) {
        summary.errors.push({
          itemId: candidate.id,
          message: `Review persistence failed: ${message(reviewError)}`,
        });
      }
    }
  }
  return summary;
}
