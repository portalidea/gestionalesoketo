import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  pricingPackages,
  retailers,
  tierChanges,
  tierEngineConfig,
  tierRules,
  tierSimulationLog,
} from "../../drizzle/schema";

const TIER_HIERARCHY = ["Starter", "Partner", "Premium", "Elite"] as const;

function getTierBelow(tier: string): string | null {
  const index = TIER_HIERARCHY.indexOf(tier as (typeof TIER_HIERARCHY)[number]);
  return index > 0 ? TIER_HIERARCHY[index - 1] : null;
}

function getTierAbove(tier: string): string | null {
  const index = TIER_HIERARCHY.indexOf(tier as (typeof TIER_HIERARCHY)[number]);
  return index >= 0 && index < TIER_HIERARCHY.length - 1 ? TIER_HIERARCHY[index + 1] : null;
}

export type TierEngineMode = "observation" | "active";

export type TierEvaluationResult = {
  retailerName: string;
  action: string;
  from?: string;
  to?: string;
};

export function isMonthlyTierEvaluationDate(date: Date): boolean {
  return date.getUTCDate() === 1;
}

/**
 * Valuta una company una sola volta per mese. Sono presi in considerazione
 * esclusivamente i retailer con tier_engine_enabled=true. Promozioni e
 * declassamenti usano l'ultimo mese chiuso, così il nuovo tier si applica
 * all'intero mese appena iniziato.
 */
export async function evaluateTierEngineForCompany(
  companyId: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<{
  mode: TierEngineMode;
  date: string;
  skipped: boolean;
  message?: string;
  enabledRetailers: number;
  results: TierEvaluationResult[];
}> {
  const db = await getDb();
  if (!db) throw new Error("DB non disponibile");

  const now = options.now ?? new Date();
  const runDate = now.toISOString().slice(0, 10);
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  const [modeRow] = await db
    .select()
    .from(tierEngineConfig)
    .where(eq(tierEngineConfig.key, "tier_engine_mode"));
  const mode = (modeRow?.value ?? "observation") as TierEngineMode;

  if (mode === "active" && !isMonthlyTierEvaluationDate(now)) {
    return {
      mode,
      date: runDate,
      skipped: true,
      message: "In modalità attiva la valutazione tier può modificare gli sconti solo il primo giorno del mese",
      enabledRetailers: 0,
      results: [],
    };
  }

  const rules = await db.select().from(tierRules).where(eq(tierRules.isActive, true));
  const rulesMap = new Map(rules.map((rule) => [rule.tierName, rule]));

  const retailerRows = await db.execute<{
    id: string;
    name: string;
    tierName: string | null;
    tierFrozen: boolean;
    pricingModel: string;
  }>(sql`
    SELECT r.id, r.name, pp.name AS "tierName", r.tier_frozen AS "tierFrozen", r."pricingModel"
    FROM retailers r
    LEFT JOIN "pricingPackages" pp ON pp.id = r."pricingPackageId"
    WHERE r."companyId" = ${companyId}::uuid
      AND r.tier_engine_enabled = true
    ORDER BY r.name
  `);

  if (retailerRows.length === 0) {
    return { mode, date: runDate, skipped: true, enabledRetailers: 0, results: [] };
  }

  if (!options.force) {
    if (mode === "observation") {
      const [existingSimulation] = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM tier_simulation_log tsl
        JOIN retailers r ON r.id = tsl."retailerId"
        WHERE tsl.run_date = ${runDate}::date
          AND r."companyId" = ${companyId}::uuid
          AND r.tier_engine_enabled = true
      `);
      if ((existingSimulation?.count ?? 0) > 0) {
        return { mode, date: runDate, skipped: true, enabledRetailers: retailerRows.length, results: [] };
      }
    } else {
      const [existingActiveRun] = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM retailers
        WHERE "companyId" = ${companyId}::uuid
          AND tier_engine_enabled = true
          AND last_tier_evaluation = ${runDate}::date
      `);
      if ((existingActiveRun?.count ?? 0) > 0) {
        return { mode, date: runDate, skipped: true, enabledRetailers: retailerRows.length, results: [] };
      }
    }
  }

  if (mode === "observation" && options.force) {
    await db.execute(sql`
      DELETE FROM tier_simulation_log
      WHERE run_date = ${runDate}::date
        AND "retailerId" IN (
          SELECT id FROM retailers
          WHERE "companyId" = ${companyId}::uuid AND tier_engine_enabled = true
        )
    `);
  }

  const revenueRows = await db.execute<{
    retailerId: string;
    year: number;
    month: number;
    revenueNet: string;
  }>(sql`
    SELECT o."retailerId",
           EXTRACT(YEAR FROM o."paidAt")::int AS year,
           EXTRACT(MONTH FROM o."paidAt")::int AS month,
           COALESCE(SUM(o."subtotalNet"), 0)::text AS "revenueNet"
    FROM orders o
    JOIN retailers r ON r.id = o."retailerId"
    WHERE o."paymentStatus" = 'paid'
      AND o.status != 'cancelled'
      AND o."companyId" = ${companyId}::uuid
      AND r.tier_engine_enabled = true
      AND o."retailerId" IS NOT NULL
      AND o."paidAt" IS NOT NULL
    GROUP BY o."retailerId", EXTRACT(YEAR FROM o."paidAt"), EXTRACT(MONTH FROM o."paidAt")
  `);

  const revenueByRetailer = new Map<string, Array<{ year: number; month: number; revenue: number }>>();
  for (const row of revenueRows) {
    const existing = revenueByRetailer.get(row.retailerId) ?? [];
    existing.push({ year: row.year, month: row.month, revenue: parseFloat(row.revenueNet) });
    revenueByRetailer.set(row.retailerId, existing);
  }

  for (const row of revenueRows) {
    const retailer = retailerRows.find((item) => item.id === row.retailerId);
    const tierName = retailer?.tierName ?? null;
    const rule = tierName ? rulesMap.get(tierName) : null;
    const threshold = rule ? parseFloat(rule.monthlyMaintenanceThreshold) : 0;
    const revenue = parseFloat(row.revenueNet);
    const metThreshold = threshold <= 0 || revenue >= threshold;
    await db.execute(sql`
      INSERT INTO retailer_monthly_revenue ("retailerId", year, month, revenue_net, tier_at_time, threshold_at_time, met_threshold)
      VALUES (${row.retailerId}::uuid, ${row.year}, ${row.month}, ${revenue.toFixed(2)}::numeric,
              ${tierName}, ${threshold.toFixed(2)}::numeric, ${metThreshold})
      ON CONFLICT ("retailerId", year, month) DO UPDATE SET
        revenue_net = EXCLUDED.revenue_net,
        tier_at_time = EXCLUDED.tier_at_time,
        threshold_at_time = EXCLUDED.threshold_at_time,
        met_threshold = EXCLUDED.met_threshold
    `);
  }

  const packages = await db.select().from(pricingPackages);
  const packageByTier = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const results: TierEvaluationResult[] = [];

  for (const retailer of retailerRows) {
    const tierName = retailer.tierName;
    if (!tierName || tierName === "Special" || retailer.tierFrozen || retailer.pricingModel === "cost_markup") {
      const reason = retailer.tierFrozen
        ? "Tier bloccato manualmente"
        : tierName === "Special"
          ? "Tier Special escluso"
          : retailer.pricingModel === "cost_markup"
            ? "Modello cost_markup escluso"
            : "Nessun tier assegnato";
      if (mode === "observation") {
        await db.insert(tierSimulationLog).values({
          runDate,
          retailerId: retailer.id,
          currentTier: tierName,
          wouldChangeTo: null,
          action: "no_change",
          monthlyRevenueSnapshot: "0.00",
          consecutiveMonthsBelow: 0,
          reason,
        });
      }
      results.push({ retailerName: retailer.name, action: "no_change" });
      continue;
    }

    const rule = rulesMap.get(tierName);
    if (!rule) {
      results.push({ retailerName: retailer.name, action: "no_change" });
      continue;
    }

    const monthRows = await db.execute<{ year: number; month: number; met: boolean }>(sql`
      SELECT year, month, met_threshold AS met
      FROM retailer_monthly_revenue
      WHERE "retailerId" = ${retailer.id}::uuid
        AND (year < ${currentYear} OR (year = ${currentYear} AND month < ${currentMonth}))
      ORDER BY year DESC, month DESC
    `);

    let consecutiveBelow = 0;
    for (const month of monthRows) {
      if (month.met) break;
      consecutiveBelow++;
    }

    const lastClosedMonth = monthRows[0] ?? null;
    const lastClosedRevenue = lastClosedMonth
      ? revenueByRetailer.get(retailer.id)?.find(
          (row) => row.year === lastClosedMonth.year && row.month === lastClosedMonth.month,
        )?.revenue ?? 0
      : 0;

    let action = "no_change";
    let wouldChangeTo: string | null = null;
    let reason = "Nessun cambio previsto";
    const tierAbove = getTierAbove(tierName);
    if (tierAbove) {
      const aboveRule = rulesMap.get(tierAbove);
      const promotionThreshold = aboveRule
        ? parseFloat(aboveRule.promotionThreshold ?? aboveRule.monthlyMaintenanceThreshold)
        : Number.POSITIVE_INFINITY;
      if (lastClosedRevenue >= promotionThreshold) {
        action = mode === "observation" ? "would_promote" : "auto_promotion";
        wouldChangeTo = tierAbove;
        reason = `Fatturato mese chiuso €${lastClosedRevenue.toFixed(2)} >= soglia promozione €${promotionThreshold.toFixed(2)} per ${tierAbove}`;
      }
    }

    const threshold = parseFloat(rule.monthlyMaintenanceThreshold);
    if (action === "no_change" && consecutiveBelow >= rule.consecutiveMonthsForDowngrade) {
      const tierBelow = getTierBelow(tierName);
      if (tierBelow) {
        action = mode === "observation" ? "would_downgrade" : "auto_downgrade";
        wouldChangeTo = tierBelow;
        reason = `${consecutiveBelow} mesi chiusi consecutivi sotto soglia €${threshold.toFixed(2)}`;
      }
    }

    const atRisk = action === "no_change" && consecutiveBelow >= rule.consecutiveMonthsForDowngrade - 1;
    if (atRisk) {
      action = "would_flag_risk";
      reason = `${consecutiveBelow} mesi chiusi consecutivi sotto soglia €${threshold.toFixed(2)}`;
    }

    if (mode === "observation") {
      await db.insert(tierSimulationLog).values({
        runDate,
        retailerId: retailer.id,
        currentTier: tierName,
        wouldChangeTo,
        action,
        monthlyRevenueSnapshot: lastClosedRevenue.toFixed(2),
        consecutiveMonthsBelow: consecutiveBelow,
        reason,
      });
    } else if (wouldChangeTo && (action === "auto_downgrade" || action === "auto_promotion")) {
      const packageForTier = packageByTier.get(wouldChangeTo);
      if (packageForTier) {
        await db.update(retailers).set({
          pricingPackageId: packageForTier.id,
          consecutiveMonthsBelow: 0,
          atRisk: false,
          lastTierEvaluation: runDate,
          updatedAt: now,
        }).where(eq(retailers.id, retailer.id));
        await db.insert(tierChanges).values({
          retailerId: retailer.id,
          fromTier: tierName,
          toTier: wouldChangeTo,
          reason: action,
          monthlyRevenueSnapshot: lastClosedRevenue.toFixed(2),
        });
      }
    } else {
      await db.update(retailers).set({
        consecutiveMonthsBelow: consecutiveBelow,
        atRisk,
        lastTierEvaluation: runDate,
        updatedAt: now,
      }).where(eq(retailers.id, retailer.id));
    }

    results.push({
      retailerName: retailer.name,
      action,
      ...(wouldChangeTo ? { from: tierName, to: wouldChangeTo } : {}),
    });
  }

  return { mode, date: runDate, skipped: false, enabledRetailers: retailerRows.length, results };
}
