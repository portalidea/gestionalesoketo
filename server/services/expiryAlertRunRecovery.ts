import { and, eq, lt } from "drizzle-orm";
import type { getDb } from "../db";
import { expiryAlertRuns } from "../../drizzle/schema";

/** Un run cron senza esito oltre questo limite è considerato interrotto. */
export const STALE_EXPIRY_ALERT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export type ExpiryAlertCronWindow = {
  companyId: string;
  periodStart: string;
  periodEnd: string;
};

export function getStaleExpiryAlertRunCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_EXPIRY_ALERT_RUN_TIMEOUT_MS);
}

export function buildStaleExpiryAlertRunError(window: ExpiryAlertCronWindow): string {
  return `Recupero automatico M13: run cron rimasto in running oltre 2 ore per company ${window.companyId}, finestra ${window.periodStart}–${window.periodEnd}.`;
}

/**
 * Deve essere chiamata dal job M13 prima del tentativo di creare il run cron
 * della stessa company e finestra. Non recupera mai run di altre company o di
 * altre finestre; un run recente resta bloccante per evitare doppie elaborazioni.
 */
export async function recoverStaleExpiryAlertCronRuns(
  database: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  window: ExpiryAlertCronWindow,
  now = new Date(),
): Promise<string[]> {
  const cutoff = getStaleExpiryAlertRunCutoff(now);
  const recovered = await database
    .update(expiryAlertRuns)
    .set({
      status: "failed",
      errorMessage: buildStaleExpiryAlertRunError(window),
      completedAt: now,
    })
    .where(
      and(
        eq(expiryAlertRuns.companyId, window.companyId),
        eq(expiryAlertRuns.periodStart, window.periodStart),
        eq(expiryAlertRuns.periodEnd, window.periodEnd),
        eq(expiryAlertRuns.trigger, "cron"),
        eq(expiryAlertRuns.status, "running"),
        lt(expiryAlertRuns.createdAt, cutoff),
      ),
    )
    .returning({ id: expiryAlertRuns.id });

  return recovered.map((run) => run.id);
}
