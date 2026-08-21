import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  expiryAlertItems,
  expiryAlertNotifications,
  expiryAlertRuns,
  expiryAlertSettings,
} from "../../drizzle/schema";
import { recoverStaleExpiryAlertCronRuns } from "./expiryAlertRunRecovery";

export type ExpiryAlertMode = "alignment" | "alert";
export type ExpiryAlertTrigger = "cron" | "manual" | "dry_run";

export type ExpiryAlertRunInput = {
  companyId: string;
  mode: ExpiryAlertMode;
  trigger: ExpiryAlertTrigger;
  /** In questo milestone è obbligatoriamente true. */
  dryRun: true;
  now?: Date;
  periodStart?: string;
  periodEnd?: string;
};

type CandidateItem = {
  retailerId: string;
  retailerName: string;
  recipientEmail: string;
  productId: string;
  productName: string;
  batchId: string;
  batchCode: string;
  expiryDate: string;
  quantityPieces: number;
  piecesPerUnit: number;
  deliveryStatus: "delivered" | "in_transit";
  lastTransferDate: string | null;
};

export type ExpiryAlertRunResult = {
  runId: string | null;
  companyId: string;
  mode: ExpiryAlertMode;
  dryRun: true;
  skipped: boolean;
  reason?: "already_running_or_completed";
  recoveredRunIds: string[];
  retailersEvaluated: number;
  notificationsCreated: number;
  notificationsSkippedBelowThreshold: number;
  itemsFlagged: number;
};

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function defaultAlertPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const start = dateOnly(now);
  const end = dateOnly(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
  return { periodStart: start, periodEnd: end };
}

function tokenExpiry(now: Date): Date {
  return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

/**
 * Snapshot per retailer ricavato unicamente da inventoryByBatch. Ogni join è
 * vincolato alla company chiamante; nessun lotto o location cross-company può
 * entrare nel run.
 */
async function findCandidateItems(
  database: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  input: { companyId: string; mode: ExpiryAlertMode; periodStart: string; periodEnd: string },
): Promise<CandidateItem[]> {
  const expiryCondition = input.mode === "alignment"
    ? sql`TRUE`
    : sql`pb."expirationDate" >= ${input.periodStart}::date AND pb."expirationDate" <= ${input.periodEnd}::date`;

  return database.execute<CandidateItem>(sql`
    SELECT
      r.id AS "retailerId",
      r.name AS "retailerName",
      r.email AS "recipientEmail",
      p.id AS "productId",
      p.name AS "productName",
      pb.id AS "batchId",
      pb."batchNumber" AS "batchCode",
      pb."expirationDate"::text AS "expiryDate",
      ibb.quantity::int AS "quantityPieces",
      COALESCE(p."piecesPerUnit", 1)::int AS "piecesPerUnit",
      COALESCE((
        SELECT CASE WHEN o.status = 'transferring' THEN 'in_transit' ELSE 'delivered' END
        FROM "stockMovements" sm
        JOIN orders o ON o.id = sm."sourceDocument"::uuid
        WHERE sm.type = 'TRANSFER'
          AND sm."sourceDocumentType" = 'order_transfer'
          AND sm."batchId" = pb.id
          AND sm."toLocationId" = l.id
        ORDER BY sm.timestamp DESC
        LIMIT 1
      ), 'delivered') AS "deliveryStatus",
      (
        SELECT sm.timestamp::date::text
        FROM "stockMovements" sm
        WHERE sm.type = 'TRANSFER'
          AND sm."sourceDocumentType" = 'order_transfer'
          AND sm."batchId" = pb.id
          AND sm."toLocationId" = l.id
        ORDER BY sm.timestamp DESC
        LIMIT 1
      ) AS "lastTransferDate"
    FROM "inventoryByBatch" ibb
    JOIN locations l ON l.id = ibb."locationId" AND l."companyId" = ${input.companyId}::uuid
    JOIN retailers r ON r.id = l."retailerId" AND r."companyId" = ${input.companyId}::uuid
    JOIN "productBatches" pb ON pb.id = ibb."batchId" AND pb."companyId" = ${input.companyId}::uuid
    JOIN products p ON p.id = pb."productId"
    WHERE ibb."companyId" = ${input.companyId}::uuid
      AND ibb.quantity > 0
      AND l.type = 'retailer'
      AND l."isActive" = true
      AND r."isActive" = true
      AND r."expiryAlertOptOut" = false
      AND NULLIF(TRIM(r.email), '') IS NOT NULL
      AND ${expiryCondition}
    ORDER BY r.name, pb."expirationDate", p.name, pb."batchNumber"
  `);
}

/**
 * Crea esclusivamente evidenze database per il dry-run. In particolare, non
 * chiama Resend e non inserisce email_log: questo è il blocco prima del primo
 * invio reale richiesto per M13.
 */
export async function runExpiryAlertForCompany(input: ExpiryAlertRunInput): Promise<ExpiryAlertRunResult> {
  const database = await getDb();
  if (!database) throw new Error("Database non disponibile");

  const now = input.now ?? new Date();
  const defaultPeriod = defaultAlertPeriod(now);
  const periodStart = input.periodStart ?? defaultPeriod.periodStart;
  const periodEnd = input.periodEnd ?? defaultPeriod.periodEnd;
  const runDate = dateOnly(now);

  const recoveredRunIds = input.trigger === "cron"
    ? await recoverStaleExpiryAlertCronRuns(database, { companyId: input.companyId, periodStart, periodEnd }, now)
    : [];

  let runId: string;
  try {
    const [run] = await database.insert(expiryAlertRuns).values({
      companyId: input.companyId,
      mode: input.mode,
      runDate,
      periodStart,
      periodEnd,
      trigger: input.trigger,
      status: "running",
    }).returning({ id: expiryAlertRuns.id });
    runId = run.id;
  } catch (error) {
    if (input.trigger === "cron" && isUniqueViolation(error)) {
      return {
        runId: null,
        companyId: input.companyId,
        mode: input.mode,
        dryRun: true,
        skipped: true,
        reason: "already_running_or_completed",
        recoveredRunIds,
        retailersEvaluated: 0,
        notificationsCreated: 0,
        notificationsSkippedBelowThreshold: 0,
        itemsFlagged: 0,
      };
    }
    throw error;
  }

  try {
    const [settings] = await database
      .select({ minPiecesThreshold: expiryAlertSettings.minPiecesThreshold })
      .from(expiryAlertSettings)
      .where(eq(expiryAlertSettings.companyId, input.companyId))
      .limit(1);
    if (!settings) throw new Error(`Configurazione M13 mancante per company ${input.companyId}`);

    const candidates = await findCandidateItems(database, { companyId: input.companyId, mode: input.mode, periodStart, periodEnd });
    const groups = new Map<string, CandidateItem[]>();
    for (const candidate of candidates) {
      groups.set(candidate.retailerId, [...(groups.get(candidate.retailerId) ?? []), candidate]);
    }

    let notificationsCreated = 0;
    let notificationsSkippedBelowThreshold = 0;
    for (const [retailerId, items] of Array.from(groups.entries())) {
      const totalPieces = items.reduce((sum: number, item: CandidateItem) => sum + item.quantityPieces, 0);
      const belowThreshold = totalPieces < settings.minPiecesThreshold;
      const [notification] = await database.insert(expiryAlertNotifications).values({
        runId,
        retailerId,
        isInternal: false,
        retailerName: items[0].retailerName,
        recipientEmail: items[0].recipientEmail,
        status: belowThreshold ? "skipped" : "pending",
        skipReason: belowThreshold ? "below_threshold" : null,
        responseToken: crypto.randomUUID(),
        tokenExpiresAt: tokenExpiry(now),
        itemsCount: items.length,
      }).returning({ id: expiryAlertNotifications.id });

      await database.insert(expiryAlertItems).values(items.map((item: CandidateItem) => ({
        notificationId: notification.id,
        productId: item.productId,
        productName: item.productName,
        batchId: item.batchId,
        batchCode: item.batchCode,
        expiryDate: item.expiryDate,
        quantityPieces: item.quantityPieces,
        piecesPerUnit: item.piecesPerUnit,
        deliveryStatus: item.deliveryStatus,
        lastTransferDate: item.lastTransferDate,
      })));
      notificationsCreated++;
      if (belowThreshold) notificationsSkippedBelowThreshold++;
    }

    await database.update(expiryAlertRuns).set({
      status: "completed",
      retailersEvaluated: groups.size,
      retailersNotified: notificationsCreated - notificationsSkippedBelowThreshold,
      emailsSent: 0,
      emailsFailed: 0,
      itemsFlagged: candidates.length,
      completedAt: new Date(),
    }).where(eq(expiryAlertRuns.id, runId));

    return {
      runId,
      companyId: input.companyId,
      mode: input.mode,
      dryRun: true,
      skipped: false,
      recoveredRunIds,
      retailersEvaluated: groups.size,
      notificationsCreated,
      notificationsSkippedBelowThreshold,
      itemsFlagged: candidates.length,
    };
  } catch (error) {
    await database.update(expiryAlertRuns).set({
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Errore M13 sconosciuto",
      completedAt: new Date(),
    }).where(and(eq(expiryAlertRuns.id, runId), eq(expiryAlertRuns.companyId, input.companyId)));
    throw error;
  }
}
