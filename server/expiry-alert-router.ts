import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, adminProcedure, publicProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { runExpiryAlertForCompany } from "./services/expiryAlertService";
import { sql } from "drizzle-orm";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const expiryAlertsRouter = router({
  runAlignment: adminProcedure
    .input(z.object({ runDate: dateString.optional() }))
    .mutation(async ({ ctx, input }) => {
      const now = input.runDate ? new Date(`${input.runDate}T12:00:00.000Z`) : new Date();
      return runExpiryAlertForCompany({
        companyId: ctx.activeCompanyId,
        mode: "alignment",
        trigger: "dry_run",
        dryRun: true,
        now,
      });
    }),

  getSettings: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
    const rows = await db.execute<{ minPiecesThreshold: number }>(sql`
      SELECT min_pieces_threshold::int AS "minPiecesThreshold"
      FROM expiry_alert_settings WHERE company_id = ${ctx.activeCompanyId}::uuid
    `);
    return rows[0] ?? { minPiecesThreshold: 5 };
  }),

  updateSettings: adminProcedure
    .input(z.object({ minPiecesThreshold: z.number().int().min(1).max(100000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
      await db.execute(sql`
        UPDATE expiry_alert_settings SET min_pieces_threshold = ${input.minPiecesThreshold}
        WHERE company_id = ${ctx.activeCompanyId}::uuid
      `);
      return { success: true };
    }),

  listRuns: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.execute(sql`
        SELECT id, mode, run_date::text AS "runDate", period_start::text AS "periodStart", period_end::text AS "periodEnd",
          trigger, status, retailers_evaluated::int AS "retailersEvaluated", retailers_notified::int AS "retailersNotified",
          emails_sent::int AS "emailsSent", emails_failed::int AS "emailsFailed", items_flagged::int AS "itemsFlagged",
          error_message AS "errorMessage", created_at AS "createdAt", completed_at AS "completedAt"
        FROM expiry_alert_runs
        WHERE company_id = ${ctx.activeCompanyId}::uuid
        ORDER BY created_at DESC LIMIT ${input.limit}
      `);
    }),

  getNotifications: adminProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.execute(sql`
        SELECT n.id, n.retailer_name AS "retailerName", n.recipient_email AS "recipientEmail", n.status, n.skip_reason AS "skipReason",
          n.response_token AS "responseToken", n.responded_at AS "respondedAt", n.response_type AS "responseType", n.response_note AS "responseNote",
          n.items_count::int AS "itemsCount", e.status AS "emailStatus", e.provider_message_id AS "providerMessageId", e.error_message AS "emailError"
        FROM expiry_alert_notifications n
        JOIN expiry_alert_runs r ON r.id = n.run_id AND r.company_id = ${ctx.activeCompanyId}::uuid
        LEFT JOIN email_log e ON e.id = n.email_log_id
        WHERE n.run_id = ${input.runId}::uuid
        ORDER BY n.retailer_name
      `);
    }),

  getResponseByToken: publicProcedure
    .input(z.object({ token: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const header = await db.execute(sql`
        SELECT n.id, n.retailer_name AS "retailerName", n.status, n.token_expires_at AS "tokenExpiresAt", n.responded_at AS "respondedAt",
          r.mode, r.company_id AS "companyId"
        FROM expiry_alert_notifications n JOIN expiry_alert_runs r ON r.id = n.run_id
        WHERE n.response_token = ${input.token}::uuid
      `);
      if (!header[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Link non valido" });
      const items = await db.execute(sql`
        SELECT id, product_name AS "productName", batch_code AS "batchCode", expiry_date::text AS "expiryDate",
          quantity_pieces::int AS "quantityPieces", pieces_per_unit::int AS "piecesPerUnit", declared_quantity AS "declaredQuantity",
          delivery_status AS "deliveryStatus", adjustment_applied AS "adjustmentApplied"
        FROM expiry_alert_items WHERE notification_id = ${header[0].id}::uuid ORDER BY expiry_date, product_name, batch_code
      `);
      return { notification: header[0], items };
    }),

  submitResponse: publicProcedure
    .input(z.object({
      token: z.string().uuid(),
      note: z.string().max(2000).optional(),
      items: z.array(z.object({ itemId: z.string().uuid(), declaredQuantity: z.number().int().min(0) })).min(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db.transaction(async (tx) => {
        const notification = await tx.execute(sql`
          SELECT n.id, n.retailer_id AS "retailerId", r.company_id AS "companyId", n.responded_at AS "respondedAt", n.token_expires_at AS "tokenExpiresAt"
          FROM expiry_alert_notifications n JOIN expiry_alert_runs r ON r.id = n.run_id
          WHERE n.response_token = ${input.token}::uuid FOR UPDATE
        `);
        const row = notification[0] as any;
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Link non valido" });
        if (row.respondedAt) throw new TRPCError({ code: "CONFLICT", message: "Risposta già registrata" });
        if (new Date(row.tokenExpiresAt) < new Date()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Link scaduto" });
        if (!row.retailerId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Notifica interna non rettificabile via link retailer" });

        for (const requested of input.items) {
          const item = await tx.execute(sql`
            SELECT i.id, i.product_id AS "productId", i.batch_id AS "batchId", i.quantity_pieces::int AS "snapshotQuantity",
              l.id AS "locationId", ibb.id AS "inventoryId", ibb.quantity::int AS "currentQuantity"
            FROM expiry_alert_items i
            JOIN locations l ON l."retailerId" = ${row.retailerId}::uuid AND l."companyId" = ${row.companyId}::uuid AND l.type = 'retailer'
            JOIN "inventoryByBatch" ibb ON ibb."locationId" = l.id AND ibb."batchId" = i.batch_id AND ibb."companyId" = ${row.companyId}::uuid
            WHERE i.id = ${requested.itemId}::uuid AND i.notification_id = ${row.id}::uuid
            FOR UPDATE
          `);
          const stock = item[0] as any;
          if (!stock?.productId || !stock?.batchId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Riga non più rettificabile" });
          const delta = requested.declaredQuantity - Number(stock.currentQuantity);
          if (delta !== 0) {
            await tx.execute(sql`UPDATE "inventoryByBatch" SET quantity = ${requested.declaredQuantity}, "updatedAt" = now() WHERE id = ${stock.inventoryId}::uuid`);
            await tx.execute(sql`
              INSERT INTO "stockMovements" ("productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "toLocationId", "sourceDocumentType", "sourceDocument", notes, "notesInternal", "adjustmentReason", "adjustmentNote", "companyId")
              VALUES (${stock.productId}::uuid, 'ADJUSTMENT', ${delta}, ${stock.currentQuantity}, ${requested.declaredQuantity}, ${stock.batchId}::uuid, ${stock.locationId}::uuid,
                'm13_expiry_response', ${row.id}::text, 'dichiarazione rivenditore — M13', ${`notification_id=${row.id}; snapshot=${stock.snapshotQuantity}; dichiarato=${requested.declaredQuantity}`}, 'other', 'dichiarazione rivenditore — M13', ${row.companyId}::uuid)
            `);
          }
          await tx.execute(sql`UPDATE expiry_alert_items SET declared_quantity = ${requested.declaredQuantity}, adjustment_applied = ${delta !== 0} WHERE id = ${requested.itemId}::uuid`);
        }
        await tx.execute(sql`
          UPDATE expiry_alert_notifications SET responded_at = now(), response_type = 'inventory_declaration', response_note = ${input.note ?? null}
          WHERE id = ${row.id}::uuid
        `);
        return { success: true };
      });
    }),
});
