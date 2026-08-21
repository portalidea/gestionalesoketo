import { eq } from "drizzle-orm";
import type { getDb } from "../db";
import { emailLog, expiryAlertNotifications } from "../../drizzle/schema";

export type M13EmailMode = "alert" | "alignment" | "internal";

export type M13IdempotencyKeyInput = {
  mode: M13EmailMode;
  companyId: string;
  periodStart?: string | null;
  runDate?: string | null;
  retailerId?: string | null;
};

export function buildM13IdempotencyKey(input: M13IdempotencyKeyInput): string {
  if (input.mode === "internal") {
    if (!input.periodStart) throw new Error("M13 internal richiede periodStart");
    return `m13:internal:${input.companyId}:${input.periodStart}`;
  }

  if (!input.retailerId) throw new Error(`M13 ${input.mode} richiede retailerId`);
  const window = input.mode === "alignment" ? input.runDate : input.periodStart;
  if (!window) throw new Error(`M13 ${input.mode} richiede ${input.mode === "alignment" ? "runDate" : "periodStart"}`);
  return `m13:${input.mode}:${input.companyId}:${window}:${input.retailerId}`;
}

export type M13EmailReservationInput = {
  idempotencyKey: string;
  notificationId: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  textBody: string;
  metadata: Record<string, unknown>;
};

export type M13EmailReservation =
  | { reserved: true; emailLogId: string }
  | { reserved: false; reason: "already_sent_in_window" };

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let level = 0; level < 3; level++) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && (current as { code?: string }).code === "23505") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Riserva la consegna prima di contattare Resend. L'unicità è garantita dal
 * database su email_log.idempotency_key, quindi regge crash e concorrenza.
 */
export async function reserveM13EmailDelivery(
  database: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  input: M13EmailReservationInput,
): Promise<M13EmailReservation> {
  try {
    const [created] = await database
      .insert(emailLog)
      .values({
        provider: "resend",
        idempotencyKey: input.idempotencyKey,
        emailType: "m13_expiry_alert",
        relatedEntityType: "expiry_alert_notification",
        relatedEntityId: input.notificationId,
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName,
        fromEmail: "SoKeto Gestionale <noreply@sm.soketo.it>",
        subject: input.subject,
        templateKey: "m13-expiry-alert",
        metadata: input.metadata,
        textBody: input.textBody,
        status: "queued",
      })
      .returning({ id: emailLog.id });
    return { reserved: true, emailLogId: created.id };
  } catch (error) {
    if (isUniqueViolation(error)) return { reserved: false, reason: "already_sent_in_window" };
    throw error;
  }
}

/**
 * Collega la reservation alla notification. Se la finestra è già stata
 * servita, la notification del nuovo run diventa skipped senza chiamare il
 * provider: è il percorso obbligatorio contro il doppio invio.
 */
export async function prepareM13NotificationDelivery(
  database: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  input: M13EmailReservationInput,
): Promise<M13EmailReservation> {
  const reservation = await reserveM13EmailDelivery(database, input);
  if (!reservation.reserved) {
    await database
      .update(expiryAlertNotifications)
      .set({ status: "skipped", skipReason: "already_sent_in_window" })
      .where(eq(expiryAlertNotifications.id, input.notificationId));
    return reservation;
  }

  await database
    .update(expiryAlertNotifications)
    .set({ emailLogId: reservation.emailLogId })
    .where(eq(expiryAlertNotifications.id, input.notificationId));
  return reservation;
}

export async function markM13EmailProviderAccepted(
  database: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  emailLogId: string,
  providerMessageId: string,
  now = new Date(),
) {
  await database
    .update(emailLog)
    .set({ providerMessageId, status: "sent", sentAt: now, lastEventAt: now, errorMessage: null })
    .where(eq(emailLog.id, emailLogId));
}

export async function markM13EmailFailed(
  database: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  emailLogId: string,
  message: string,
  now = new Date(),
) {
  await database
    .update(emailLog)
    .set({ status: "failed", errorMessage: message, lastEventAt: now })
    .where(eq(emailLog.id, emailLogId));
}
