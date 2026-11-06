import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  amazonImportDocuments,
  amazonImportRuns,
  marketplaceOrderItems,
  marketplaceOrders,
  type AmazonImportDocument,
  type AmazonImportRun,
} from "../../drizzle/schema";
import { parseAmazonReport } from "./amazonOrderImportHelpers";
import { AmazonImportError, amazonImportError } from "./amazonImportErrors";
import {
  database,
  finishRun,
  ingestAmazonRows,
  lockConfig,
  processPendingAmazonItems,
  setAmazonTransactionTimeouts,
  type AmazonWorkerSummary,
} from "./amazonOrderImportService";

export interface AmazonReportDocumentInput {
  storeId: string;
  runId: string;
  reportId: string;
  reportDocumentId: string;
  body: Buffer;
  compression?: string;
}
export interface AmazonReportAcquisition {
  alreadyAcquired: boolean;
  completed: boolean;
  runId: string;
  totalRows: number;
  ingestedRows: number;
}
export interface AmazonReportBatchOptions {
  rowLimit?: number;
  timeBudgetMs?: number;
  itemLimit?: number;
}
export interface AmazonReportBatchResult {
  runId: string | null;
  totalRows: number;
  ingestedRows: number;
  ingestedThisBatch: number;
  completed: boolean;
  hasMore: boolean;
  disabled: boolean;
  acquiredAt: Date | null;
  ingestStartedAt: Date | null;
  ingestCompletedAt: Date | null;
  processingCompletedAt: Date | null;
  processingMs: number;
  lastError: string | null;
  worker: AmazonWorkerSummary;
}
const emptyWorker = (): AmazonWorkerSummary => ({
  attempted: 0,
  processed: 0,
  dryRun: 0,
  reviewRequired: 0,
  skipped: 0,
  errors: [],
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure bounded parsing/hash happens before locks. No marketplace rows, stock,
 * observations or checkpoints are written by HTTP acquisition. Original bytes
 * are retained once; duplicate legacy synchronous receipts are never re-ingested.
 */
export async function acquireAmazonReportDocument(
  input: AmazonReportDocumentInput
): Promise<AmazonReportAcquisition> {
  try {
    if (!uuid.test(input.runId)) throw new AmazonImportError("RUN_ID_INVALID");
    if (!uuid.test(input.storeId)) throw new AmazonImportError("INVALID_INPUT");
    if (typeof input.reportId !== "string" || !input.reportId.trim())
      throw new AmazonImportError("REPORT_ID_INVALID");
    if (
      typeof input.reportDocumentId !== "string" ||
      !input.reportDocumentId.trim()
    )
      throw new AmazonImportError("DOCUMENT_ID_INVALID");
    if (!Buffer.isBuffer(input.body))
      throw new AmazonImportError("DOCUMENT_BODY_INVALID");
    const rows = parseAmazonReport(input.body, input.compression);
    const digest = createHash("sha256").update(input.body).digest("hex");
    const bodyBase64 = input.body.toString("base64");
    const compression = input.compression === "GZIP" ? "GZIP" : "NONE";
    const db = await database();
    return await db.transaction(async tx => {
      await setAmazonTransactionTimeouts(tx);
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
      if (
        run.reportDocumentId &&
        run.reportDocumentId !== input.reportDocumentId
      )
        throw new AmazonImportError("DOCUMENT_REPLAY_MISMATCH");
      // Do not select payload during acquisition/replay metadata reads.
      const [document] = await tx
        .select({
          totalRows: amazonImportDocuments.totalRows,
          ingestedRows: amazonImportDocuments.ingestedRows,
          compression: amazonImportDocuments.compression,
          processingCompletedAt: amazonImportDocuments.processingCompletedAt,
        })
        .from(amazonImportDocuments)
        .where(eq(amazonImportDocuments.runId, run.id))
        .limit(1)
        .for("update");
      if (run.documentSha256) {
        if (
          run.documentSha256 !== digest ||
          run.reportId !== input.reportId ||
          run.reportDocumentId !== input.reportDocumentId ||
          (document && document.compression !== compression)
        )
          throw new AmazonImportError("DOCUMENT_REPLAY_MISMATCH");
        return {
          alreadyAcquired: true,
          completed:
            run.status === "completed" &&
            (!document ||
              (document.ingestedRows === document.totalRows &&
                Boolean(document.processingCompletedAt))),
          runId: run.id,
          totalRows: document?.totalRows ?? rows.length,
          // Legacy digest means its synchronous receipt already committed in full.
          ingestedRows: document?.ingestedRows ?? rows.length,
        };
      }
      if (
        document ||
        !["requested", "pending", "processing"].includes(run.status)
      )
        throw new AmazonImportError("EXECUTION_STATE");
      await tx.insert(amazonImportDocuments).values({
        runId: run.id,
        bodyBase64,
        compression,
        totalRows: rows.length,
      });
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
      return {
        alreadyAcquired: false,
        completed: false,
        runId: run.id,
        totalRows: rows.length,
        ingestedRows: 0,
      };
    });
  } catch (error) {
    throw amazonImportError(error);
  }
}

/** One cursor chunk per call, then bounded item work only after EVERY acquired
 * document for this store is ingested. A later-batch cancellation therefore wins
 * before stock. Config -> run -> document locks serialize receipts and workers;
 * row observations/items and the cursor commit in the very same transaction.
 */
export async function processAmazonReportBatch(
  storeId: string,
  options: AmazonReportBatchOptions = {}
): Promise<AmazonReportBatchResult> {
  const rowLimit = options.rowLimit ?? 5;
  const timeBudgetMs = options.timeBudgetMs ?? 12000;
  const itemLimit = options.itemLimit ?? rowLimit;
  if (
    !uuid.test(storeId) ||
    !Number.isInteger(rowLimit) ||
    rowLimit < 1 ||
    rowLimit > 200 ||
    !Number.isInteger(itemLimit) ||
    itemLimit < 1 ||
    itemLimit > 200 ||
    !Number.isInteger(timeBudgetMs) ||
    timeBudgetMs < 1000 ||
    timeBudgetMs > 12000
  )
    throw new AmazonImportError("INVALID_INPUT");
  const startedAt = Date.now();
  const deadline = startedAt + timeBudgetMs;
  let runId: string | null = null;
  let ingestedThisBatch = 0;
  let worker = emptyWorker();
  try {
    const db = await database();
    const selected = await db.transaction(async tx => {
      await setAmazonTransactionTimeouts(tx, deadline - Date.now());
      const config = await lockConfig(tx, storeId);
      if (!config.enabled) return { disabled: true, runId: null, ingested: 0 };
      const [candidate] = await tx
        .select({ id: amazonImportRuns.id })
        .from(amazonImportRuns)
        .innerJoin(
          amazonImportDocuments,
          eq(amazonImportDocuments.runId, amazonImportRuns.id)
        )
        .where(
          and(
            eq(amazonImportRuns.storeId, storeId),
            eq(amazonImportRuns.status, "processing")
          )
        )
        .orderBy(asc(amazonImportRuns.createdAt), asc(amazonImportRuns.id))
        .limit(1)
        .for("update", { of: amazonImportRuns });
      if (!candidate) return { disabled: false, runId: null, ingested: 0 };
      runId = candidate.id;
      const [document] = await tx
        .select()
        .from(amazonImportDocuments)
        .where(eq(amazonImportDocuments.runId, candidate.id))
        .limit(1)
        .for("update");
      const [run] = await tx
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, candidate.id))
        .limit(1);
      let ingested = 0;
      if (
        document.ingestedRows < document.totalRows ||
        !document.ingestCompletedAt
      ) {
        const rows = parseAmazonReport(
          Buffer.from(document.bodyBase64, "base64"),
          document.compression
        );
        if (
          rows.length !== document.totalRows ||
          createHash("sha256")
            .update(Buffer.from(document.bodyBase64, "base64"))
            .digest("hex") !== run.documentSha256
        )
          throw new AmazonImportError("DOCUMENT_REPLAY_MISMATCH");
        ingested = await ingestAmazonRows(
          tx,
          config,
          run.id,
          rows,
          document.ingestedRows,
          rowLimit,
          deadline
        );
        const cursor = document.ingestedRows + ingested;
        await tx
          .update(amazonImportDocuments)
          .set({
            ingestedRows: cursor,
            ingestStartedAt: document.ingestStartedAt ?? new Date(startedAt),
            ingestCompletedAt:
              cursor === document.totalRows ? new Date() : null,
            processingMs: sql`${amazonImportDocuments.processingMs} + ${Math.max(0, Date.now() - startedAt)}`,
            lastError: null,
          })
          .where(eq(amazonImportDocuments.runId, run.id));
      }
      await finishRun(tx, config, run.id);
      return { disabled: false, runId: run.id, ingested };
    });
    runId = selected.runId;
    ingestedThisBatch = selected.ingested;
    const stockStartedAt = Date.now();
    if (!selected.disabled && stockStartedAt < deadline)
      worker = await processPendingAmazonItems(storeId, itemLimit, {
        deadline,
      });
    return await db.transaction(async tx => {
      await setAmazonTransactionTimeouts(tx);
      const config = await lockConfig(tx, storeId);
      let document:
        | Omit<AmazonImportDocument, "bodyBase64" | "compression">
        | undefined;
      let run: AmazonImportRun | undefined;
      if (runId) {
        [run] = await tx
          .select()
          .from(amazonImportRuns)
          .where(eq(amazonImportRuns.id, runId))
          .limit(1)
          .for("update");
        await tx
          .update(amazonImportDocuments)
          .set({
            processingMs: sql`${amazonImportDocuments.processingMs} + ${Math.max(0, Date.now() - stockStartedAt)}`,
          })
          .where(eq(amazonImportDocuments.runId, runId));
        [document] = await tx
          .select({
            runId: amazonImportDocuments.runId,
            totalRows: amazonImportDocuments.totalRows,
            ingestedRows: amazonImportDocuments.ingestedRows,
            acquiredAt: amazonImportDocuments.acquiredAt,
            ingestStartedAt: amazonImportDocuments.ingestStartedAt,
            ingestCompletedAt: amazonImportDocuments.ingestCompletedAt,
            processingCompletedAt: amazonImportDocuments.processingCompletedAt,
            processingMs: amazonImportDocuments.processingMs,
            lastError: amazonImportDocuments.lastError,
          })
          .from(amazonImportDocuments)
          .where(eq(amazonImportDocuments.runId, runId))
          .limit(1)
          .for("update");
      }
      const [moreDocument] = config.enabled
        ? await tx
            .select({ id: amazonImportRuns.id })
            .from(amazonImportRuns)
            .innerJoin(
              amazonImportDocuments,
              eq(amazonImportDocuments.runId, amazonImportRuns.id)
            )
            .where(
              and(
                eq(amazonImportRuns.storeId, storeId),
                eq(amazonImportRuns.status, "processing")
              )
            )
            .limit(1)
        : [];
      const [moreItem] = config.enabled
        ? await tx
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
            .limit(1)
        : [];
      const hasMore = Boolean(moreDocument || moreItem);
      return {
        runId,
        totalRows: document?.totalRows ?? 0,
        ingestedRows: document?.ingestedRows ?? 0,
        ingestedThisBatch,
        completed:
          config.enabled && (run ? run.status === "completed" : !hasMore),
        hasMore,
        disabled: !config.enabled,
        acquiredAt: document?.acquiredAt ?? null,
        ingestStartedAt: document?.ingestStartedAt ?? null,
        ingestCompletedAt: document?.ingestCompletedAt ?? null,
        processingCompletedAt: document?.processingCompletedAt ?? null,
        processingMs: document?.processingMs ?? 0,
        lastError: document?.lastError ?? null,
        worker,
      };
    });
  } catch (error) {
    const safe = amazonImportError(error);
    // Cursor transaction is rolled back; store only static error codes, no bytes,
    // SQL, exception causes, report IDs or received values in diagnostics.
    if (runId) {
      try {
        const db = await database();
        await db.transaction(async tx => {
          await setAmazonTransactionTimeouts(tx);
          await lockConfig(tx, storeId);
          const [run] = await tx
            .select({ id: amazonImportRuns.id })
            .from(amazonImportRuns)
            .where(
              and(
                eq(amazonImportRuns.id, runId!),
                eq(amazonImportRuns.storeId, storeId)
              )
            )
            .limit(1)
            .for("update");
          if (run)
            await tx
              .update(amazonImportDocuments)
              .set({ lastError: safe.code })
              .where(eq(amazonImportDocuments.runId, run.id));
        });
      } catch {
        /* Original safe failure remains authoritative. */
      }
    }
    throw safe;
  }
}
