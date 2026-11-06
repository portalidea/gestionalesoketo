import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { EKETO_COMPANY_ID } from "../shared/const";
import {
  amazonImportConfigs,
  amazonImportRuns,
  companies,
  salesStores,
} from "../drizzle/schema";
import {
  acquireAmazonReportDocument,
  processAmazonReportBatch,
} from "./services/amazonReportDocumentService";
import { buildAmazonImportWindow } from "./services/amazonImportWindow";
import {
  AmazonImportError,
  amazonImportError,
  type AmazonImportPhase,
} from "./services/amazonImportErrors";
import {
  persistAmazonImportDiagnostic,
  type AmazonRequestChecks,
} from "./services/amazonImportDiagnosticService";

const uuid = z.string().uuid();
const REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL";
const router = Router();
const buckets = new Map<string, { started: number; count: number }>();
interface RequestContext {
  requestId: string;
  phase: AmazonImportPhase;
  authenticated: boolean;
  storeId?: string;
  checks: AmazonRequestChecks;
}
function context(res: Response): RequestContext {
  return res.locals.amazon;
}
router.use((req, res, next) => {
  res.locals.amazon = {
    requestId: randomUUID(),
    phase: "authorization",
    authenticated: false,
    checks: {
      reportIdPresent: Boolean(req.get("X-Amazon-Report-Id")),
      documentIdPresent: Boolean(req.get("X-Amazon-Report-Document-Id")),
    },
  } satisfies RequestContext;
  next();
});
function errorPhase(
  error: AmazonImportError,
  fallback: AmazonImportPhase
): AmazonImportPhase {
  if (error.code.startsWith("DATABASE_")) return "database";
  if (
    [
      "RUN_NOT_FOUND",
      "EXECUTION_STATE",
      "REPORT_ID_MISMATCH",
      "DOCUMENT_REPLAY_MISMATCH",
    ].includes(error.code)
  )
    return "execution";
  if (error.code === "DOCUMENT_ID_INVALID") return "metadata";
  if (
    error.code.startsWith("DOCUMENT_") ||
    error.code.startsWith("COMPRESSION_")
  )
    return "document";
  return fallback;
}
async function failure(
  req: Request,
  res: Response,
  cause: unknown,
  status?: number
) {
  const error = amazonImportError(cause);
  const ctx = context(res);
  const phase = errorPhase(error, ctx.phase);
  let diagnosticPersisted = false;
  const runId = uuid.safeParse(req.get("X-Amazon-Import-Run-Id"));
  if (ctx.authenticated && ctx.storeId && runId.success) {
    try {
      diagnosticPersisted = await persistAmazonImportDiagnostic({
        storeId: ctx.storeId,
        runId: runId.data,
        diagnostic: {
          requestId: ctx.requestId,
          code: error.code,
          phase,
          at: new Date().toISOString(),
          details: error.details,
          checks: ctx.checks,
        },
      });
    } catch {
      console.error("[AMAZON_IMPORT]", {
        errorCode: "DIAGNOSTIC_PERSIST_FAILED",
        phase: "database",
        requestId: ctx.requestId,
      });
    }
  }
  console.error("[AMAZON_IMPORT]", {
    errorCode: error.code,
    phase,
    requestId: ctx.requestId,
    details: error.details,
    checks: ctx.checks,
    diagnosticPersisted,
  });
  res
    .status(
      status ??
        (error.code === "INVALID_INPUT" ||
        (phase === "metadata" && error.code.endsWith("_INVALID"))
          ? 400
          : 409)
    )
    .json({
      error: error.message,
      errorCode: error.code,
      phase,
      requestId: ctx.requestId,
      details: error.details,
      checks: ctx.checks,
      diagnosticPersisted,
    });
}

export function validAmazonWebhookKey(
  supplied: string | undefined,
  expected = process.env.AMAZON_IMPORT_WEBHOOK_KEY
): boolean {
  if (!expected || expected.length < 32 || !supplied || supplied.length > 1024)
    return false;
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest()
  );
}
function authorize(req: Request, res: Response, next: NextFunction) {
  if (!validAmazonWebhookKey(req.get("X-SoKeto-Amazon-Key"))) {
    void failure(req, res, new AmazonImportError("UNAUTHORIZED"), 401);
    return;
  }
  context(res).authenticated = true;
  const configured = uuid.safeParse(process.env.AMAZON_IMPORT_STORE_ID);
  if (!configured.success) {
    void failure(
      req,
      res,
      new AmazonImportError("SERVER_STORE_UNCONFIGURED"),
      503
    );
    return;
  }
  context(res).storeId = configured.data;
  const now = Date.now();
  for (const [key, value] of Array.from(buckets.entries()))
    if (now - value.started > 60_000) buckets.delete(key);
  const key = req.ip || "unknown";
  const bucket = buckets.get(key) || { started: now, count: 0 };
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count > 60) {
    void failure(req, res, new AmazonImportError("RATE_LIMITED"), 429);
    return;
  }
  next();
}
router.use(authorize);

async function scope(res: Response) {
  context(res).phase = "store";
  const db = await getDb();
  if (!db) throw new AmazonImportError("DATABASE_UNAVAILABLE");
  const storeId = context(res).storeId!;
  const [config] = await db
    .select({
      config: amazonImportConfigs,
      companyId: salesStores.companyId,
      companyName: companies.name,
      companyActive: companies.isActive,
      channel: salesStores.channel,
      storeActive: salesStores.isActive,
    })
    .from(amazonImportConfigs)
    .innerJoin(salesStores, eq(salesStores.id, amazonImportConfigs.storeId))
    .innerJoin(companies, eq(companies.id, salesStores.companyId))
    .where(eq(amazonImportConfigs.storeId, storeId))
    .limit(1);
  if (!config) throw new AmazonImportError("STORE_UNCONFIGURED");
  if (
    config.channel !== "amazon" ||
    !config.storeActive ||
    !config.companyActive ||
    config.companyId !== EKETO_COMPANY_ID
  ) {
    throw new AmazonImportError("STORE_SCOPE");
  }
  if (!config.config.enabled) throw new AmazonImportError("STORE_DISABLED");
  return { db, config: config.config, storeId };
}
function runHeader(req: Request) {
  const parsed = uuid.safeParse(req.get("X-Amazon-Import-Run-Id"));
  if (!parsed.success) throw new AmazonImportError("RUN_ID_INVALID");
  return parsed.data;
}
function reportHeader(req: Request) {
  if (req.get("X-Amazon-Report-Type") !== REPORT_TYPE)
    throw new AmazonImportError("REPORT_TYPE_INVALID");
  const parsed = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .safeParse(req.get("X-Amazon-Report-Id"));
  if (!parsed.success) throw new AmazonImportError("REPORT_ID_INVALID");
  return parsed.data;
}
function endpoint(action: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await action(req, res);
    } catch (error) {
      await failure(req, res, error);
    }
  };
}
router.get(
  "/import-window",
  endpoint(async (_req, res) => {
    const { db, storeId } = await scope(res);
    context(res).phase = "execution";
    const result = await db.transaction(async tx => {
      const [locked] = await tx
        .select()
        .from(amazonImportConfigs)
        .where(eq(amazonImportConfigs.storeId, storeId))
        .for("update")
        .limit(1);
      const [existing] = await tx
        .select()
        .from(amazonImportRuns)
        .where(
          and(
            eq(amazonImportRuns.storeId, storeId),
            inArray(amazonImportRuns.status, [
              "requested",
              "pending",
              "processing",
            ])
          )
        )
        .orderBy(asc(amazonImportRuns.createdAt))
        .limit(1);
      if (existing) return existing;
      const { start, end } = buildAmazonImportWindow(
        locked.purchaseCutoff,
        locked.checkpointAt
      );
      const [run] = await tx
        .insert(amazonImportRuns)
        .values({
          storeId,
          windowStart: start,
          windowEnd: end,
          dryRun: locked.dryRun,
          status: "requested",
        })
        .returning();
      return run;
    });
    res.json({
      run_id: result.id,
      report_id: result.reportId,
      document_acquired: Boolean(result.documentSha256),
      processing_pending: result.status === "processing",
      window_start: result.windowStart.toISOString(),
      window_end: result.windowEnd.toISOString(),
    });
  })
);

router.post(
  "/report-created",
  express.json({ limit: "16kb" }),
  endpoint(async (req, res) => {
    const { db, storeId } = await scope(res);
    context(res).phase = "metadata";
    const runId = runHeader(req);
    const reportId = reportHeader(req);
    z.object({
      schema_version: z.literal(1),
      outcome: z.literal("REPORT_CREATED"),
    })
      .strict()
      .parse(req.body);
    context(res).phase = "execution";
    await db.transaction(async tx => {
      const [run] = await tx
        .select()
        .from(amazonImportRuns)
        .where(
          and(
            eq(amazonImportRuns.id, runId),
            eq(amazonImportRuns.storeId, storeId)
          )
        )
        .for("update")
        .limit(1);
      context(res).checks.runFound = Boolean(run);
      if (!run) throw new AmazonImportError("RUN_NOT_FOUND");
      context(res).checks.reportIdMatches =
        !run.reportId || run.reportId === reportId;
      if (run.reportId && run.reportId !== reportId)
        throw new AmazonImportError("REPORT_ID_MISMATCH");
      if (run.status === "requested")
        await tx
          .update(amazonImportRuns)
          .set({
            reportId,
            status: "pending",
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(amazonImportRuns.id, runId));
      else if (run.reportId !== reportId)
        throw new AmazonImportError("EXECUTION_STATE");
    });
    res.json({ ok: true });
  })
);

router.post(
  "/report-file",
  express.raw({ type: () => true, limit: "4mb" }),
  endpoint(async (req, res) => {
    const { db, storeId } = await scope(res);
    context(res).phase = "metadata";
    const runId = runHeader(req);
    const reportId = reportHeader(req);
    const document = z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .safeParse(req.get("X-Amazon-Report-Document-Id"));
    if (!document.success) throw new AmazonImportError("DOCUMENT_ID_INVALID");
    const reportDocumentId = document.data;
    if (req.get("X-Amazon-Processing-Status") !== "DONE")
      throw new AmazonImportError("REPORT_NOT_DONE");
    const compression = req.get("X-Amazon-Compression-Algorithm") || "NONE";
    if (compression !== "NONE" && compression !== "GZIP")
      throw new AmazonImportError("COMPRESSION_UNSUPPORTED");
    context(res).phase = "execution";
    // Identity is checked before parsing; ingest revalidates state/identity under lock.
    const [run] = await db
      .select({
        reportId: amazonImportRuns.reportId,
        reportDocumentId: amazonImportRuns.reportDocumentId,
        status: amazonImportRuns.status,
        digest: amazonImportRuns.documentSha256,
      })
      .from(amazonImportRuns)
      .where(
        and(
          eq(amazonImportRuns.id, runId),
          eq(amazonImportRuns.storeId, storeId)
        )
      )
      .limit(1);
    const ctx = context(res);
    ctx.checks.runFound = Boolean(run);
    if (!run) throw new AmazonImportError("RUN_NOT_FOUND");
    ctx.checks.reportIdMatches = !run.reportId || run.reportId === reportId;
    ctx.checks.documentIdMatches =
      !run.reportDocumentId || run.reportDocumentId === reportDocumentId;
    if (!ctx.checks.reportIdMatches)
      throw new AmazonImportError("REPORT_ID_MISMATCH");
    if (!ctx.checks.documentIdMatches)
      throw new AmazonImportError("DOCUMENT_REPLAY_MISMATCH");
    if (
      !run.digest &&
      !["requested", "pending", "processing"].includes(run.status)
    )
      throw new AmazonImportError("EXECUTION_STATE");
    ctx.phase = "document";
    if (!Buffer.isBuffer(req.body))
      throw new AmazonImportError("DOCUMENT_BODY_INVALID");
    const result = await acquireAmazonReportDocument({
      storeId,
      runId,
      reportId,
      reportDocumentId,
      body: req.body,
      compression,
    });
    res.status(result.completed ? 200 : 202).json({
      ok: true,
      durable: true,
      result,
      processing_pending: !result.completed,
    });
  })
);

// Ogni richiesta lavora un lotto breve; la coda vive nel DB, non nel processo.
router.post(
  "/process-batch",
  express.json({ limit: "16kb" }),
  endpoint(async (req, res) => {
    const { storeId } = await scope(res);
    z.object({ schema_version: z.literal(1) })
      .strict()
      .parse(req.body);
    context(res).phase = "processing";
    const result = await processAmazonReportBatch(storeId, {
      rowLimit: 5,
      timeBudgetMs: 12000,
    });
    res.json({ ok: true, result });
  })
);

router.post(
  "/report-status",
  express.json({ limit: "16kb" }),
  endpoint(async (req, res) => {
    const { db, storeId } = await scope(res);
    context(res).phase = "metadata";
    const runId = runHeader(req);
    const reportId = reportHeader(req);
    const { outcome } = z
      .object({
        schema_version: z.literal(1),
        outcome: z.enum([
          "CANCELLED",
          "FATAL",
          "POLLING_EXHAUSTED",
          "UNEXPECTED_STATUS",
        ]),
      })
      .strict()
      .parse(req.body);
    context(res).phase = "execution";
    await db.transaction(async tx => {
      const [run] = await tx
        .select()
        .from(amazonImportRuns)
        .where(
          and(
            eq(amazonImportRuns.id, runId),
            eq(amazonImportRuns.storeId, storeId)
          )
        )
        .for("update")
        .limit(1);
      context(res).checks.runFound = Boolean(run);
      if (!run) throw new AmazonImportError("RUN_NOT_FOUND");
      context(res).checks.reportIdMatches = run.reportId === reportId;
      if (run.reportId !== reportId)
        throw new AmazonImportError("REPORT_ID_MISMATCH");
      if (["completed", "processing"].includes(run.status)) return; // Una notifica in ritardo non riapre un documento acquisito.
      const status =
        outcome === "CANCELLED"
          ? "cancelled"
          : outcome === "FATAL"
            ? "fatal"
            : outcome === "UNEXPECTED_STATUS"
              ? "review_required"
              : "pending";
      await tx
        .update(amazonImportRuns)
        .set({ status, error: outcome, updatedAt: new Date() })
        .where(eq(amazonImportRuns.id, runId));
      // Nessun avanzamento del checkpoint per CANCELLED/FATAL o polling non completato.
    });
    res.json({ ok: true });
  })
);

// Body parser failures occur before endpoint(); return safe diagnostics for these too.
router.use(
  (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    context(res).phase = req.path === "/report-file" ? "document" : "metadata";
    const normalized = amazonImportError(error);
    void failure(
      req,
      res,
      normalized,
      normalized.code === "DOCUMENT_TOO_LARGE" ? 413 : 400
    );
  }
);

export default router;
