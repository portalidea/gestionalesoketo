import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { EKETO_COMPANY_ID } from "../../shared/const";
type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export interface AmazonSummaryPeriod {
  storeId: string;
  dateFrom: string;
  dateTo: string;
}
export interface AmazonProductSummary {
  productId: string;
  productName: string;
  actualPieces: number;
  plannedPieces: number;
}

/** Read-only. Caller authorization remains in amazon-router; SQL also confines
 * this helper to the configured E-Keto Amazon store. No observation sums stock. */
export async function getAmazonImportProductSummary(
  db: Database,
  input: AmazonSummaryPeriod
) {
  const products = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (ro.item_id) ro.item_id, ro.planned_allocations
      FROM amazon_import_row_observations ro
      JOIN amazon_import_runs r ON r.id=ro.run_id
      JOIN sales_stores s ON s.id=r.store_id AND s.channel='amazon' AND s."companyId"=${EKETO_COMPANY_ID}::uuid
      JOIN marketplace_order_items i ON i.id=ro.item_id AND i."amazonStockStatus"='dry_run'
      WHERE r.store_id=${input.storeId}::uuid AND ro.outcome='dry_run'
        AND r.created_at>=(${input.dateFrom}::date::timestamp AT TIME ZONE 'Europe/Rome')
        AND r.created_at<((${input.dateTo}::date+1)::timestamp AT TIME ZONE 'Europe/Rome')
      ORDER BY ro.item_id,ro.created_at DESC,ro.id DESC
    ), planned AS (
      SELECT (a->>'productId')::uuid product_id, SUM((a->>'pieces')::int)::int pieces
      FROM latest CROSS JOIN LATERAL jsonb_array_elements(planned_allocations) a
      GROUP BY (a->>'productId')::uuid
    ), actual AS (
      SELECT a.product_id,SUM(a.pieces)::int pieces
      FROM amazon_stock_allocations a JOIN amazon_import_runs r ON r.id=a.run_id
      JOIN sales_stores s ON s.id=r.store_id AND s.channel='amazon' AND s."companyId"=${EKETO_COMPANY_ID}::uuid
      WHERE r.store_id=${input.storeId}::uuid
        AND r.created_at>=(${input.dateFrom}::date::timestamp AT TIME ZONE 'Europe/Rome')
        AND r.created_at<((${input.dateTo}::date+1)::timestamp AT TIME ZONE 'Europe/Rome')
      GROUP BY a.product_id
    )
    SELECT p.id "productId",p.name "productName",COALESCE(actual.pieces,0)::int "actualPieces",COALESCE(planned.pieces,0)::int "plannedPieces"
    FROM products p LEFT JOIN actual ON actual.product_id=p.id LEFT JOIN planned ON planned.product_id=p.id
    WHERE actual.product_id IS NOT NULL OR planned.product_id IS NOT NULL
    ORDER BY p.name,p.id LIMIT 200
  `);
  const dailyOrders = await db.execute(sql`
    SELECT TO_CHAR(o."createdAt" AT TIME ZONE 'Europe/Rome','YYYY-MM-DD') date,COUNT(DISTINCT o.id)::int orders
    FROM marketplace_orders o JOIN sales_stores s ON s.id=o."storeId" AND s.channel='amazon' AND s."companyId"=${EKETO_COMPANY_ID}::uuid
    WHERE o."storeId"=${input.storeId}::uuid
      AND o."createdAt">=(${input.dateFrom}::date::timestamp AT TIME ZONE 'Europe/Rome')
      AND o."createdAt"<((${input.dateTo}::date+1)::timestamp AT TIME ZONE 'Europe/Rome')
    GROUP BY TO_CHAR(o."createdAt" AT TIME ZONE 'Europe/Rome','YYYY-MM-DD')
    ORDER BY date LIMIT 93
  `);
  const days = dailyOrders as unknown as Array<{
    date: string;
    orders: number;
  }>;
  return {
    products: products as unknown as AmazonProductSummary[],
    dailyOrders: days,
    importedOrders: days.reduce((total, day) => total + day.orders, 0),
  };
}
