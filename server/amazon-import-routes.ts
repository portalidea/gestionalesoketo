import { createHash, timingSafeEqual } from "node:crypto";
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
  ingestAmazonReport,
  processPendingAmazonItems,
} from "./services/amazonOrderImportService";
import { buildAmazonImportWindow } from "./services/amazonImportWindow";

const uuid = z.string().uuid();
const REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL";
const router = Router();
const buckets = new Map<string, { started: number; count: number }>();

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
    res.status(401).json({ error: "Accesso Amazon non autorizzato" });
    return;
  }
  if (!uuid.safeParse(process.env.AMAZON_IMPORT_STORE_ID).success) {
    res.status(503).json({ error: "Store Amazon non configurato sul server" });
    return;
  }
  const now = Date.now();
  for (const [key, value] of Array.from(buckets.entries()))
    if (now - value.started > 60_000) buckets.delete(key);
  const key = req.ip || "unknown";
  const bucket = buckets.get(key) || { started: now, count: 0 };
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count > 60) {
    res.status(429).json({ error: "Troppe richieste Amazon" });
    return;
  }
  next();
}
router.use(authorize);

async function scope() {
  const db = await getDb();
  if (!db) throw new Error("Database non disponibile");
  const storeId = uuid.parse(process.env.AMAZON_IMPORT_STORE_ID);
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
  if (
    !config ||
    config.channel !== "amazon" ||
    !config.storeActive ||
    !config.companyActive ||
    config.companyId !== EKETO_COMPANY_ID ||
    !config.config.enabled
  ) {
    throw new Error("Import Amazon disabilitato o company/store non ammessi");
  }
  return { db, config: config.config, storeId };
}
function runHeader(req: Request) {
  return uuid.parse(req.get("X-Amazon-Import-Run-Id"));
}
function reportHeader(req: Request) {
  if (req.get("X-Amazon-Report-Type") !== REPORT_TYPE)
    throw new Error("Tipo report Amazon non ammesso");
  return z.string().min(1).max(255).parse(req.get("X-Amazon-Report-Id"));
}
function endpoint(action: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await action(req, res);
    } catch (error) {
      // Non loggare body, chiave o URL firmati. Gli errori applicativi restano nel run.
      console.error(
        "[AMAZON_IMPORT]",
        error instanceof z.ZodError ? "invalid_input" : "request_failed"
      );
      res
        .status(error instanceof z.ZodError ? 400 : 409)
        .json({
          error:
            error instanceof z.ZodError
              ? "Parametri Amazon non validi"
              : "Richiesta Amazon non completata: verificare configurazione e riepilogo admin",
        });
    }
  };
}
// Limite di lavoro per richiesta: i restanti elementi restano nel DB, mai in un job volatile.
async function drain(storeId: string, maxPasses = 4) {
  const deadline = Date.now() + 20_000;
  for (let pass = 0; pass < maxPasses && Date.now() < deadline; pass++) {
    await processPendingAmazonItems(storeId, 50);
  }
}

router.get(
  "/import-window",
  endpoint(async (_req, res) => {
    const { db, config, storeId } = await scope();
    await drain(storeId, 1);
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
      window_start: result.windowStart.toISOString(),
      window_end: result.windowEnd.toISOString(),
    });
  })
);

router.post(
  "/report-created",
  express.json({ limit: "16kb" }),
  endpoint(async (req, res) => {
    const { db, storeId } = await scope();
    const runId = runHeader(req);
    const reportId = reportHeader(req);
    z.object({
      schema_version: z.literal(1),
      outcome: z.literal("REPORT_CREATED"),
    })
      .strict()
      .parse(req.body);
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
      if (!run || (run.reportId && run.reportId !== reportId))
        throw new Error("Report/run non coerente");
      if (run.status === "requested")
        await tx
          .update(amazonImportRuns)
          .set({ reportId, status: "pending", updatedAt: new Date() })
          .where(eq(amazonImportRuns.id, runId));
      else if (run.reportId !== reportId)
        throw new Error("Run già concluso senza report");
    });
    res.json({ ok: true });
  })
);

router.post(
  "/report-file",
  express.raw({ type: () => true, limit: "4mb" }),
  endpoint(async (req, res) => {
    const { storeId } = await scope();
    if (!Buffer.isBuffer(req.body)) throw new Error("Documento raw richiesto");
    const runId = runHeader(req);
    const reportId = reportHeader(req);
    const reportDocumentId = z
      .string()
      .min(1)
      .max(1024)
      .parse(req.get("X-Amazon-Report-Document-Id"));
    if (req.get("X-Amazon-Processing-Status") !== "DONE")
      throw new Error("Report non completo");
    const compression = z
      .enum(["NONE", "GZIP"])
      .parse(req.get("X-Amazon-Compression-Algorithm") || "NONE");
    const result = await ingestAmazonReport({
      storeId,
      runId,
      reportId,
      reportDocumentId,
      body: req.body,
      compression,
    });
    await drain(storeId);
    res.status(200).json({ ok: true, durable: true, result });
  })
);

router.post(
  "/report-status",
  express.json({ limit: "16kb" }),
  endpoint(async (req, res) => {
    const { db, storeId } = await scope();
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
      if (!run || run.reportId !== reportId)
        throw new Error("Report/run non coerente");
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

export default router;
