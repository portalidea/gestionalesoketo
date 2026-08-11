/**
 * F5 — Payment Reconciliation Router
 *
 * Admin view showing orders delivered but not yet paid, with aging (days since delivery).
 * Alert on payment delays > 30 days.
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure } from "./_core/trpc";
import { getDb } from "./db";

export const paymentReconciliationRouter = router({
  /**
   * Get all orders that are delivered/shipped but not yet paid.
   * Shows aging in days since delivery date.
   */
  getUnpaidOrders: adminProcedure
    .input(z.object({
      minAgingDays: z.number().int().min(0).optional(),
      retailerId: z.string().uuid().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const minDays = input?.minAgingDays ?? 0;
      const retailerFilter = input?.retailerId
        ? sql` AND o."retailerId" = ${input.retailerId}::uuid`
        : sql``;

      const rows = await db.execute<{
        orderId: string;
        orderNumber: string;
        retailerId: string;
        retailerName: string;
        subtotalNet: string;
        totalGross: string;
        status: string;
        deliveredAt: string | null;
        shippedAt: string | null;
        createdAt: string;
        agingDays: number;
        paymentTerms: string;
      }>(sql`
        SELECT o.id AS "orderId", o."orderNumber", o."retailerId",
               r.name AS "retailerName",
               o."subtotalNet"::text, o."totalGross"::text,
               o.status,
               o."deliveredAt"::text,
               o."shippedAt"::text,
               o."createdAt"::text,
               EXTRACT(DAY FROM NOW() - COALESCE(o."deliveredAt", o."shippedAt", o."createdAt"))::int AS "agingDays",
               r."paymentTerms"
        FROM orders o
        JOIN retailers r ON r.id = o."retailerId"
        WHERE o."companyId" = ${ctx.activeCompanyId}
          AND o.status IN ('delivered', 'shipped')
          AND o."paymentStatus" != 'paid'
          AND o."retailerId" IS NOT NULL
          ${retailerFilter}
        HAVING EXTRACT(DAY FROM NOW() - COALESCE(o."deliveredAt", o."shippedAt", o."createdAt"))::int >= ${minDays}
        ORDER BY "agingDays" DESC
      `);

      // Summary stats
      const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.totalGross || "0"), 0);
      const over30 = rows.filter((r) => r.agingDays > 30);
      const over60 = rows.filter((r) => r.agingDays > 60);

      return {
        orders: rows,
        summary: {
          totalUnpaid: rows.length,
          totalAmount: totalAmount.toFixed(2),
          over30Days: over30.length,
          over60Days: over60.length,
          amountOver30: over30.reduce((s, r) => s + parseFloat(r.totalGross || "0"), 0).toFixed(2),
        },
      };
    }),
});
