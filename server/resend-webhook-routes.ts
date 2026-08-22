import type { Request, Response } from "express";
import { Webhook } from "svix";
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4 };
const terminal = new Set(["bounced", "complained", "failed"]);

function eventStatus(type: string): string | null {
  const suffix = type.replace(/^email\./, "");
  return ["sent", "delivered", "opened", "clicked", "bounced", "complained", "failed"].includes(suffix) ? suffix : null;
}

export const resendWebhookHandler = async (req: Request, res: Response) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) { res.status(503).json({ error: "Webhook Resend non configurato" }); return; }
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const headers = { "svix-id": req.header("svix-id") ?? "", "svix-timestamp": req.header("svix-timestamp") ?? "", "svix-signature": req.header("svix-signature") ?? "" };
  let payload: any;
  try { payload = new Webhook(secret).verify(raw, headers); }
  catch { res.status(400).json({ error: "Firma webhook non valida" }); return; }

  const providerEventId = headers["svix-id"];
  const providerMessageId = payload?.data?.email_id;
  const status = eventStatus(payload?.type ?? "");
  if (!providerEventId || !providerMessageId || !status) { res.status(200).json({ ignored: true }); return; }
  const db = await getDb();
  if (!db) { res.status(500).json({ error: "DB non disponibile" }); return; }

  try {
    await db.transaction(async (tx) => {
      const logs = await tx.execute(sql`SELECT id, status FROM email_log WHERE provider = 'resend' AND provider_message_id = ${providerMessageId} FOR UPDATE`);
      const log = logs[0] as any;
      if (!log) return;
      try {
        await tx.execute(sql`INSERT INTO email_events (email_log_id, provider, provider_event_id, event_type, occurred_at, payload) VALUES (${log.id}::uuid, 'resend', ${providerEventId}, ${payload.type}, ${payload.created_at ?? new Date().toISOString()}::timestamptz, ${JSON.stringify(payload)}::jsonb)`);
      } catch (error: any) {
        if (error?.cause?.code === "23505" || error?.code === "23505") return;
        throw error;
      }
      const current = String(log.status);
      const shouldAdvance = !terminal.has(current) && (terminal.has(status) || ((rank[status] ?? -1) > (rank[current] ?? -1)));
      const timestamps: Record<string, string> = { sent: "sent_at", delivered: "delivered_at", opened: "opened_at", clicked: "clicked_at", bounced: "bounced_at", complained: "complained_at" };
      const timestampColumn = timestamps[status];
      await tx.execute(sql`UPDATE email_log SET last_event_at = ${payload.created_at ?? new Date().toISOString()}::timestamptz, ${sql.raw(timestampColumn ? `"${timestampColumn}"` : "last_event_at")} = ${payload.created_at ?? new Date().toISOString()}::timestamptz, status = ${shouldAdvance ? status : current}, error_message = ${terminal.has(status) ? (payload?.data?.bounce?.message ?? payload?.data?.error ?? status) : null} WHERE id = ${log.id}::uuid`);
    });
    res.status(200).json({ received: true });
  } catch (error) { console.error("[webhooks/resend]", error); res.status(500).json({ error: "Errore interno" }); }
};
