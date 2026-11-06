import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { processAmazonReportBatch } from "./services/amazonReportDocumentService";
import { amazonImportError } from "./services/amazonImportErrors";

/** Daily Hobby recovery only. Progress lives in PostgreSQL, never in this loop. */
export function validAmazonCronAuthorization(
  supplied: string | undefined,
  secret = process.env.CRON_SECRET
): boolean {
  if (!secret || secret.length < 16 || !supplied || supplied.length > 2048)
    return false;
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(`Bearer ${secret}`).digest()
  );
}

export const amazonProcessingCron = Router();
amazonProcessingCron.get("/amazon-processing", async (req, res) => {
  if (!validAmazonCronAuthorization(req.get("Authorization"))) {
    res.status(401).json({ errorCode: "UNAUTHORIZED" });
    return;
  }
  const parsed = z
    .string()
    .uuid()
    .safeParse(process.env.AMAZON_IMPORT_STORE_ID);
  if (!parsed.success) {
    res.status(503).json({ errorCode: "SERVER_STORE_UNCONFIGURED" });
    return;
  }
  const started = Date.now();
  const deadline = started + 40000;
  let batches = 0;
  let result: Awaited<ReturnType<typeof processAmazonReportBatch>> | undefined;
  try {
    // Leave budget for commit, JSON response and cold-start overhead within 60s.
    while (deadline - Date.now() > 3000 && batches < 30) {
      result = await processAmazonReportBatch(parsed.data, {
        rowLimit: 5,
        timeBudgetMs: Math.min(12000, deadline - Date.now() - 1500),
      });
      batches++;
      if (!result.hasMore) break;
    }
    res.json({ ok: true, batches, elapsedMs: Date.now() - started, result });
  } catch (cause) {
    const error = amazonImportError(cause);
    console.error("[AMAZON_IMPORT_BATCH]", {
      errorCode: error.code,
      phase: "processing",
    });
    res
      .status(503)
      .json({ errorCode: error.code, phase: "processing", batches });
  }
});
