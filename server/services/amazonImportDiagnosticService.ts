import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { amazonImportRuns } from "../../drizzle/schema";
import { EKETO_COMPANY_ID } from "../../shared/const";
import {
  AmazonImportError,
  safeAmazonDetails,
  type AmazonImportPhase,
} from "./amazonImportErrors";

export interface AmazonRequestChecks {
  reportIdPresent: boolean;
  documentIdPresent: boolean;
  reportIdMatches?: boolean;
  documentIdMatches?: boolean;
  runFound?: boolean;
}
export interface AmazonImportDiagnostic {
  requestId: string;
  code: AmazonImportError["code"];
  phase: AmazonImportPhase;
  at: string;
  details: ReturnType<typeof safeAmazonDetails>;
  checks: AmazonRequestChecks;
}

/** Caller must have authenticated the webhook. Never create runs from failed input.
 * A run in another store/company cannot be overwritten. UPDATE is atomic and adds
 * diagnostics to summary without changing document identity, status or checkpoint.
 */
export async function persistAmazonImportDiagnostic(input: {
  storeId: string;
  runId: string;
  diagnostic: AmazonImportDiagnostic;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new AmazonImportError("DATABASE_UNAVAILABLE");
  const [record] = await db
    .update(amazonImportRuns)
    .set({
      error: sql`CASE WHEN ${amazonImportRuns.status} = 'completed' THEN ${amazonImportRuns.error} ELSE ${input.diagnostic.code} END`,
      summary: sql`${amazonImportRuns.summary} || jsonb_build_object('lastDiagnostic', ${JSON.stringify(input.diagnostic)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(amazonImportRuns.id, input.runId),
        eq(amazonImportRuns.storeId, input.storeId),
        sql`EXISTS (SELECT 1 FROM sales_stores s WHERE s.id = ${amazonImportRuns.storeId} AND s.channel = 'amazon' AND s."companyId" = ${EKETO_COMPANY_ID}::uuid LIMIT 1)`
      )
    )
    .returning({ id: amazonImportRuns.id });
  return Boolean(record);
}
