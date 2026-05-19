/**
 * M9 — Reports Router
 *
 * Advanced reporting procedures:
 * - reports.warehouse.getOverview
 * - reports.warehouse.getMovementsTable
 * - reports.warehouse.getExpiringBatches
 * - reports.sales.getOverview
 * - reports.sales.getOrdersTable
 * - reports.sales.getRetailerBreakdown
 * - reports.marketplace.getOverview
 * - reports.marketplace.getOrdersTable
 * - reports.export.toCsv
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { staffProcedure, router } from "./_core/trpc";
import { getDb } from "./db";

// ============= HELPERS =============

function getDefaultDateRange(): { dateFrom: Date; dateTo: Date } {
  const now = new Date();
  const dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const dateTo = now;
  return { dateFrom, dateTo };
}

function getPreviousPeriod(dateFrom: Date, dateTo: Date): { dateFrom: Date; dateTo: Date } {
  const durationMs = dateTo.getTime() - dateFrom.getTime();
  const prevTo = new Date(dateFrom.getTime() - 1); // day before current period start
  const prevFrom = new Date(prevTo.getTime() - durationMs);
  return { dateFrom: prevFrom, dateTo: prevTo };
}

const dateRangeInput = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

function parseDateRange(input: { dateFrom?: string; dateTo?: string }) {
  if (input.dateFrom && input.dateTo) {
    return { dateFrom: new Date(input.dateFrom), dateTo: new Date(input.dateTo) };
  }
  return getDefaultDateRange();
}

// ============= WAREHOUSE REPORTS =============

const warehouseRouter = router({
  getOverview: staffProcedure
    .input(dateRangeInput)
    .query(async ({ input }) => {
      console.log("[reports.warehouse.getOverview]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);
      const prev = getPreviousPeriod(dateFrom, dateTo);

      // Snapshot: current stock values
      const [snapshot] = await db.execute<{
        totalValueAtCost: number;
        totalValueAtListPrice: number;
        totalUnits: number;
        uniqueSkus: number;
        totalBatches: number;
      }>(sql`
        SELECT
          COALESCE(SUM(ibb."quantity" * p."costPrice"), 0)::float AS "totalValueAtCost",
          COALESCE(SUM(ibb."quantity" * NULLIF(p."unitPrice", '')::numeric / COALESCE(NULLIF(p."piecesPerUnit", 0), 1)), 0)::float AS "totalValueAtListPrice",
          COALESCE(SUM(ibb."quantity"), 0)::int AS "totalUnits",
          COUNT(DISTINCT p."id")::int AS "uniqueSkus",
          COUNT(DISTINCT pb."id")::int AS "totalBatches"
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId"
        WHERE l."type" = 'central_warehouse' AND ibb."quantity" > 0
      `);

      const snapshotData = (snapshot as any) ?? { totalValueAtCost: 0, totalValueAtListPrice: 0, totalUnits: 0, uniqueSkus: 0, totalBatches: 0 };
      const marginPercent = snapshotData.totalValueAtListPrice > 0
        ? ((snapshotData.totalValueAtListPrice - snapshotData.totalValueAtCost) / snapshotData.totalValueAtListPrice * 100)
        : 0;

      // Expiring batches
      const expiringRows = await db.execute<{ bucket: string; count: number; value: number }>(sql`
        SELECT
          CASE
            WHEN pb."expirationDate"::date - CURRENT_DATE <= 30 THEN 'under30'
            WHEN pb."expirationDate"::date - CURRENT_DATE <= 60 THEN 'under60'
            WHEN pb."expirationDate"::date - CURRENT_DATE <= 90 THEN 'under90'
          END AS "bucket",
          COUNT(DISTINCT pb."id")::int AS "count",
          COALESCE(SUM(ibb."quantity" * p."costPrice"), 0)::float AS "value"
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId"
        WHERE l."type" = 'central_warehouse'
          AND ibb."quantity" > 0
          AND pb."expirationDate" IS NOT NULL
          AND pb."expirationDate"::date - CURRENT_DATE <= 90
          AND pb."expirationDate"::date >= CURRENT_DATE
        GROUP BY "bucket"
      `);

      const expiringArr = expiringRows as unknown as Array<{ bucket: string; count: number; value: number }>;
      const expiring = {
        under30days: expiringArr.find(r => r.bucket === 'under30') ?? { count: 0, value: 0 },
        under60days: expiringArr.find(r => r.bucket === 'under60') ?? { count: 0, value: 0 },
        under90days: expiringArr.find(r => r.bucket === 'under90') ?? { count: 0, value: 0 },
      };

      // Period movements (current)
      const [periodCurrent] = await db.execute<{ unitsIn: number; unitsOut: number; valueIn: number; valueOut: number }>(sql`
        SELECT
          COALESCE(SUM(CASE WHEN sm."type" IN ('IN', 'RECEIPT_FROM_PRODUCER', 'ADJUSTMENT', 'MARKETPLACE_RETURN') THEN sm."quantity" ELSE 0 END), 0)::int AS "unitsIn",
          COALESCE(SUM(CASE WHEN sm."type" IN ('OUT', 'TRANSFER', 'EXPIRY_WRITE_OFF', 'SHOPIFY_EXIT', 'AMAZON_EXIT') THEN sm."quantity" ELSE 0 END), 0)::int AS "unitsOut",
          COALESCE(SUM(CASE WHEN sm."type" IN ('IN', 'RECEIPT_FROM_PRODUCER', 'ADJUSTMENT', 'MARKETPLACE_RETURN') THEN sm."quantity" * p."costPrice" ELSE 0 END), 0)::float AS "valueIn",
          COALESCE(SUM(CASE WHEN sm."type" IN ('OUT', 'TRANSFER', 'EXPIRY_WRITE_OFF', 'SHOPIFY_EXIT', 'AMAZON_EXIT') THEN sm."quantity" * p."costPrice" ELSE 0 END), 0)::float AS "valueOut"
        FROM "stockMovements" sm
        INNER JOIN "products" p ON p."id" = sm."productId"
        WHERE sm."timestamp" >= ${dateFrom.toISOString()}::timestamptz
          AND sm."timestamp" <= ${dateTo.toISOString()}::timestamptz
      `);

      // Period movements (previous)
      const [periodPrev] = await db.execute<{ unitsIn: number; unitsOut: number; valueIn: number; valueOut: number }>(sql`
        SELECT
          COALESCE(SUM(CASE WHEN sm."type" IN ('IN', 'RECEIPT_FROM_PRODUCER', 'ADJUSTMENT', 'MARKETPLACE_RETURN') THEN sm."quantity" ELSE 0 END), 0)::int AS "unitsIn",
          COALESCE(SUM(CASE WHEN sm."type" IN ('OUT', 'TRANSFER', 'EXPIRY_WRITE_OFF', 'SHOPIFY_EXIT', 'AMAZON_EXIT') THEN sm."quantity" ELSE 0 END), 0)::int AS "unitsOut",
          COALESCE(SUM(CASE WHEN sm."type" IN ('IN', 'RECEIPT_FROM_PRODUCER', 'ADJUSTMENT', 'MARKETPLACE_RETURN') THEN sm."quantity" * p."costPrice" ELSE 0 END), 0)::float AS "valueIn",
          COALESCE(SUM(CASE WHEN sm."type" IN ('OUT', 'TRANSFER', 'EXPIRY_WRITE_OFF', 'SHOPIFY_EXIT', 'AMAZON_EXIT') THEN sm."quantity" * p."costPrice" ELSE 0 END), 0)::float AS "valueOut"
        FROM "stockMovements" sm
        INNER JOIN "products" p ON p."id" = sm."productId"
        WHERE sm."timestamp" >= ${prev.dateFrom.toISOString()}::timestamptz
          AND sm."timestamp" <= ${prev.dateTo.toISOString()}::timestamptz
      `);

      // Time series
      const timeSeriesRows = await db.execute<{ date: string; inQty: number; outQty: number }>(sql`
        SELECT
          DATE(sm."timestamp") AS "date",
          COALESCE(SUM(CASE WHEN sm."type" IN ('IN', 'RECEIPT_FROM_PRODUCER', 'ADJUSTMENT', 'MARKETPLACE_RETURN') THEN sm."quantity" ELSE 0 END), 0)::int AS "inQty",
          COALESCE(SUM(CASE WHEN sm."type" IN ('OUT', 'TRANSFER', 'EXPIRY_WRITE_OFF', 'SHOPIFY_EXIT', 'AMAZON_EXIT') THEN sm."quantity" ELSE 0 END), 0)::int AS "outQty"
        FROM "stockMovements" sm
        WHERE sm."timestamp" >= ${dateFrom.toISOString()}::timestamptz
          AND sm."timestamp" <= ${dateTo.toISOString()}::timestamptz
        GROUP BY DATE(sm."timestamp")
        ORDER BY DATE(sm."timestamp")
      `);

      // Top products by value
      const topProductsRows = await db.execute<{ productId: string; name: string; value: number; units: number }>(sql`
        SELECT
          p."id" AS "productId",
          p."name" AS "name",
          (ibb."quantity" * p."costPrice")::float AS "value",
          ibb."quantity"::int AS "units"
        FROM (
          SELECT pb."productId", SUM(ibb2."quantity") AS "quantity"
          FROM "inventoryByBatch" ibb2
          INNER JOIN "productBatches" pb ON pb."id" = ibb2."batchId"
          INNER JOIN "locations" l ON l."id" = ibb2."locationId"
          WHERE l."type" = 'central_warehouse' AND ibb2."quantity" > 0
          GROUP BY pb."productId"
        ) ibb
        INNER JOIN "products" p ON p."id" = ibb."productId"
        ORDER BY "value" DESC
        LIMIT 10
      `);

      // Expiration distribution
      const expirationDistRows = await db.execute<{ bucket: string; count: number; value: number }>(sql`
        SELECT
          CASE
            WHEN pb."expirationDate"::date - CURRENT_DATE <= 30 THEN '< 30 giorni'
            WHEN pb."expirationDate"::date - CURRENT_DATE <= 60 THEN '30-60 giorni'
            WHEN pb."expirationDate"::date - CURRENT_DATE <= 90 THEN '60-90 giorni'
            ELSE '> 90 giorni'
          END AS "bucket",
          COUNT(DISTINCT pb."id")::int AS "count",
          COALESCE(SUM(ibb."quantity" * p."costPrice"), 0)::float AS "value"
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId"
        WHERE l."type" = 'central_warehouse'
          AND ibb."quantity" > 0
          AND pb."expirationDate" IS NOT NULL
          AND pb."expirationDate"::date >= CURRENT_DATE
        GROUP BY "bucket"
        ORDER BY MIN(pb."expirationDate"::date - CURRENT_DATE)
      `);

      return {
        snapshot: {
          ...snapshotData,
          marginPercent: Math.round(marginPercent * 100) / 100,
        },
        expiring,
        period: {
          ...(periodCurrent as any ?? { unitsIn: 0, unitsOut: 0, valueIn: 0, valueOut: 0 }),
          previousPeriod: periodPrev as any ?? { unitsIn: 0, unitsOut: 0, valueIn: 0, valueOut: 0 },
        },
        movementsTimeSeries: (timeSeriesRows as unknown as Array<{ date: string; inQty: number; outQty: number }>).map(r => ({
          date: r.date,
          in: r.inQty,
          out: r.outQty,
        })),
        topProductsByValue: topProductsRows as unknown as Array<{ productId: string; name: string; value: number; units: number }>,
        expirationDistribution: expirationDistRows as unknown as Array<{ bucket: string; count: number; value: number }>,
      };
    }),

  getMovementsTable: staffProcedure
    .input(z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      productId: z.string().uuid().optional(),
      type: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      console.log("[reports.warehouse.getMovementsTable]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);

      const conditions: string[] = [
        `sm."timestamp" >= '${dateFrom.toISOString()}'::timestamptz`,
        `sm."timestamp" <= '${dateTo.toISOString()}'::timestamptz`,
      ];
      if (input.productId) conditions.push(`sm."productId" = '${input.productId}'::uuid`);
      if (input.type) conditions.push(`sm."type" = '${input.type}'`);

      const whereClause = conditions.join(" AND ");

      const countResult = await db.execute<{ total: number }>(
        sql.raw(`SELECT COUNT(*)::int AS "total" FROM "stockMovements" sm WHERE ${whereClause}`)
      );
      const total = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

      const rows = await db.execute<any>(
        sql.raw(`
          SELECT
            sm."id",
            sm."timestamp",
            sm."type",
            p."name" AS "productName",
            p."sku" AS "productSku",
            pb."batchNumber",
            sm."quantity",
            fl."name" AS "fromLocation",
            tl."name" AS "toLocation",
            sm."notes",
            sm."sourceDocument"
          FROM "stockMovements" sm
          INNER JOIN "products" p ON p."id" = sm."productId"
          LEFT JOIN "productBatches" pb ON pb."id" = sm."batchId"
          LEFT JOIN "locations" fl ON fl."id" = sm."fromLocationId"
          LEFT JOIN "locations" tl ON tl."id" = sm."toLocationId"
          WHERE ${whereClause}
          ORDER BY sm."timestamp" DESC
          LIMIT ${input.limit} OFFSET ${input.offset}
        `)
      );

      return {
        items: rows as unknown as Array<{
          id: string; timestamp: string; type: string;
          productName: string; productSku: string; batchNumber: string | null;
          quantity: number; fromLocation: string | null; toLocation: string | null;
          notes: string | null; sourceDocument: string | null;
        }>,
        total,
      };
    }),

  getExpiringBatches: staffProcedure
    .input(z.object({
      daysThreshold: z.number().int().min(1).default(90),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      console.log("[reports.warehouse.getExpiringBatches]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const rows = await db.execute<any>(sql`
        SELECT
          p."id" AS "productId",
          p."name" AS "productName",
          pb."batchNumber",
          pb."expirationDate"::text AS "expirationDate",
          (pb."expirationDate"::date - CURRENT_DATE)::int AS "daysToExpire",
          ibb."quantity"::int AS "quantity",
          (ibb."quantity" * p."costPrice")::float AS "valueAtCost",
          l."name" AS "locationName"
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId"
        WHERE l."type" = 'central_warehouse'
          AND ibb."quantity" > 0
          AND pb."expirationDate" IS NOT NULL
          AND pb."expirationDate"::date >= CURRENT_DATE
          AND (pb."expirationDate"::date - CURRENT_DATE) <= ${input.daysThreshold}
        ORDER BY pb."expirationDate" ASC
        LIMIT ${input.limit}
      `);

      return rows as unknown as Array<{
        productId: string; productName: string; batchNumber: string;
        expirationDate: string; daysToExpire: number; quantity: number;
        valueAtCost: number; locationName: string;
      }>;
    }),
});

// ============= SALES REPORTS =============

const salesRouter = router({
  getOverview: staffProcedure
    .input(dateRangeInput)
    .query(async ({ input }) => {
      console.log("[reports.sales.getOverview]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);
      const prev = getPreviousPeriod(dateFrom, dateTo);

      // Revenue current period
      const [revCurrent] = await db.execute<{ grossTotal: number; netTotal: number; vatTotal: number; orderCount: number; avgOrderValue: number }>(sql`
        SELECT
          COALESCE(SUM(o."totalGross"::float), 0) AS "grossTotal",
          COALESCE(SUM(o."subtotalNet"::float), 0) AS "netTotal",
          COALESCE(SUM(o."vatAmount"::float), 0) AS "vatTotal",
          COUNT(*)::int AS "orderCount",
          CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(o."totalGross"::float), 0) / COUNT(*) ELSE 0 END AS "avgOrderValue"
        FROM "orders" o
        WHERE o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
      `);

      // Revenue previous period
      const [revPrev] = await db.execute<{ grossTotal: number; netTotal: number; vatTotal: number; orderCount: number; avgOrderValue: number }>(sql`
        SELECT
          COALESCE(SUM(o."totalGross"::float), 0) AS "grossTotal",
          COALESCE(SUM(o."subtotalNet"::float), 0) AS "netTotal",
          COALESCE(SUM(o."vatAmount"::float), 0) AS "vatTotal",
          COUNT(*)::int AS "orderCount",
          CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(o."totalGross"::float), 0) / COUNT(*) ELSE 0 END AS "avgOrderValue"
        FROM "orders" o
        WHERE o."createdAt" >= ${prev.dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${prev.dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
      `);

      // Orders by type
      const [orderTypes] = await db.execute<{ retailerOrders: number; eventOrders: number }>(sql`
        SELECT
          COUNT(CASE WHEN o."eventType" IS NULL THEN 1 END)::int AS "retailerOrders",
          COUNT(CASE WHEN o."eventType" IS NOT NULL THEN 1 END)::int AS "eventOrders"
        FROM "orders" o
        WHERE o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
      `);

      // Status distribution
      const statusRows = await db.execute<{ status: string; count: number; value: number }>(sql`
        SELECT
          o."status",
          COUNT(*)::int AS "count",
          COALESCE(SUM(o."totalGross"::float), 0) AS "value"
        FROM "orders" o
        WHERE o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
        GROUP BY o."status"
        ORDER BY "count" DESC
      `);

      // Top retailers
      const topRetailers = await db.execute<{ retailerId: string; name: string; revenue: number; orderCount: number }>(sql`
        SELECT
          r."id" AS "retailerId",
          r."name" AS "name",
          COALESCE(SUM(o."totalGross"::float), 0) AS "revenue",
          COUNT(o."id")::int AS "orderCount"
        FROM "orders" o
        INNER JOIN "retailers" r ON r."id" = o."retailerId"
        WHERE o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
          AND o."retailerId" IS NOT NULL
        GROUP BY r."id", r."name"
        ORDER BY "revenue" DESC
        LIMIT 10
      `);

      // Revenue time series
      const revenueTs = await db.execute<{ date: string; gross: number; net: number; orders: number }>(sql`
        SELECT
          DATE(o."createdAt") AS "date",
          COALESCE(SUM(o."totalGross"::float), 0) AS "gross",
          COALESCE(SUM(o."subtotalNet"::float), 0) AS "net",
          COUNT(*)::int AS "orders"
        FROM "orders" o
        WHERE o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
        GROUP BY DATE(o."createdAt")
        ORDER BY DATE(o."createdAt")
      `);

      // Top products by revenue
      const topByRevenue = await db.execute<{ productId: string; name: string; revenue: number; units: number }>(sql`
        SELECT
          oi."productId" AS "productId",
          oi."productName" AS "name",
          COALESCE(SUM(oi."lineTotalNet"::float), 0) AS "revenue",
          COALESCE(SUM(oi."quantity"), 0)::int AS "units"
        FROM "orderItems" oi
        INNER JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
        GROUP BY oi."productId", oi."productName"
        ORDER BY "revenue" DESC
        LIMIT 10
      `);

      // Top products by units
      const topByUnits = await db.execute<{ productId: string; name: string; units: number; revenue: number }>(sql`
        SELECT
          oi."productId" AS "productId",
          oi."productName" AS "name",
          COALESCE(SUM(oi."quantity"), 0)::int AS "units",
          COALESCE(SUM(oi."lineTotalNet"::float), 0) AS "revenue"
        FROM "orderItems" oi
        INNER JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
        GROUP BY oi."productId", oi."productName"
        ORDER BY "units" DESC
        LIMIT 10
      `);

      const currentRev = revCurrent as any ?? { grossTotal: 0, netTotal: 0, vatTotal: 0, orderCount: 0, avgOrderValue: 0 };
      const prevRev = revPrev as any ?? { grossTotal: 0, netTotal: 0, vatTotal: 0, orderCount: 0, avgOrderValue: 0 };
      const types = orderTypes as any ?? { retailerOrders: 0, eventOrders: 0 };

      return {
        revenue: {
          grossTotal: currentRev.grossTotal,
          netTotal: currentRev.netTotal,
          vatTotal: currentRev.vatTotal,
          previousPeriod: {
            grossTotal: prevRev.grossTotal,
            netTotal: prevRev.netTotal,
            vatTotal: prevRev.vatTotal,
          },
        },
        orders: {
          total: currentRev.orderCount,
          retailerOrders: types.retailerOrders,
          eventOrders: types.eventOrders,
          avgOrderValue: currentRev.avgOrderValue,
          previousPeriod: {
            total: prevRev.orderCount,
            avgOrderValue: prevRev.avgOrderValue,
          },
        },
        topRetailers: topRetailers as unknown as Array<{ retailerId: string; name: string; revenue: number; orderCount: number }>,
        revenueTimeSeries: revenueTs as unknown as Array<{ date: string; gross: number; net: number; orders: number }>,
        topProductsByRevenue: topByRevenue as unknown as Array<{ productId: string; name: string; revenue: number; units: number }>,
        topProductsByUnits: topByUnits as unknown as Array<{ productId: string; name: string; units: number; revenue: number }>,
        statusDistribution: statusRows as unknown as Array<{ status: string; count: number; value: number }>,
      };
    }),

  getOrdersTable: staffProcedure
    .input(z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      status: z.string().optional(),
      retailerId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      console.log("[reports.sales.getOrdersTable]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);

      const conditions: string[] = [
        `o."createdAt" >= '${dateFrom.toISOString()}'::timestamptz`,
        `o."createdAt" <= '${dateTo.toISOString()}'::timestamptz`,
      ];
      if (input.status) conditions.push(`o."status" = '${input.status}'`);
      if (input.retailerId) conditions.push(`o."retailerId" = '${input.retailerId}'::uuid`);

      const whereClause = conditions.join(" AND ");

      const countResult = await db.execute<{ total: number }>(
        sql.raw(`SELECT COUNT(*)::int AS "total" FROM "orders" o WHERE ${whereClause}`)
      );
      const total = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

      const rows = await db.execute<any>(
        sql.raw(`
          SELECT
            o."id",
            o."orderNumber",
            o."status",
            r."name" AS "retailerName",
            o."subtotalNet"::float AS "subtotalNet",
            o."totalGross"::float AS "totalGross",
            o."createdAt",
            o."eventType",
            o."eventName"
          FROM "orders" o
          LEFT JOIN "retailers" r ON r."id" = o."retailerId"
          WHERE ${whereClause}
          ORDER BY o."createdAt" DESC
          LIMIT ${input.limit} OFFSET ${input.offset}
        `)
      );

      return { items: rows as unknown as any[], total };
    }),

  getRetailerBreakdown: staffProcedure
    .input(z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ input }) => {
      console.log("[reports.sales.getRetailerBreakdown]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);

      const rows = await db.execute<any>(sql`
        SELECT
          r."id" AS "retailerId",
          r."name" AS "name",
          COALESCE(SUM(o."totalGross"::float), 0) AS "totalRevenue",
          COUNT(o."id")::int AS "orderCount",
          CASE WHEN COUNT(o."id") > 0 THEN COALESCE(SUM(o."totalGross"::float), 0) / COUNT(o."id") ELSE 0 END AS "avgOrderValue",
          MAX(o."createdAt")::text AS "lastOrderDate"
        FROM "retailers" r
        LEFT JOIN "orders" o ON o."retailerId" = r."id"
          AND o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
          AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
          AND o."status" NOT IN ('cancelled')
        GROUP BY r."id", r."name"
        HAVING COUNT(o."id") > 0
        ORDER BY "totalRevenue" DESC
        LIMIT ${input.limit}
      `);

      return rows as unknown as Array<{
        retailerId: string; name: string; totalRevenue: number;
        orderCount: number; avgOrderValue: number; lastOrderDate: string;
      }>;
    }),
});

// ============= MARKETPLACE REPORTS =============

const marketplaceRouter = router({
  getOverview: staffProcedure
    .input(z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      channel: z.enum(["shopify", "amazon"]).optional(),
    }))
    .query(async ({ input }) => {
      console.log("[reports.marketplace.getOverview]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);
      const prev = getPreviousPeriod(dateFrom, dateTo);

      const channelFilter = input.channel ? `AND ss."channel" = '${input.channel}'` : "";

      // Summary current
      const [sumCurrent] = await db.execute<{ ordersCount: number; totalGross: number; avgOrderValue: number; unitsSold: number }>(
        sql.raw(`
          SELECT
            COUNT(DISTINCT mo."id")::int AS "ordersCount",
            COALESCE(SUM(mo."totalGross"::float), 0) AS "totalGross",
            CASE WHEN COUNT(DISTINCT mo."id") > 0 THEN COALESCE(SUM(mo."totalGross"::float), 0) / COUNT(DISTINCT mo."id") ELSE 0 END AS "avgOrderValue",
            COALESCE(SUM(moi."piecesQuantity"), 0)::int AS "unitsSold"
          FROM "marketplace_orders" mo
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          LEFT JOIN "marketplace_order_items" moi ON moi."marketplaceOrderId" = mo."id"
          WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            ${channelFilter}
        `)
      );

      // Summary previous
      const [sumPrev] = await db.execute<{ ordersCount: number; totalGross: number; avgOrderValue: number; unitsSold: number }>(
        sql.raw(`
          SELECT
            COUNT(DISTINCT mo."id")::int AS "ordersCount",
            COALESCE(SUM(mo."totalGross"::float), 0) AS "totalGross",
            CASE WHEN COUNT(DISTINCT mo."id") > 0 THEN COALESCE(SUM(mo."totalGross"::float), 0) / COUNT(DISTINCT mo."id") ELSE 0 END AS "avgOrderValue",
            COALESCE(SUM(moi."piecesQuantity"), 0)::int AS "unitsSold"
          FROM "marketplace_orders" mo
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          LEFT JOIN "marketplace_order_items" moi ON moi."marketplaceOrderId" = mo."id"
          WHERE mo."orderDate" >= '${prev.dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${prev.dateTo.toISOString()}'::timestamptz
            ${channelFilter}
        `)
      );

      // By channel
      const byChannel = await db.execute<{ channel: string; orders: number; revenue: number; units: number }>(
        sql.raw(`
          SELECT
            ss."channel",
            COUNT(DISTINCT mo."id")::int AS "orders",
            COALESCE(SUM(mo."totalGross"::float), 0) AS "revenue",
            COALESCE(SUM(moi."piecesQuantity"), 0)::int AS "units"
          FROM "marketplace_orders" mo
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          LEFT JOIN "marketplace_order_items" moi ON moi."marketplaceOrderId" = mo."id"
          WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
          GROUP BY ss."channel"
          ORDER BY "revenue" DESC
        `)
      );

      // Revenue time series
      const revenueTs = await db.execute<{ date: string; channel: string; gross: number; orders: number }>(
        sql.raw(`
          SELECT
            DATE(mo."orderDate") AS "date",
            ss."channel",
            COALESCE(SUM(mo."totalGross"::float), 0) AS "gross",
            COUNT(DISTINCT mo."id")::int AS "orders"
          FROM "marketplace_orders" mo
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            ${channelFilter}
          GROUP BY DATE(mo."orderDate"), ss."channel"
          ORDER BY DATE(mo."orderDate")
        `)
      );

      // Top variants by units
      const topByUnits = await db.execute<any>(
        sql.raw(`
          SELECT
            moi."channelVariantId" AS "variantId",
            moi."channelSku" AS "sku",
            COALESCE(moi."displayName", moi."channelSku") AS "displayName",
            SUM(moi."piecesQuantity")::int AS "units",
            COALESCE(SUM(moi."lineTotal"::float), 0) AS "revenue"
          FROM "marketplace_order_items" moi
          INNER JOIN "marketplace_orders" mo ON mo."id" = moi."marketplaceOrderId"
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            ${channelFilter}
          GROUP BY moi."channelVariantId", moi."channelSku", moi."displayName"
          ORDER BY "units" DESC
          LIMIT 10
        `)
      );

      // Top variants by revenue
      const topByRevenue = await db.execute<any>(
        sql.raw(`
          SELECT
            moi."channelVariantId" AS "variantId",
            moi."channelSku" AS "sku",
            COALESCE(moi."displayName", moi."channelSku") AS "displayName",
            SUM(moi."piecesQuantity")::int AS "units",
            COALESCE(SUM(moi."lineTotal"::float), 0) AS "revenue"
          FROM "marketplace_order_items" moi
          INNER JOIN "marketplace_orders" mo ON mo."id" = moi."marketplaceOrderId"
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            ${channelFilter}
          GROUP BY moi."channelVariantId", moi."channelSku", moi."displayName"
          ORDER BY "revenue" DESC
          LIMIT 10
        `)
      );

      // Retailer vs Marketplace comparison
      const comparison = await db.execute<{ date: string; retailerRevenue: number; marketplaceRevenue: number }>(
        sql.raw(`
          SELECT
            d."date",
            COALESCE(r."revenue", 0) AS "retailerRevenue",
            COALESCE(m."revenue", 0) AS "marketplaceRevenue"
          FROM (
            SELECT DATE(o."createdAt") AS "date" FROM "orders" o
            WHERE o."createdAt" >= '${dateFrom.toISOString()}'::timestamptz
              AND o."createdAt" <= '${dateTo.toISOString()}'::timestamptz
              AND o."status" NOT IN ('cancelled')
            UNION
            SELECT DATE(mo."orderDate") AS "date" FROM "marketplace_orders" mo
            WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
              AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
          ) d
          LEFT JOIN (
            SELECT DATE(o."createdAt") AS "date", SUM(o."totalGross"::float) AS "revenue"
            FROM "orders" o
            WHERE o."createdAt" >= '${dateFrom.toISOString()}'::timestamptz
              AND o."createdAt" <= '${dateTo.toISOString()}'::timestamptz
              AND o."status" NOT IN ('cancelled')
            GROUP BY DATE(o."createdAt")
          ) r ON r."date" = d."date"
          LEFT JOIN (
            SELECT DATE(mo."orderDate") AS "date", SUM(mo."totalGross"::float) AS "revenue"
            FROM "marketplace_orders" mo
            WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
              AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            GROUP BY DATE(mo."orderDate")
          ) m ON m."date" = d."date"
          ORDER BY d."date"
        `)
      );

      const cur = sumCurrent as any ?? { ordersCount: 0, totalGross: 0, avgOrderValue: 0, unitsSold: 0 };
      const prv = sumPrev as any ?? { ordersCount: 0, totalGross: 0, avgOrderValue: 0, unitsSold: 0 };

      return {
        summary: {
          ordersCount: cur.ordersCount,
          totalGross: cur.totalGross,
          avgOrderValue: cur.avgOrderValue,
          unitsSold: cur.unitsSold,
          previousPeriod: {
            ordersCount: prv.ordersCount,
            totalGross: prv.totalGross,
            avgOrderValue: prv.avgOrderValue,
            unitsSold: prv.unitsSold,
          },
        },
        byChannel: byChannel as unknown as Array<{ channel: string; orders: number; revenue: number; units: number }>,
        revenueTimeSeries: revenueTs as unknown as Array<{ date: string; channel: string; gross: number; orders: number }>,
        topVariantsByUnits: topByUnits as unknown as any[],
        topVariantsByRevenue: topByRevenue as unknown as any[],
        retailerVsMarketplace: comparison as unknown as Array<{ date: string; retailerRevenue: number; marketplaceRevenue: number }>,
      };
    }),

  getOrdersTable: staffProcedure
    .input(z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      channel: z.enum(["shopify", "amazon"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      console.log("[reports.marketplace.getOrdersTable]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);

      const channelFilter = input.channel ? `AND ss."channel" = '${input.channel}'` : "";

      const countResult = await db.execute<{ total: number }>(
        sql.raw(`
          SELECT COUNT(*)::int AS "total"
          FROM "marketplace_orders" mo
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            ${channelFilter}
        `)
      );
      const total = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

      const rows = await db.execute<any>(
        sql.raw(`
          SELECT
            mo."id",
            mo."channelOrderNumber",
            mo."customerName",
            mo."orderDate",
            mo."totalGross"::float AS "totalGross",
            mo."shippingCountry",
            ss."channel",
            ss."name" AS "storeName",
            mo."stockProcessingStatus"
          FROM "marketplace_orders" mo
          INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
          WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
            AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            ${channelFilter}
          ORDER BY mo."orderDate" DESC
          LIMIT ${input.limit} OFFSET ${input.offset}
        `)
      );

      return { items: rows as unknown as any[], total };
    }),
});

// ============= EXPORT =============

const exportRouter = router({
  toCsv: staffProcedure
    .input(z.object({
      reportType: z.enum(["warehouse", "sales", "marketplace"]),
      dataset: z.string(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      console.log("[reports.export.toCsv]", input);
      const db = await getDb();
      if (!db) throw new Error("DB non disponibile");

      const { dateFrom, dateTo } = parseDateRange(input);
      let csvContent = "";
      let filename = "";

      if (input.reportType === "warehouse" && input.dataset === "movements") {
        const rows = await db.execute<any>(
          sql.raw(`
            SELECT
              sm."timestamp",
              sm."type",
              p."name" AS "prodotto",
              p."sku",
              pb."batchNumber" AS "lotto",
              sm."quantity" AS "quantita",
              fl."name" AS "da_ubicazione",
              tl."name" AS "a_ubicazione",
              sm."notes" AS "note"
            FROM "stockMovements" sm
            INNER JOIN "products" p ON p."id" = sm."productId"
            LEFT JOIN "productBatches" pb ON pb."id" = sm."batchId"
            LEFT JOIN "locations" fl ON fl."id" = sm."fromLocationId"
            LEFT JOIN "locations" tl ON tl."id" = sm."toLocationId"
            WHERE sm."timestamp" >= '${dateFrom.toISOString()}'::timestamptz
              AND sm."timestamp" <= '${dateTo.toISOString()}'::timestamptz
            ORDER BY sm."timestamp" DESC
          `)
        );
        const data = rows as unknown as any[];
        csvContent = "Data;Tipo;Prodotto;SKU;Lotto;Quantità;Da;A;Note\n";
        for (const r of data) {
          csvContent += `${formatDateCSV(r.timestamp)};${r.type};${escCsv(r.prodotto)};${escCsv(r.sku)};${escCsv(r.lotto ?? "")};${r.quantita};${escCsv(r.da_ubicazione ?? "")};${escCsv(r.a_ubicazione ?? "")};${escCsv(r.note ?? "")}\n`;
        }
        filename = `movimenti_magazzino_${formatFilenameDate(dateFrom)}_${formatFilenameDate(dateTo)}.csv`;
      } else if (input.reportType === "sales" && input.dataset === "orders") {
        const rows = await db.execute<any>(
          sql.raw(`
            SELECT
              o."orderNumber" AS "numero_ordine",
              o."createdAt" AS "data",
              o."status" AS "stato",
              r."name" AS "retailer",
              o."subtotalNet"::float AS "netto",
              o."vatAmount"::float AS "iva",
              o."totalGross"::float AS "lordo"
            FROM "orders" o
            LEFT JOIN "retailers" r ON r."id" = o."retailerId"
            WHERE o."createdAt" >= '${dateFrom.toISOString()}'::timestamptz
              AND o."createdAt" <= '${dateTo.toISOString()}'::timestamptz
            ORDER BY o."createdAt" DESC
          `)
        );
        const data = rows as unknown as any[];
        csvContent = "Numero Ordine;Data;Stato;Retailer;Netto;IVA;Lordo\n";
        for (const r of data) {
          csvContent += `${escCsv(r.numero_ordine)};${formatDateCSV(r.data)};${r.stato};${escCsv(r.retailer ?? "Evento")};${formatNumIT(r.netto)};${formatNumIT(r.iva)};${formatNumIT(r.lordo)}\n`;
        }
        filename = `ordini_${formatFilenameDate(dateFrom)}_${formatFilenameDate(dateTo)}.csv`;
      } else if (input.reportType === "sales" && input.dataset === "topRetailers") {
        const rows = await db.execute<any>(sql`
          SELECT
            r."name" AS "retailer",
            COALESCE(SUM(o."totalGross"::float), 0) AS "fatturato",
            COUNT(o."id")::int AS "ordini",
            CASE WHEN COUNT(o."id") > 0 THEN COALESCE(SUM(o."totalGross"::float), 0) / COUNT(o."id") ELSE 0 END AS "aov"
          FROM "retailers" r
          LEFT JOIN "orders" o ON o."retailerId" = r."id"
            AND o."createdAt" >= ${dateFrom.toISOString()}::timestamptz
            AND o."createdAt" <= ${dateTo.toISOString()}::timestamptz
            AND o."status" NOT IN ('cancelled')
          GROUP BY r."id", r."name"
          HAVING COUNT(o."id") > 0
          ORDER BY "fatturato" DESC
        `);
        const data = rows as unknown as any[];
        csvContent = "Retailer;Fatturato;Ordini;AOV\n";
        for (const r of data) {
          csvContent += `${escCsv(r.retailer)};${formatNumIT(r.fatturato)};${r.ordini};${formatNumIT(r.aov)}\n`;
        }
        filename = `retailer_breakdown_${formatFilenameDate(dateFrom)}_${formatFilenameDate(dateTo)}.csv`;
      } else if (input.reportType === "marketplace" && input.dataset === "orders") {
        const rows = await db.execute<any>(
          sql.raw(`
            SELECT
              mo."channelOrderNumber" AS "numero",
              mo."orderDate" AS "data",
              mo."customerName" AS "cliente",
              mo."totalGross"::float AS "totale",
              ss."channel" AS "canale",
              mo."shippingCountry" AS "paese"
            FROM "marketplace_orders" mo
            INNER JOIN "sales_stores" ss ON ss."id" = mo."storeId"
            WHERE mo."orderDate" >= '${dateFrom.toISOString()}'::timestamptz
              AND mo."orderDate" <= '${dateTo.toISOString()}'::timestamptz
            ORDER BY mo."orderDate" DESC
          `)
        );
        const data = rows as unknown as any[];
        csvContent = "Numero;Data;Cliente;Totale;Canale;Paese\n";
        for (const r of data) {
          csvContent += `${escCsv(r.numero ?? "")};${formatDateCSV(r.data)};${escCsv(r.cliente ?? "")};${formatNumIT(r.totale)};${r.canale};${r.paese ?? ""}\n`;
        }
        filename = `marketplace_ordini_${formatFilenameDate(dateFrom)}_${formatFilenameDate(dateTo)}.csv`;
      } else {
        throw new Error(`Dataset "${input.dataset}" non supportato per report "${input.reportType}"`);
      }

      return { csvContent, filename };
    }),
});

// CSV helpers
function escCsv(val: string): string {
  if (val.includes(";") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function formatNumIT(num: number): string {
  return num.toFixed(2).replace(".", ",");
}

function formatDateCSV(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("it-IT");
}

function formatFilenameDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ============= COMBINED ROUTER =============

export const reportsRouter = router({
  warehouse: warehouseRouter,
  sales: salesRouter,
  marketplace: marketplaceRouter,
  export: exportRouter,
});
