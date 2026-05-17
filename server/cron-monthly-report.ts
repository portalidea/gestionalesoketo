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

// ─── M8.1: Shopify Stock Sync Cron ─────────────────────────────────────────
// Endpoint: GET /api/cron/shopify-stock-sync
// Triggered every 6 hours by external scheduler.
// 1. Imports paid orders from last 6h
// 2. Processes stock (FEFO)
// 3. Retries previously failed orders
cronRoutes.get("/cron/shopify-stock-sync", async (req: Request, res: Response) => {
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

    const { salesStores } = await import("../drizzle/schema");
    // Get active Shopify store
    const [store] = await db
      .select()
      .from(salesStores)
      .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)))
      .limit(1);

    if (!store || !(store.apiCredentials as any)?.accessToken) {
      res.json({ success: false, error: "No active Shopify store configured" });
      return;
    }

    // 1. Import recent orders (last 6 hours)
    const { ShopifyClient } = await import("./services/shopifyService");
    const {
      importShopifyOrder,
      processStockForMarketplaceOrder,
      retryFailedOrders,
    } = await import("./services/marketplaceOrderService");

    const client = new ShopifyClient(
      store.storeIdentifier,
      (store.apiCredentials as any).accessToken,
    );

    const createdAtMin = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    let allOrders: any[] = [];
    let fetchResult = await client.fetchOrders({
      createdAtMin,
      financialStatus: "paid",
      status: "any",
      limit: 50,
    });
    allOrders.push(...fetchResult.orders);

    while (fetchResult.nextPageInfo) {
      fetchResult = await client.fetchOrdersByPageInfo(fetchResult.nextPageInfo, 50);
      allOrders.push(...fetchResult.orders);
    }

    let imported = 0;
    let duplicates = 0;
    let processedStock = 0;
    let failed = 0;

    for (const shopifyOrder of allOrders) {
      try {
        const importResult = await importShopifyOrder(store.id, shopifyOrder);
        if (importResult.status === "duplicate") {
          duplicates++;
          continue;
        }
        imported++;
        const stockResult = await processStockForMarketplaceOrder(
          importResult.marketplaceOrderId,
        );
        if (stockResult.status === "processed") processedStock++;
        else failed++;
      } catch (e: any) {
        failed++;
      }
    }

    // 2. Retry previously failed orders
    const retryResult = await retryFailedOrders(store.id);

    // 3. Update lastSyncAt
    await db
      .update(salesStores)
      .set({ lastSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(salesStores.id, store.id));

    console.log(
      `[cron/shopify-stock-sync] fetched=${allOrders.length} imported=${imported} duplicates=${duplicates} processedStock=${processedStock} failed=${failed} retried=${retryResult.retried} retrySucceeded=${retryResult.succeeded}`,
    );

    res.json({
      success: true,
      fetched: allOrders.length,
      imported,
      duplicates,
      processedStock,
      failed,
      retried: retryResult.retried,
      retrySucceeded: retryResult.succeeded,
    });
  } catch (err: any) {
    console.error("[cron/shopify-stock-sync] Fatal error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});
