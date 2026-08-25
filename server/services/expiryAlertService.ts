import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  expiryAlertItems,
  expiryAlertNotifications,
  expiryAlertRuns,
  expiryAlertSettings,
  expiryAlertSuppressions,
} from "../../drizzle/schema";
import { SOKETO_SRL_INTERCOMPANY_RETAILER_ID } from "../../shared/const";
import { recoverStaleExpiryAlertCronRuns } from "./expiryAlertRunRecovery";

export type ExpiryAlertMode = "alignment" | "alert";
export type ExpiryAlertTrigger = "cron" | "manual" | "dry_run";

export type ExpiryAlertRunInput = {
  companyId: string;
  mode: ExpiryAlertMode;
  trigger: ExpiryAlertTrigger;
  /** In questa milestone è obbligatoriamente true. */
  dryRun: true;
  now?: Date;
  periodStart?: string;
  periodEnd?: string;
};

type CandidateItem = {
  retailerId: string;
  retailerName: string;
  recipientEmail: string;
  locationId: string;
  productId: string;
  productName: string;
  batchId: string;
  batchCode: string;
  expiryDate: string;
  quantityPieces: number;
  piecesPerUnit: number;
  deliveryStatus: "delivered" | "in_transit";
  lastTransferDate: string | null;
  latestProductDeliveryAt: string | null;
  latestBatchId: string | null;
  latestBatchCode: string | null;
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
  notificationsSkippedPec: number;
  itemsFlagged: number;
  itemsSuppressedByReorder: number;
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

/** Le caselle PEC sono escluse dal canale operativo ordinario. */
function isPecEmailAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return domain.startsWith("pec.")
    || domain.includes(".pec.")
    || domain.endsWith("legalmail.it")
    || domain.endsWith("postecert.it")
    || domain.endsWith("pec.aruba.it")
    || domain === "pec.it";
}

function isSuppressedByReorder(item: CandidateItem, toleranceDays: number): boolean {
  if (!item.lastTransferDate || !item.latestProductDeliveryAt) return false;
  const lastDeliveryMs = new Date(item.lastTransferDate).getTime();
  const latestDeliveryMs = new Date(item.latestProductDeliveryAt).getTime();
  return lastDeliveryMs < latestDeliveryMs - toleranceDays * 24 * 60 * 60 * 1000;
}

/**
 * Selezione comune per alignment e alert. Per ogni location+prodotto ricava
 * l'ultimo TRANSFER per lotto senza sourceDocumentType: gli storici anteriori
 * all'hotfix non lo popolano. I lotti precedenti all'ultimo riassortimento,
 * oltre la tolleranza configurata, vengono soppressi a valle come inferenza;
 * nessuna riga di inventoryByBatch viene mai modificata.
 */
async function findCandidateItems(
  database: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  input: { companyId: string; mode: ExpiryAlertMode; periodStart: string; periodEnd: string },
): Promise<CandidateItem[]> {
  const expiryCondition = input.mode === "alignment"
    ? sql`TRUE`
    : sql`pb."expirationDate" >= ${input.periodStart}::date AND pb."expirationDate" <= ${input.periodEnd}::date`;

  return database.execute<CandidateItem>(sql`
    WITH active_batches AS (
      SELECT
        ibb."locationId" AS location_id,
        pb."productId" AS product_id,
        pb.id AS batch_id,
        pb."batchNumber" AS batch_code
      FROM "inventoryByBatch" ibb
      JOIN "productBatches" pb ON pb.id = ibb."batchId"
      WHERE ibb."companyId" = ${input.companyId}::uuid
        AND pb."companyId" = ${input.companyId}::uuid
        AND ibb.quantity > 0
    ), batch_deliveries AS (
      SELECT
        ab.location_id,
        ab.product_id,
        ab.batch_id,
        ab.batch_code,
        MAX(sm.timestamp) AS last_delivery_at
      FROM active_batches ab
      LEFT JOIN "stockMovements" sm
        ON sm.type = 'TRANSFER'
       AND sm."batchId" = ab.batch_id
       AND sm."toLocationId" = ab.location_id
      GROUP BY ab.location_id, ab.product_id, ab.batch_id, ab.batch_code
    ), latest_product_delivery AS (
      SELECT DISTINCT ON (location_id, product_id)
        location_id,
        product_id,
        batch_id AS latest_batch_id,
        batch_code AS latest_batch_code,
        last_delivery_at AS latest_delivery_at
      FROM batch_deliveries
      WHERE last_delivery_at IS NOT NULL
      ORDER BY location_id, product_id, last_delivery_at DESC, batch_code DESC
    )
    SELECT
      r.id AS "retailerId",
      r.name AS "retailerName",
      r.email AS "recipientEmail",
      l.id AS "locationId",
      p.id AS "productId",
      p.name AS "productName",
      pb.id AS "batchId",
      pb."batchNumber" AS "batchCode",
      pb."expirationDate"::text AS "expiryDate",
      ibb.quantity::int AS "quantityPieces",
      COALESCE(p."piecesPerUnit", 1)::int AS "piecesPerUnit",
      'delivered' AS "deliveryStatus",
      bd.last_delivery_at::text AS "lastTransferDate",
      lpd.latest_delivery_at::text AS "latestProductDeliveryAt",
      lpd.latest_batch_id::text AS "latestBatchId",
      lpd.latest_batch_code AS "latestBatchCode"
    FROM "inventoryByBatch" ibb
    JOIN locations l ON l.id = ibb."locationId" AND l."companyId" = ${input.companyId}::uuid
    JOIN retailers r ON r.id = l."retailerId" AND r."companyId" = ${input.companyId}::uuid
    JOIN "productBatches" pb ON pb.id = ibb."batchId" AND pb."companyId" = ${input.companyId}::uuid
    JOIN products p ON p.id = pb."productId"
    LEFT JOIN batch_deliveries bd ON bd.location_id = l.id AND bd.batch_id = pb.id
    LEFT JOIN latest_product_delivery lpd ON lpd.location_id = l.id AND lpd.product_id = p.id
    WHERE ibb."companyId" = ${input.companyId}::uuid
      AND ibb.quantity > 0
      AND l.type = 'retailer'
      AND l."isActive" = true
      AND r."isActive" = true
      AND r."expiryAlertOptOut" = false
      AND NULLIF(TRIM(r.email), '') IS NOT NULL
      AND r.id <> ${SOKETO_SRL_INTERCOMPANY_RETAILER_ID}::uuid
      AND ${expiryCondition}
    ORDER BY r.name, pb."expirationDate", p.name, pb."batchNumber"
  `);
}

/**
 * Crea esclusivamente snapshot database per il dry-run. Non chiama Resend,
 * non inserisce email_log e non modifica inventoryByBatch o stockMovements.
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
        runId: null, companyId: input.companyId, mode: input.mode, dryRun: true,
        skipped: true, reason: "already_running_or_completed", recoveredRunIds,
        retailersEvaluated: 0, notificationsCreated: 0, notificationsSkippedBelowThreshold: 0,
        notificationsSkippedPec: 0, itemsFlagged: 0, itemsSuppressedByReorder: 0,
      };
    }
    throw error;
  }

  try {
    const [settings] = await database
      .select({
        minPiecesThreshold: expiryAlertSettings.minPiecesThreshold,
        reorderToleranceDays: expiryAlertSettings.reorderToleranceDays,
      })
      .from(expiryAlertSettings)
      .where(eq(expiryAlertSettings.companyId, input.companyId))
      .limit(1);
    if (!settings) throw new Error(`Configurazione M13 mancante per company ${input.companyId}`);

    const allCandidates = await findCandidateItems(database, { companyId: input.companyId, mode: input.mode, periodStart, periodEnd });
    // L'anomalia PEC va sempre resa visibile nel report: una casella PEC non può
    // finire nella sola lista delle soppressioni per riordino. La soppressione
    // riguarda quindi esclusivamente candidati con recapito operativo ordinario.
    const pecCandidates = allCandidates.filter((item) => isPecEmailAddress(item.recipientEmail));
    const ordinaryCandidates = allCandidates.filter((item) => !isPecEmailAddress(item.recipientEmail));
    const suppressedCandidates = ordinaryCandidates.filter((item) => isSuppressedByReorder(item, settings.reorderToleranceDays));
    const candidates = [...pecCandidates, ...ordinaryCandidates.filter((item) => !isSuppressedByReorder(item, settings.reorderToleranceDays))];

    if (suppressedCandidates.length > 0) {
      await database.insert(expiryAlertSuppressions).values(suppressedCandidates.map((item) => ({
        runId,
        retailerId: item.retailerId,
        retailerName: item.retailerName,
        productId: item.productId,
        productName: item.productName,
        oldBatchId: item.batchId,
        oldBatchCode: item.batchCode,
        oldDeliveryAt: new Date(item.lastTransferDate!),
        newBatchId: item.latestBatchId,
        newBatchCode: item.latestBatchCode ?? "",
        newDeliveryAt: new Date(item.latestProductDeliveryAt!),
        toleranceDays: settings.reorderToleranceDays,
        reason: "reorder_suppression",
      })));
    }

    const groups = new Map<string, CandidateItem[]>();
    for (const candidate of candidates) {
      groups.set(candidate.retailerId, [...(groups.get(candidate.retailerId) ?? []), candidate]);
    }

    let notificationsCreated = 0;
    let notificationsSkippedBelowThreshold = 0;
    let notificationsSkippedPec = 0;
    for (const [retailerId, items] of Array.from(groups.entries())) {
      const totalPieces = items.reduce((sum, item) => sum + item.quantityPieces, 0);
      const belowThreshold = totalPieces < settings.minPiecesThreshold;
      const pecAddress = isPecEmailAddress(items[0].recipientEmail);
      const skipReason = pecAddress ? "pec_address" : belowThreshold ? "below_threshold" : null;
      const [notification] = await database.insert(expiryAlertNotifications).values({
        runId,
        retailerId,
        isInternal: false,
        retailerName: items[0].retailerName,
        recipientEmail: items[0].recipientEmail,
        status: skipReason ? "skipped" : "pending",
        skipReason,
        responseToken: crypto.randomUUID(),
        tokenExpiresAt: tokenExpiry(now),
        itemsCount: items.length,
      }).returning({ id: expiryAlertNotifications.id });

      await database.insert(expiryAlertItems).values(items.map((item) => ({
        notificationId: notification.id,
        productId: item.productId,
        productName: item.productName,
        batchId: item.batchId,
        batchCode: item.batchCode,
        expiryDate: item.expiryDate,
        quantityPieces: item.quantityPieces,
        piecesPerUnit: item.piecesPerUnit,
        deliveryStatus: item.deliveryStatus,
        lastTransferDate: item.lastTransferDate?.slice(0, 10) ?? null,
      })));
      notificationsCreated++;
      if (belowThreshold && !pecAddress) notificationsSkippedBelowThreshold++;
      if (pecAddress) notificationsSkippedPec++;
    }

    const notificationsSkipped = notificationsSkippedBelowThreshold + notificationsSkippedPec;
    await database.update(expiryAlertRuns).set({
      status: "completed",
      retailersEvaluated: groups.size,
      retailersNotified: notificationsCreated - notificationsSkipped,
      emailsSent: 0,
      emailsFailed: 0,
      itemsFlagged: candidates.length,
      completedAt: new Date(),
    }).where(eq(expiryAlertRuns.id, runId));

    return {
      runId, companyId: input.companyId, mode: input.mode, dryRun: true, skipped: false,
      recoveredRunIds, retailersEvaluated: groups.size, notificationsCreated,
      notificationsSkippedBelowThreshold, notificationsSkippedPec,
      itemsFlagged: candidates.length, itemsSuppressedByReorder: suppressedCandidates.length,
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
