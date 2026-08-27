/**
 * F1 + F2 — Cron: Alert email notifications + Tier Engine daily evaluation
 *
 * Endpoints:
 *   GET /api/cron/stock-alerts   — check stock levels + expiring batches, email admin
 *   GET /api/cron/tier-evaluation — run tier engine evaluation
 *
 * Auth: Bearer token matching CRON_SECRET env var (or no auth in dev)
 */
import { Router, Request, Response } from "express";
import { eq, and, sql, lt, gte } from "drizzle-orm";
import { getDb } from "./db";
import {
  products,
  productBatches,
  inventoryByBatch,
  locations,
  retailers,
  alerts,
  users,
  companies,
} from "../drizzle/schema";
import { sendEmail } from "./email";
import { ENV } from "./_core/env";
import { evaluateTierEngineForCompany, isMonthlyTierEvaluationDate } from "./services/tierEngineService";
import { runExpiryAlertForCompany } from "./services/expiryAlertService";
import { runScheduledShopifyOrderSync, type ShopifyOrdersFetcher, type ShopifyScheduledSyncStoreResult } from "./services/marketplaceOrderService";

export const cronAlertRoutes = Router();

export type ScheduledDispatcherResult = {
  date: string;
  tierEvaluation: {
    executed: boolean;
    companies: number;
    results: Array<{ company: string; mode: string; enabledRetailers: number; skipped: boolean; evaluated: number }>;
  };
  expiryAlerts: {
    scheduled: boolean;
    enabled: boolean;
    companies: number;
    results: Array<Awaited<ReturnType<typeof runExpiryAlertForCompany>>>;
  };
  shopifyOrderSync: {
    scheduled: boolean;
    stores: number;
    results: ShopifyScheduledSyncStoreResult[];
  };
};

/** Authenticate cron requests */
function authCron(req: Request, res: Response): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
  }
  return true;
}

/**
 * F1: Stock alerts — check all companies for:
 *   - Products below minStockThreshold (LOW_STOCK)
 *   - Batches expiring within 14 days (EXPIRING)
 *   - Batches already expired (EXPIRED)
 * Creates alert records and sends summary email to admin users.
 */
cronAlertRoutes.get("/cron/stock-alerts", async (req: Request, res: Response) => {
  if (!authCron(req, res)) return;

  const db = await getDb();
  if (!db) { res.status(500).json({ error: "DB unavailable" }); return; }

  try {
    const now = new Date();
    const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // --- LOW STOCK alerts ---
    const lowStockRows = await db.execute<{
      productId: string;
      productName: string;
      sku: string;
      minStockThreshold: number;
      currentStock: number;
      companyId: string;
      companyName: string;
    }>(sql`
      SELECT p.id AS "productId", p.name AS "productName", p.sku,
             p."minStockThreshold", 
             COALESCE(SUM(ibb.quantity), 0)::int AS "currentStock",
             c.id AS "companyId", c.name AS "companyName"
      FROM products p
      CROSS JOIN companies c
      LEFT JOIN "productBatches" pb ON pb."productId" = p.id AND pb."companyId" = c.id
      LEFT JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb.id
      LEFT JOIN locations l ON l.id = ibb."locationId" AND l."companyId" = c.id AND l."retailerId" IS NULL
      WHERE p."minStockThreshold" > 0
      GROUP BY p.id, p.name, p.sku, p."minStockThreshold", c.id, c.name
      HAVING COALESCE(SUM(ibb.quantity), 0) < p."minStockThreshold"
    `);

    // --- EXPIRING alerts (within 14 days) ---
    const expiringRows = await db.execute<{
      batchId: string;
      batchNumber: string;
      productId: string;
      productName: string;
      expirationDate: string;
      quantity: number;
      companyId: string;
      companyName: string;
      retailerId: string | null;
      retailerName: string | null;
    }>(sql`
      SELECT pb.id AS "batchId", pb."batchNumber", pb."productId", p.name AS "productName",
             pb."expirationDate"::text, ibb.quantity::int,
             c.id AS "companyId", c.name AS "companyName",
             l."retailerId", r.name AS "retailerName"
      FROM "productBatches" pb
      JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb.id AND ibb.quantity > 0
      JOIN locations l ON l.id = ibb."locationId"
      JOIN companies c ON c.id = pb."companyId"
      JOIN products p ON p.id = pb."productId"
      LEFT JOIN retailers r ON r.id = l."retailerId"
      WHERE pb."expirationDate" IS NOT NULL
        AND pb."expirationDate" <= ${in14Days.toISOString()}::timestamptz
        AND pb."expirationDate" > ${now.toISOString()}::timestamptz
    `);

    // --- EXPIRED alerts ---
    const expiredRows = await db.execute<{
      batchId: string;
      batchNumber: string;
      productId: string;
      productName: string;
      expirationDate: string;
      quantity: number;
      companyId: string;
      companyName: string;
      retailerId: string | null;
      retailerName: string | null;
    }>(sql`
      SELECT pb.id AS "batchId", pb."batchNumber", pb."productId", p.name AS "productName",
             pb."expirationDate"::text, ibb.quantity::int,
             c.id AS "companyId", c.name AS "companyName",
             l."retailerId", r.name AS "retailerName"
      FROM "productBatches" pb
      JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb.id AND ibb.quantity > 0
      JOIN locations l ON l.id = ibb."locationId"
      JOIN companies c ON c.id = pb."companyId"
      JOIN products p ON p.id = pb."productId"
      LEFT JOIN retailers r ON r.id = l."retailerId"
      WHERE pb."expirationDate" IS NOT NULL
        AND pb."expirationDate" <= ${now.toISOString()}::timestamptz
    `);

    // Create alert records for new issues
    let alertsCreated = 0;
    for (const row of lowStockRows) {
      // Check if active alert already exists
      const [existing] = await db.execute<{ cnt: number }>(sql`
        SELECT COUNT(*)::int AS cnt FROM alerts
        WHERE "productId" = ${row.productId}::uuid AND type = 'LOW_STOCK' AND status = 'ACTIVE'
      `);
      if (!existing || existing.cnt === 0) {
        await db.insert(alerts).values({
          retailerId: row.companyId, // use companyId as context
          productId: row.productId,
          type: "LOW_STOCK",
          message: `Stock ${row.productName} sotto soglia: ${row.currentStock}/${row.minStockThreshold} pezzi (${row.companyName})`,
          currentQuantity: row.currentStock,
          thresholdQuantity: row.minStockThreshold,
        });
        alertsCreated++;
      }
    }

    // Send summary email to admin users
    const adminUsers = await db.execute<{ email: string }>(sql`
      SELECT email FROM users WHERE role = 'admin'
    `);
    const adminEmails = adminUsers.map((u) => u.email).filter(Boolean);

    if (adminEmails.length > 0 && (lowStockRows.length > 0 || expiringRows.length > 0 || expiredRows.length > 0)) {
      const html = buildAlertEmailHtml(lowStockRows, expiringRows, expiredRows);
      await sendEmail({
        to: adminEmails,
        subject: `[SoKeto] Alert magazzino: ${lowStockRows.length} sotto soglia, ${expiringRows.length} in scadenza, ${expiredRows.length} scaduti`,
        html,
      });
    }

    // Also send email to retailers with expiring/expired stock at their location
    const retailerAlerts = new Map<string, { email: string; name: string; expiring: Array<typeof expiringRows[number]>; expired: Array<typeof expiredRows[number]> }>();
    for (const row of [...expiringRows, ...expiredRows]) {
      if (row.retailerId && row.retailerName) {
        if (!retailerAlerts.has(row.retailerId)) {
          // Get retailer email
          const [ret] = await db.execute<{ email: string | null }>(sql`
            SELECT email FROM retailers WHERE id = ${row.retailerId}::uuid
          `);
          if (ret?.email) {
            retailerAlerts.set(row.retailerId, { email: ret.email, name: row.retailerName, expiring: [], expired: [] });
          }
        }
        const entry = retailerAlerts.get(row.retailerId);
        if (entry) {
          const isExpired = new Date(row.expirationDate) <= now;
          if (isExpired) entry.expired.push(row);
          else entry.expiring.push(row);
        }
      }
    }

    let retailerEmailsSent = 0;
    for (const [, entry] of Array.from(retailerAlerts)) {
      if (entry.expiring.length > 0 || entry.expired.length > 0) {
        const html = buildRetailerAlertEmailHtml(entry.name, entry.expiring, entry.expired);
        await sendEmail({
          to: entry.email,
          subject: `[SoKeto] Attenzione: prodotti in scadenza nel tuo magazzino`,
          html,
        });
        retailerEmailsSent++;
      }
    }

    res.json({
      success: true,
      lowStock: lowStockRows.length,
      expiring: expiringRows.length,
      expired: expiredRows.length,
      alertsCreated,
      adminEmailSent: adminEmails.length > 0 && (lowStockRows.length > 0 || expiringRows.length > 0 || expiredRows.length > 0),
      retailerEmailsSent,
    });
  } catch (err: any) {
    console.error("[cron/stock-alerts] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * F2: Tier Engine monthly evaluation cron.
 * Runs only on the first day of each month and evaluates enabled retailers.
 */
cronAlertRoutes.get("/cron/tier-evaluation", async (req: Request, res: Response) => {
  if (!authCron(req, res)) return;

  const db = await getDb();
  if (!db) { res.status(500).json({ error: "DB unavailable" }); return; }

  try {
    const now = new Date();
    if (!isMonthlyTierEvaluationDate(now)) {
      res.json({ success: true, skipped: true, reason: "Il motore tier viene eseguito solo il primo giorno del mese" });
      return;
    }

    // Get all companies
    const allCompanies = await db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM companies WHERE "isActive" = true
    `);

    const results: Array<{ company: string; mode: string; enabledRetailers: number; skipped: boolean; evaluated: number }> = [];

    for (const company of allCompanies) {
      const evaluation = await evaluateTierEngineForCompany(company.id, { now });
      results.push({
        company: company.name,
        mode: evaluation.mode,
        enabledRetailers: evaluation.enabledRetailers,
        skipped: evaluation.skipped,
        evaluated: evaluation.results.length,
      });
    }

    res.json({
      success: true,
      date: now.toISOString().slice(0, 10),
      companies: allCompanies.length,
      results,
    });
  } catch (err: any) {
    console.error("[cron/tier-evaluation] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Dispatcher mensile condiviso, invocato ogni giorno dalla singola pianificazione
 * Vercel disponibile. Il primo giorno mantiene la valutazione tier; il decimo
 * esegue M13 in sola modalità alert e persiste i soli snapshot operativi.
 */
export async function runScheduledDispatcher(input: {
  now?: Date;
  m13CronEnabled?: boolean;
  shopifyFetchOrders?: ShopifyOrdersFetcher;
} = {}): Promise<ScheduledDispatcherResult> {
  const now = input.now ?? new Date();
  const database = await getDb();
  if (!database) throw new Error("DB unavailable");

  const allCompanies = await database.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM companies WHERE "isActive" = true
  `);

  const tierEvaluation: ScheduledDispatcherResult["tierEvaluation"] = {
    executed: false,
    companies: allCompanies.length,
    results: [],
  };
  if (isMonthlyTierEvaluationDate(now)) {
    tierEvaluation.executed = true;
    for (const company of allCompanies) {
      const evaluation = await evaluateTierEngineForCompany(company.id, { now });
      tierEvaluation.results.push({
        company: company.name,
        mode: evaluation.mode,
        enabledRetailers: evaluation.enabledRetailers,
        skipped: evaluation.skipped,
        evaluated: evaluation.results.length,
      });
    }
  }

  const m13Enabled = input.m13CronEnabled ?? process.env.M13_CRON_ENABLED === "true";
  const expiryAlerts: ScheduledDispatcherResult["expiryAlerts"] = {
    scheduled: now.getUTCDate() === 10,
    enabled: m13Enabled,
    companies: 0,
    results: [],
  };
  if (expiryAlerts.scheduled && m13Enabled) {
    expiryAlerts.companies = allCompanies.length;
    for (const company of allCompanies) {
      // M13 registra run/notifiche/item/soppressioni e non richiama alcun
      // gateway email né crea righe email_log in questa milestone.
      expiryAlerts.results.push(await runExpiryAlertForCompany({
        companyId: company.id,
        mode: "alert",
        trigger: "cron",
        dryRun: true,
        now,
      }));
    }
  }

  // Shopify è un polling giornaliero deterministico, senza un secondo cron
  // Vercel. Ogni store applica internamente il proprio cutoff e il vincolo
  // (storeId, channelOrderId) elimina gli import duplicati nella sovrapposizione.
  const shopifySync = await runScheduledShopifyOrderSync({ now, fetchOrders: input.shopifyFetchOrders });
  const shopifyOrderSync: ScheduledDispatcherResult["shopifyOrderSync"] = {
    scheduled: true,
    stores: shopifySync.stores.length,
    results: shopifySync.stores,
  };

  return {
    date: now.toISOString().slice(0, 10),
    tierEvaluation,
    expiryAlerts,
    shopifyOrderSync,
  };
}

cronAlertRoutes.get("/cron/dispatcher", async (req: Request, res: Response) => {
  if (!authCron(req, res)) return;
  try {
    res.json({ success: true, ...(await runScheduledDispatcher()) });
  } catch (err: any) {
    console.error("[cron/dispatcher] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * M13 — Calcolo alert scadenze retailer con soppressione inferita dai riordini.
 *
 * Per sicurezza il job è inattivo finché M13_CRON_ENABLED non è esattamente
 * "true". Anche una volta abilitato, questa milestone opera solo in dry-run:
 * crea snapshot/notifiche e non contatta mai Resend.
 */
cronAlertRoutes.get("/cron/expiry-alerts", async (req: Request, res: Response) => {
  if (!authCron(req, res)) return;
  if (process.env.M13_CRON_ENABLED !== "true") {
    res.json({ success: true, skipped: true, reason: "M13_CRON_ENABLED non attivo; nessun run e nessun invio eseguiti" });
    return;
  }

  const db = await getDb();
  if (!db) { res.status(500).json({ error: "DB unavailable" }); return; }

  try {
    const allCompanies = await db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM companies WHERE "isActive" = true
    `);
    const now = new Date();
    const results = [];
    for (const company of allCompanies) {
      const run = await runExpiryAlertForCompany({
        companyId: company.id,
        mode: "alert",
        trigger: "cron",
        dryRun: true,
        now,
      });
      results.push({ companyName: company.name, ...run });
    }
    res.json({ success: true, dryRun: true, realEmailDelivery: false, companies: allCompanies.length, results });
  } catch (err: any) {
    console.error("[cron/expiry-alerts] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============= Email HTML builders =============

function buildAlertEmailHtml(
  lowStock: Array<{ productName: string; currentStock: number; minStockThreshold: number; companyName: string }>,
  expiring: Array<{ productName: string; batchNumber: string; expirationDate: string; quantity: number; companyName: string; retailerName: string | null }>,
  expired: Array<{ productName: string; batchNumber: string; expirationDate: string; quantity: number; companyName: string; retailerName: string | null }>,
): string {
  let html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#2D5A27;border-bottom:2px solid #7AB648;padding-bottom:8px;">
        Report Alert Magazzino SoKeto
      </h2>
      <p style="color:#6b7280;">Generato il ${new Date().toLocaleDateString("it-IT")} alle ${new Date().toLocaleTimeString("it-IT")}</p>
  `;

  if (expired.length > 0) {
    html += `<h3 style="color:#dc2626;">Prodotti SCADUTI (${expired.length})</h3><table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="background:#fef2f2;"><th style="padding:6px;text-align:left;border:1px solid #fecaca;">Prodotto</th><th style="padding:6px;border:1px solid #fecaca;">Lotto</th><th style="padding:6px;border:1px solid #fecaca;">Scadenza</th><th style="padding:6px;border:1px solid #fecaca;">Qtà</th><th style="padding:6px;border:1px solid #fecaca;">Location</th></tr>`;
    for (const r of expired) {
      html += `<tr><td style="padding:4px;border:1px solid #fecaca;">${r.productName}</td><td style="padding:4px;border:1px solid #fecaca;">${r.batchNumber}</td><td style="padding:4px;border:1px solid #fecaca;">${new Date(r.expirationDate).toLocaleDateString("it-IT")}</td><td style="padding:4px;border:1px solid #fecaca;">${r.quantity}</td><td style="padding:4px;border:1px solid #fecaca;">${r.retailerName ?? r.companyName + " (magazzino)"}</td></tr>`;
    }
    html += `</table>`;
  }

  if (expiring.length > 0) {
    html += `<h3 style="color:#d97706;">Prodotti in SCADENZA entro 14gg (${expiring.length})</h3><table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="background:#fffbeb;"><th style="padding:6px;text-align:left;border:1px solid #fde68a;">Prodotto</th><th style="padding:6px;border:1px solid #fde68a;">Lotto</th><th style="padding:6px;border:1px solid #fde68a;">Scadenza</th><th style="padding:6px;border:1px solid #fde68a;">Qtà</th><th style="padding:6px;border:1px solid #fde68a;">Location</th></tr>`;
    for (const r of expiring) {
      html += `<tr><td style="padding:4px;border:1px solid #fde68a;">${r.productName}</td><td style="padding:4px;border:1px solid #fde68a;">${r.batchNumber}</td><td style="padding:4px;border:1px solid #fde68a;">${new Date(r.expirationDate).toLocaleDateString("it-IT")}</td><td style="padding:4px;border:1px solid #fde68a;">${r.quantity}</td><td style="padding:4px;border:1px solid #fde68a;">${r.retailerName ?? r.companyName + " (magazzino)"}</td></tr>`;
    }
    html += `</table>`;
  }

  if (lowStock.length > 0) {
    html += `<h3 style="color:#ea580c;">Prodotti SOTTO SOGLIA (${lowStock.length})</h3><table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="background:#fff7ed;"><th style="padding:6px;text-align:left;border:1px solid #fed7aa;">Prodotto</th><th style="padding:6px;border:1px solid #fed7aa;">Stock</th><th style="padding:6px;border:1px solid #fed7aa;">Soglia</th><th style="padding:6px;border:1px solid #fed7aa;">Azienda</th></tr>`;
    for (const r of lowStock) {
      html += `<tr><td style="padding:4px;border:1px solid #fed7aa;">${r.productName}</td><td style="padding:4px;border:1px solid #fed7aa;">${r.currentStock}</td><td style="padding:4px;border:1px solid #fed7aa;">${r.minStockThreshold}</td><td style="padding:4px;border:1px solid #fed7aa;">${r.companyName}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<p style="margin-top:20px;font-size:12px;color:#9ca3af;">Questo report è generato automaticamente dal sistema SoKeto Gestionale.</p></div>`;
  return html;
}

function buildRetailerAlertEmailHtml(
  retailerName: string,
  expiring: Array<{ productName: string; batchNumber: string; expirationDate: string; quantity: number }>,
  expired: Array<{ productName: string; batchNumber: string; expirationDate: string; quantity: number }>,
): string {
  let html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#2D5A27;border-bottom:2px solid #7AB648;padding-bottom:8px;">
        Avviso Scadenze — ${retailerName}
      </h2>
      <p style="color:#6b7280;">Gentile ${retailerName}, ti segnaliamo i seguenti prodotti nel tuo magazzino:</p>
  `;

  if (expired.length > 0) {
    html += `<h3 style="color:#dc2626;">Prodotti SCADUTI (${expired.length})</h3><ul>`;
    for (const r of expired) {
      html += `<li><strong>${r.productName}</strong> — Lotto ${r.batchNumber}, scaduto il ${new Date(r.expirationDate).toLocaleDateString("it-IT")} (${r.quantity} pz)</li>`;
    }
    html += `</ul>`;
  }

  if (expiring.length > 0) {
    html += `<h3 style="color:#d97706;">Prodotti in scadenza (${expiring.length})</h3><ul>`;
    for (const r of expiring) {
      html += `<li><strong>${r.productName}</strong> — Lotto ${r.batchNumber}, scade il ${new Date(r.expirationDate).toLocaleDateString("it-IT")} (${r.quantity} pz)</li>`;
    }
    html += `</ul>`;
  }

  html += `<p style="margin-top:20px;color:#6b7280;">Ti consigliamo di verificare la rotazione dei prodotti e contattarci per eventuali sostituzioni.</p>`;
  html += `<p style="font-size:12px;color:#9ca3af;">— Team SoKeto</p></div>`;
  return html;
}
