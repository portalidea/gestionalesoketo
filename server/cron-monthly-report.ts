/**
 * M7-B — Cron: Monthly Affiliate Report
 * 
 * Endpoint: GET /api/cron/affiliate-monthly-report
 * Triggered by external scheduler (e.g., cron.org, Heartbeat) on the 1st of each month.
 * 
 * For each active affiliate with commissions in the previous month:
 * - Aggregates pending/paid amounts
 * - Sends a monthly summary email
 * 
 * Auth: Bearer token matching CRON_SECRET env var (or no auth in dev)
 */
import { Router, Request, Response } from "express";
import { eq, and, gte, lt, sql, count } from "drizzle-orm";
import { getDb } from "./db";
import { affiliates, affiliateCommissions, retailers } from "../drizzle/schema";
import { sendEmail } from "./email";
import { buildMonthlyReportEmailHtml } from "./affiliates-router";

export const cronRoutes = Router();

cronRoutes.get("/cron/affiliate-monthly-report", async (req: Request, res: Response) => {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  try {
    const db = await getDb();
    if (!db) {
      res.status(500).json({ error: "Database not available" });
      return;
    }

    // Calculate previous month range
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}`;

    console.log(`[cron/affiliate-monthly-report] Processing month: ${monthStr}`);

    // Get all active affiliates
    const activeAffiliates = await db
      .select({
        id: affiliates.id,
        name: affiliates.name,
        email: affiliates.email,
      })
      .from(affiliates)
      .where(eq(affiliates.status, "active"));

    let emailsSent = 0;
    let errors = 0;

    for (const affiliate of activeAffiliates) {
      try {
        // Get commission stats for this affiliate in the previous month
        const [stats] = await db
          .select({
            totalPending: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'pending' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
            totalPaid: sql<string>`COALESCE(SUM(CASE WHEN ${affiliateCommissions.status} = 'paid' THEN ${affiliateCommissions.commissionAmount}::numeric ELSE 0 END), 0)`,
            commissionsCount: count(),
          })
          .from(affiliateCommissions)
          .where(
            and(
              eq(affiliateCommissions.affiliateId, affiliate.id),
              gte(affiliateCommissions.pendingAt, startDate),
              lt(affiliateCommissions.pendingAt, endDate),
            ),
          );

        const commissionsCount = stats?.commissionsCount ?? 0;
        if (commissionsCount === 0) continue; // Skip affiliates with no activity

        // Count unique retailers
        const [retailerStats] = await db
          .select({
            retailersCount: sql<number>`COUNT(DISTINCT ${affiliateCommissions.retailerId})::int`,
          })
          .from(affiliateCommissions)
          .where(
            and(
              eq(affiliateCommissions.affiliateId, affiliate.id),
              gte(affiliateCommissions.pendingAt, startDate),
              lt(affiliateCommissions.pendingAt, endDate),
            ),
          );

        const totalPending = parseFloat(stats?.totalPending || "0");
        const totalPaid = parseFloat(stats?.totalPaid || "0");
        const retailersCount = retailerStats?.retailersCount ?? 0;

        // Send email
        if (affiliate.email) {
          await sendEmail({
            to: affiliate.email,
            subject: `Report mensile commissioni — ${monthStr}`,
            html: buildMonthlyReportEmailHtml({
              affiliateName: affiliate.name,
              month: monthStr,
              totalPending,
              totalPaid,
              commissionsCount,
              retailersCount,
            }),
            from: "SoKeto Partner <partner@sm.soketo.it>",
          });
          emailsSent++;
        }
      } catch (err) {
        console.error(`[cron/affiliate-monthly-report] Error for affiliate ${affiliate.id}:`, err);
        errors++;
      }
    }

    console.log(`[cron/affiliate-monthly-report] Done: ${emailsSent} emails sent, ${errors} errors`);
    res.json({
      success: true,
      month: monthStr,
      affiliatesProcessed: activeAffiliates.length,
      emailsSent,
      errors,
    });
  } catch (err) {
    console.error("[cron/affiliate-monthly-report] Fatal error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
