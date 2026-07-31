/**
 * M13.A — Tier Engine Router
 *
 * Procedures for tier rules configuration, retailer tier status,
 * freeze/unfreeze, manual tier change, at-risk list, tier history,
 * and the daily evaluation job (observation/active modes).
 */
import { z } from "zod";
import { eq, and, sql, desc, gte, lte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure, staffProcedure } from "./_core/trpc";
import { getDb } from "./db";
import {
  tierRules,
  tierChanges,
  retailerMonthlyRevenue,
  tierSimulationLog,
  tierEngineConfig,
  retailers,
  orders,
  pricingPackages,
} from "../drizzle/schema";

// Tier hierarchy (lowest to highest)
const TIER_HIERARCHY = ["Starter", "Partner", "Premium", "Elite"] as const;
type TierName = (typeof TIER_HIERARCHY)[number];

function getTierIndex(tier: string): number {
  return TIER_HIERARCHY.indexOf(tier as TierName);
}

function getTierBelow(tier: string): string | null {
  const idx = getTierIndex(tier);
  return idx > 0 ? TIER_HIERARCHY[idx - 1] : null;
}

function getTierAbove(tier: string): string | null {
  const idx = getTierIndex(tier);
  return idx >= 0 && idx < TIER_HIERARCHY.length - 1 ? TIER_HIERARCHY[idx + 1] : null;
}

export const tierRulesRouter = router({
  // ============= CONFIG =============

  getConfig: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

    const rules = await db.select().from(tierRules).orderBy(tierRules.tierName);
    const [modeRow] = await db
      .select()
      .from(tierEngineConfig)
      .where(eq(tierEngineConfig.key, "tier_engine_mode"));

    return {
      rules,
      mode: (modeRow?.value ?? "observation") as "observation" | "active",
    };
  }),

  updateConfig: adminProcedure
    .input(
      z.object({
        tierId: z.string().uuid(),
        monthlyMaintenanceThreshold: z.number().min(0),
        promotionThreshold: z.number().min(0).nullable(),
        consecutiveMonthsForDowngrade: z.number().int().min(1).max(12),
        isActive: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      await db
        .update(tierRules)
        .set({
          monthlyMaintenanceThreshold: input.monthlyMaintenanceThreshold.toFixed(2),
          promotionThreshold: input.promotionThreshold?.toFixed(2) ?? null,
          consecutiveMonthsForDowngrade: input.consecutiveMonthsForDowngrade,
          isActive: input.isActive,
          updatedAt: new Date(),
        })
        .where(eq(tierRules.id, input.tierId));

      return { success: true };
    }),

  setMode: adminProcedure
    .input(z.object({ mode: z.enum(["observation", "active"]) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      await db
        .update(tierEngineConfig)
        .set({ value: input.mode, updatedAt: new Date() })
        .where(eq(tierEngineConfig.key, "tier_engine_mode"));

      return { success: true, mode: input.mode };
    }),

  // ============= RETAILER STATUS =============

  getRetailerStatus: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

    // Get all retailers with their pricing package (tier) info
    const retailerRows = await db.execute<{
      id: string;
      name: string;
      tierFrozen: boolean;
      consecutiveMonthsBelow: number;
      atRisk: boolean;
      lastTierEvaluation: string | null;
      tierName: string | null;
      companyId: string;
      pricingModel: string;
    }>(sql`
      SELECT r.id, r.name, r.tier_frozen AS "tierFrozen",
             r.consecutive_months_below AS "consecutiveMonthsBelow",
             r.at_risk AS "atRisk",
             r.last_tier_evaluation AS "lastTierEvaluation",
             pp.name AS "tierName",
             r."companyId",
             r."pricingModel"
      FROM retailers r
      LEFT JOIN "pricingPackages" pp ON pp.id = r."pricingPackageId"
      WHERE r."companyId" = ${ctx.activeCompanyId}
      ORDER BY r.name
    `);

    // Get current month revenue for each retailer
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const startOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
    const endOfMonth = month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, "0")}-01`;

    const revenueRows = await db.execute<{
      retailerId: string;
      revenue: string;
    }>(sql`
      SELECT o."retailerId", COALESCE(SUM(o."subtotalNet"), 0)::text AS revenue
      FROM orders o
      WHERE o."paymentStatus" = 'paid'
        AND o.status != 'cancelled'
        AND o."companyId" = ${ctx.activeCompanyId}
        AND o."createdAt" >= ${startOfMonth}::timestamptz
        AND o."createdAt" < ${endOfMonth}::timestamptz
        AND o."retailerId" IS NOT NULL
      GROUP BY o."retailerId"
    `);

    const revenueMap = new Map(revenueRows.map((r) => [r.retailerId, parseFloat(r.revenue)]));

    return retailerRows.map((r) => ({
      ...r,
      currentMonthRevenue: revenueMap.get(r.id) ?? 0,
    }));
  }),

  // ============= FREEZE =============

  setFreeze: adminProcedure
    .input(z.object({ retailerId: z.string().uuid(), frozen: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      await db
        .update(retailers)
        .set({ tierFrozen: input.frozen, updatedAt: new Date() })
        .where(eq(retailers.id, input.retailerId));

      // Log the freeze/unfreeze
      const [retailer] = await db
        .select({ name: retailers.name })
        .from(retailers)
        .where(eq(retailers.id, input.retailerId));

      await db.insert(tierChanges).values({
        retailerId: input.retailerId,
        reason: input.frozen ? "freeze" : "unfreeze",
        createdBy: ctx.user!.id,
      });

      return { success: true };
    }),

  // ============= MANUAL TIER CHANGE =============

  manualTierChange: adminProcedure
    .input(
      z.object({
        retailerId: z.string().uuid(),
        newTierPackageId: z.string().uuid(),
        reason: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Get current tier
      const [retailer] = await db.execute<{ pricingPackageId: string | null; tierName: string | null }>(sql`
        SELECT r."pricingPackageId", pp.name AS "tierName"
        FROM retailers r
        LEFT JOIN "pricingPackages" pp ON pp.id = r."pricingPackageId"
        WHERE r.id = ${input.retailerId}
      `);

      // Get new tier name
      const [newPkg] = await db
        .select({ name: pricingPackages.name })
        .from(pricingPackages)
        .where(eq(pricingPackages.id, input.newTierPackageId));

      if (!newPkg) throw new TRPCError({ code: "NOT_FOUND", message: "Pacchetto non trovato" });

      // Update retailer
      await db
        .update(retailers)
        .set({
          pricingPackageId: input.newTierPackageId,
          consecutiveMonthsBelow: 0, // Reset counter on manual change
          atRisk: false,
          updatedAt: new Date(),
        })
        .where(eq(retailers.id, input.retailerId));

      // Log change
      await db.insert(tierChanges).values({
        retailerId: input.retailerId,
        fromTier: retailer?.tierName ?? null,
        toTier: newPkg.name,
        reason: input.reason ?? "manual",
        createdBy: ctx.user!.id,
      });

      return { success: true };
    }),

  // ============= AT RISK =============

  getAtRiskRetailers: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

    return await db.execute<{
      id: string;
      name: string;
      tierName: string | null;
      consecutiveMonthsBelow: number;
      lastTierEvaluation: string | null;
    }>(sql`
      SELECT r.id, r.name, pp.name AS "tierName",
             r.consecutive_months_below AS "consecutiveMonthsBelow",
             r.last_tier_evaluation AS "lastTierEvaluation"
      FROM retailers r
      LEFT JOIN "pricingPackages" pp ON pp.id = r."pricingPackageId"
      WHERE r.at_risk = true
        AND r."companyId" = ${ctx.activeCompanyId}
      ORDER BY r.consecutive_months_below DESC, r.name
    `);
  }),

  // ============= TIER HISTORY =============

  getTierHistory: adminProcedure
    .input(z.object({ retailerId: z.string().uuid().optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      if (input.retailerId) {
        return await db.execute<{
          id: string;
          fromTier: string | null;
          toTier: string | null;
          reason: string | null;
          monthlyRevenueSnapshot: string | null;
          createdAt: string;
          retailerName: string;
        }>(sql`
          SELECT tc.id, tc.from_tier AS "fromTier", tc.to_tier AS "toTier",
                 tc.reason, tc.monthly_revenue_snapshot AS "monthlyRevenueSnapshot",
                 tc."createdAt"::text, r.name AS "retailerName"
          FROM tier_changes tc
          JOIN retailers r ON r.id = tc."retailerId"
          WHERE tc."retailerId" = ${input.retailerId}
          ORDER BY tc."createdAt" DESC
          LIMIT 50
        `);
      }

      // All history for active company
      return await db.execute<{
        id: string;
        fromTier: string | null;
        toTier: string | null;
        reason: string | null;
        monthlyRevenueSnapshot: string | null;
        createdAt: string;
        retailerName: string;
      }>(sql`
        SELECT tc.id, tc.from_tier AS "fromTier", tc.to_tier AS "toTier",
               tc.reason, tc.monthly_revenue_snapshot AS "monthlyRevenueSnapshot",
               tc."createdAt"::text, r.name AS "retailerName"
        FROM tier_changes tc
        JOIN retailers r ON r.id = tc."retailerId"
        WHERE r."companyId" = ${ctx.activeCompanyId}
        ORDER BY tc."createdAt" DESC
        LIMIT 100
      `);
    }),

  // ============= SIMULATION LOG =============

  getSimulationLog: adminProcedure
    .input(z.object({ runDate: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Get latest run date if not specified
      let targetDate = input.runDate;
      if (!targetDate) {
        const [latest] = await db.execute<{ runDate: string }>(sql`
          SELECT run_date AS "runDate"
          FROM tier_simulation_log tsl
          JOIN retailers r ON r.id = tsl."retailerId"
          WHERE r."companyId" = ${ctx.activeCompanyId}
          ORDER BY run_date DESC
          LIMIT 1
        `);
        targetDate = latest?.runDate;
      }

      if (!targetDate) return { runDate: null, entries: [] };

      const entries = await db.execute<{
        id: string;
        retailerName: string;
        currentTier: string | null;
        wouldChangeTo: string | null;
        action: string | null;
        monthlyRevenueSnapshot: string | null;
        consecutiveMonthsBelow: number | null;
        reason: string | null;
      }>(sql`
        SELECT tsl.id, r.name AS "retailerName",
               tsl.current_tier AS "currentTier",
               tsl.would_change_to AS "wouldChangeTo",
               tsl.action,
               tsl.monthly_revenue_snapshot AS "monthlyRevenueSnapshot",
               tsl.consecutive_months_below AS "consecutiveMonthsBelow",
               tsl.reason
        FROM tier_simulation_log tsl
        JOIN retailers r ON r.id = tsl."retailerId"
        WHERE tsl.run_date = ${targetDate}
          AND r."companyId" = ${ctx.activeCompanyId}
        ORDER BY tsl.action, r.name
      `);

      return { runDate: targetDate, entries };
    }),

  // ============= DAILY EVALUATION JOB =============

  runEvaluation: adminProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

    // Get engine mode
    const [modeRow] = await db
      .select()
      .from(tierEngineConfig)
      .where(eq(tierEngineConfig.key, "tier_engine_mode"));
    const mode = (modeRow?.value ?? "observation") as "observation" | "active";

    // Get tier rules
    const rules = await db.select().from(tierRules).where(eq(tierRules.isActive, true));
    const rulesMap = new Map(rules.map((r) => [r.tierName, r]));

    // Get all retailers with tier info (exclude Special and cost_markup)
    const retailerRows = await db.execute<{
      id: string;
      name: string;
      tierName: string | null;
      pricingPackageId: string | null;
      tierFrozen: boolean;
      consecutiveMonthsBelow: number;
      companyId: string;
      pricingModel: string;
    }>(sql`
      SELECT r.id, r.name, pp.name AS "tierName", r."pricingPackageId",
             r.tier_frozen AS "tierFrozen",
             r.consecutive_months_below AS "consecutiveMonthsBelow",
             r."companyId", r."pricingModel"
      FROM retailers r
      LEFT JOIN "pricingPackages" pp ON pp.id = r."pricingPackageId"
      WHERE r."companyId" = ${ctx.activeCompanyId}
    `);

    const now = new Date();
    const today = now.toISOString().split("T")[0];

    // Previous month (the one we're evaluating for downgrade)
    const evalYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const evalMonth = now.getMonth() === 0 ? 12 : now.getMonth(); // previous month

    // Current month (for promotion check and at_risk)
    const currYear = now.getFullYear();
    const currMonth = now.getMonth() + 1;

    // Get revenue for previous closed month
    const prevMonthStart = `${evalYear}-${String(evalMonth).padStart(2, "0")}-01`;
    const prevMonthEnd = evalMonth === 12
      ? `${evalYear + 1}-01-01`
      : `${evalYear}-${String(evalMonth + 1).padStart(2, "0")}-01`;

    const prevRevenueRows = await db.execute<{ retailerId: string; revenue: string }>(sql`
      SELECT o."retailerId", COALESCE(SUM(o."subtotalNet"), 0)::text AS revenue
      FROM orders o
      WHERE o."paymentStatus" = 'paid'
        AND o.status != 'cancelled'
        AND o."companyId" = ${ctx.activeCompanyId}
        AND o."createdAt" >= ${prevMonthStart}::timestamptz
        AND o."createdAt" < ${prevMonthEnd}::timestamptz
        AND o."retailerId" IS NOT NULL
      GROUP BY o."retailerId"
    `);
    const prevRevenueMap = new Map(prevRevenueRows.map((r) => [r.retailerId, parseFloat(r.revenue)]));

    // Get revenue for current month (for promotion + at_risk)
    const currMonthStart = `${currYear}-${String(currMonth).padStart(2, "0")}-01`;
    const currMonthEnd = currMonth === 12
      ? `${currYear + 1}-01-01`
      : `${currYear}-${String(currMonth + 1).padStart(2, "0")}-01`;

    const currRevenueRows = await db.execute<{ retailerId: string; revenue: string }>(sql`
      SELECT o."retailerId", COALESCE(SUM(o."subtotalNet"), 0)::text AS revenue
      FROM orders o
      WHERE o."paymentStatus" = 'paid'
        AND o.status != 'cancelled'
        AND o."companyId" = ${ctx.activeCompanyId}
        AND o."createdAt" >= ${currMonthStart}::timestamptz
        AND o."createdAt" < ${currMonthEnd}::timestamptz
        AND o."retailerId" IS NOT NULL
      GROUP BY o."retailerId"
    `);
    const currRevenueMap = new Map(currRevenueRows.map((r) => [r.retailerId, parseFloat(r.revenue)]));

    // Check idempotency: if already evaluated today, skip
    const [alreadyRun] = await db.execute<{ cnt: number }>(sql`
      SELECT COUNT(*)::int AS cnt FROM tier_simulation_log
      WHERE run_date = ${today}
        AND "retailerId" IN (
          SELECT id FROM retailers WHERE "companyId" = ${ctx.activeCompanyId}
        )
    `);
    if (alreadyRun && alreadyRun.cnt > 0) {
      return { message: "Valutazione già eseguita oggi", mode, skipped: true };
    }

    // Get pricing packages for tier lookup
    const pkgs = await db.select().from(pricingPackages);
    const pkgByName = new Map(pkgs.map((p) => [p.name, p]));

    const results: Array<{
      retailerName: string;
      action: string;
      from?: string;
      to?: string;
    }> = [];

    for (const retailer of retailerRows) {
      const tierName = retailer.tierName;

      // Skip: no tier assigned, Special tier, frozen, or cost_markup model
      if (!tierName || tierName === "Special" || retailer.tierFrozen || retailer.pricingModel === "cost_markup") {
        // Log in simulation as no_change
        if (mode === "observation") {
          await db.insert(tierSimulationLog).values({
            runDate: today,
            retailerId: retailer.id,
            currentTier: tierName,
            wouldChangeTo: null,
            action: "no_change",
            monthlyRevenueSnapshot: (currRevenueMap.get(retailer.id) ?? 0).toFixed(2),
            consecutiveMonthsBelow: retailer.consecutiveMonthsBelow,
            reason: retailer.tierFrozen
              ? "Frozen"
              : tierName === "Special"
                ? "Tier Special escluso"
                : retailer.pricingModel === "cost_markup"
                  ? "Modello cost_markup escluso"
                  : "Nessun tier assegnato",
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

      const prevRevenue = prevRevenueMap.get(retailer.id) ?? 0;
      const currRevenue = currRevenueMap.get(retailer.id) ?? 0;
      const threshold = parseFloat(rule.monthlyMaintenanceThreshold);

      // --- Consolidate previous month revenue ---
      await db.execute(sql`
        INSERT INTO retailer_monthly_revenue ("retailerId", year, month, revenue_net, tier_at_time, threshold_at_time, met_threshold)
        VALUES (${retailer.id}::uuid, ${evalYear}, ${evalMonth}, ${prevRevenue.toFixed(2)}::numeric,
                ${tierName}, ${threshold.toFixed(2)}::numeric, ${prevRevenue >= threshold})
        ON CONFLICT ("retailerId", year, month) DO UPDATE SET
          revenue_net = EXCLUDED.revenue_net,
          tier_at_time = EXCLUDED.tier_at_time,
          threshold_at_time = EXCLUDED.threshold_at_time,
          met_threshold = EXCLUDED.met_threshold
      `);

      // --- Calculate consecutive months below threshold ---
      // Count consecutive closed months below threshold (looking backwards from evalMonth)
      const historyRows = await db.execute<{ met: boolean }>(sql`
        SELECT met_threshold AS met
        FROM retailer_monthly_revenue
        WHERE "retailerId" = ${retailer.id}::uuid
        ORDER BY year DESC, month DESC
        LIMIT ${rule.consecutiveMonthsForDowngrade}
      `);

      let consecutiveBelow = 0;
      for (const row of historyRows) {
        if (!row.met) {
          consecutiveBelow++;
        } else {
          break;
        }
      }

      // --- Determine action ---
      let action = "no_change";
      let wouldChangeTo: string | null = null;
      let reason = "";

      // Check PROMOTION first (current month revenue)
      const tierAbove = getTierAbove(tierName);
      if (tierAbove) {
        const aboveRule = rulesMap.get(tierAbove);
        if (aboveRule) {
          const promotionThreshold = parseFloat(aboveRule.promotionThreshold ?? aboveRule.monthlyMaintenanceThreshold);
          if (currRevenue >= promotionThreshold) {
            action = mode === "observation" ? "would_promote" : "auto_promotion";
            wouldChangeTo = tierAbove;
            reason = `Fatturato mese corrente €${currRevenue.toFixed(2)} >= soglia promozione €${promotionThreshold.toFixed(2)} per ${tierAbove}`;
          }
        }
      }

      // Check DOWNGRADE (only if no promotion)
      if (action === "no_change" && consecutiveBelow >= rule.consecutiveMonthsForDowngrade) {
        const tierBelow = getTierBelow(tierName);
        if (tierBelow) {
          action = mode === "observation" ? "would_downgrade" : "auto_downgrade";
          wouldChangeTo = tierBelow;
          reason = `${consecutiveBelow} mesi consecutivi sotto soglia €${threshold.toFixed(2)} (fatturato ultimo mese: €${prevRevenue.toFixed(2)})`;
        }
      }

      // Check AT_RISK (3rd consecutive month below, not yet at downgrade threshold)
      const isAtRisk = consecutiveBelow >= rule.consecutiveMonthsForDowngrade - 1 && action === "no_change";
      if (isAtRisk) {
        action = mode === "observation" ? "would_flag_risk" : "would_flag_risk";
        reason = `${consecutiveBelow} mesi consecutivi sotto soglia, a rischio declassamento`;
      }

      // --- Apply or simulate ---
      if (mode === "active") {
        // Apply real changes
        if (wouldChangeTo && (action === "auto_downgrade" || action === "auto_promotion")) {
          const newPkg = pkgByName.get(wouldChangeTo);
          if (newPkg) {
            await db
              .update(retailers)
              .set({
                pricingPackageId: newPkg.id,
                consecutiveMonthsBelow: 0,
                atRisk: false,
                lastTierEvaluation: today,
                updatedAt: new Date(),
              })
              .where(eq(retailers.id, retailer.id));

            await db.insert(tierChanges).values({
              retailerId: retailer.id,
              fromTier: tierName,
              toTier: wouldChangeTo,
              reason: action,
              monthlyRevenueSnapshot: (action === "auto_promotion" ? currRevenue : prevRevenue).toFixed(2),
            });
          }
        } else {
          // Update consecutive months + at_risk flag
          await db
            .update(retailers)
            .set({
              consecutiveMonthsBelow: consecutiveBelow,
              atRisk: isAtRisk,
              lastTierEvaluation: today,
              updatedAt: new Date(),
            })
            .where(eq(retailers.id, retailer.id));
        }
      } else {
        // Observation mode: write to simulation log, do NOT touch retailers
        await db.insert(tierSimulationLog).values({
          runDate: today,
          retailerId: retailer.id,
          currentTier: tierName,
          wouldChangeTo,
          action,
          monthlyRevenueSnapshot: currRevenue.toFixed(2),
          consecutiveMonthsBelow: consecutiveBelow,
          reason: reason || "Nessun cambio previsto",
        });

        // Still update consecutive_months_below and lastTierEvaluation for tracking
        // but NOT at_risk and NOT pricingPackageId
        await db
          .update(retailers)
          .set({
            consecutiveMonthsBelow: consecutiveBelow,
            lastTierEvaluation: today,
            updatedAt: new Date(),
          })
          .where(eq(retailers.id, retailer.id));
      }

      results.push({
        retailerName: retailer.name,
        action,
        ...(wouldChangeTo && { from: tierName, to: wouldChangeTo }),
      });
    }

    return { mode, date: today, results, skipped: false };
  }),
});
