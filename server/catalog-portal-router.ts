/**
 * M6.2.B — Catalog Portal Router
 *
 * Procedure retailer per catalogo prodotti con:
 * - Prezzi base + scontati (pacchetto retailer)
 * - Stock disponibile = totale magazzino centrale - prenotato pending/paid altri ordini
 * - Dettaglio prodotto con breakdown lotti FEFO
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { retailerProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  inventoryByBatch,
  locations,
  orderItems,
  orders,
  pricingPackages,
  productBatches,
  products,
  retailers,
} from "../drizzle/schema";

export const catalogPortalRouter = router({
  /**
   * 1. catalogPortal.list — catalogo prodotti per retailer
   *
   * Stock disponibile = SUM(inventoryByBatch.quantity) nel magazzino centrale
   *   MINUS SUM(orderItems.quantity) dove ordine in (pending, paid) e ordine != mio pending
   *
   * Per semplicità: sottraiamo TUTTI i pending/paid (inclusi i miei).
   * stockReserved = quantità nei MIEI ordini pending.
   */
  list: retailerProcedure
    .input(
      z.object({
        search: z.string().optional(),
        category: z.string().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(24),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // 1. Ottieni sconto retailer
      const [retailer] = await db
        .select({
          pricingPackageId: retailers.pricingPackageId,
        })
        .from(retailers)
        .where(eq(retailers.id, ctx.retailerId))
        .limit(1);

      let discountPercent = 0;
      if (retailer?.pricingPackageId) {
        const [pkg] = await db
          .select({ discountPercent: pricingPackages.discountPercent })
          .from(pricingPackages)
          .where(eq(pricingPackages.id, retailer.pricingPackageId))
          .limit(1);
        if (pkg) discountPercent = parseFloat(pkg.discountPercent);
      }

      // 2. Filtri prodotti
      const conditions = [];
      if (input.search) {
        const term = `%${input.search}%`;
        conditions.push(
          or(
            ilike(products.name, term),
            ilike(products.sku, term),
            ilike(products.category, term),
          ),
        );
      }
      if (input.category) {
        conditions.push(eq(products.category, input.category));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // 3. Count totale
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(whereClause);
      const total = countRow?.count ?? 0;

      // 4. Prodotti paginati
      const offset = (input.page - 1) * input.pageSize;
      const productRows = await db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          category: products.category,
          description: products.description,
          unitPrice: products.unitPrice,
          vatRate: products.vatRate,
          piecesPerUnit: products.piecesPerUnit,
          sellableUnitLabel: products.sellableUnitLabel,
          imageUrl: products.imageUrl,
        })
        .from(products)
        .where(whereClause)
        .orderBy(asc(products.name))
        .limit(input.pageSize)
        .offset(offset);

      if (productRows.length === 0) {
        return { items: [], total };
      }

      const productIds = productRows.map((p) => p.id);

      // 5. Stock totale magazzino centrale per prodotto
      const stockRows = await db.execute<{ productId: string; totalQty: number }>(sql`
        SELECT pb."productId" AS "productId",
               COALESCE(SUM(ibb."quantity"), 0)::int AS "totalQty"
        FROM "inventoryByBatch" ibb
        INNER JOIN "locations" l ON l."id" = ibb."locationId"
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        WHERE l."type" = 'central_warehouse'
          AND pb."productId" IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
        GROUP BY pb."productId"
      `);
      const stockMap = new Map(
        (stockRows as unknown as Array<{ productId: string; totalQty: number }>).map((s) => [
          s.productId,
          s.totalQty,
        ]),
      );

      // 6. Quantità prenotata da TUTTI gli ordini pending/paid (per ogni prodotto)
      const reservedRows = await db.execute<{ productId: string; reservedQty: number }>(sql`
        SELECT oi."productId" AS "productId",
               COALESCE(SUM(oi."quantity"), 0)::int AS "reservedQty"
        FROM "orderItems" oi
        INNER JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."status" IN ('pending', 'paid')
          AND oi."productId" IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
        GROUP BY oi."productId"
      `);
      const reservedMap = new Map(
        (reservedRows as unknown as Array<{ productId: string; reservedQty: number }>).map((r) => [
          r.productId,
          r.reservedQty,
        ]),
      );

      // 7. Quantità nei MIEI ordini pending (stockReserved per me)
      const myReservedRows = await db.execute<{ productId: string; myQty: number }>(sql`
        SELECT oi."productId" AS "productId",
               COALESCE(SUM(oi."quantity"), 0)::int AS "myQty"
        FROM "orderItems" oi
        INNER JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."status" = 'pending'
          AND o."retailerId" = ${ctx.retailerId}::uuid
          AND oi."productId" IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
        GROUP BY oi."productId"
      `);
      const myReservedMap = new Map(
        (myReservedRows as unknown as Array<{ productId: string; myQty: number }>).map((r) => [
          r.productId,
          r.myQty,
        ]),
      );

      // 8. Mappa risultati
      const items = productRows.map((p) => {
        const unitPriceBase = parseFloat(p.unitPrice || "0");
        const unitPriceFinal = Math.round(unitPriceBase * (1 - discountPercent / 100) * 100) / 100;
        const totalStock = stockMap.get(p.id) ?? 0;
        const totalReserved = reservedMap.get(p.id) ?? 0;
        const stockAvailable = Math.max(0, totalStock - totalReserved);
        const stockReserved = myReservedMap.get(p.id) ?? 0;

        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          category: p.category,
          description: p.description,
          unitPriceBase: unitPriceBase.toFixed(2),
          unitPriceFinal: unitPriceFinal.toFixed(2),
          discountPercent: discountPercent.toFixed(2),
          vatRate: p.vatRate,
          piecesPerUnit: p.piecesPerUnit,
          sellableUnitLabel: p.sellableUnitLabel,
          imageUrl: p.imageUrl,
          stockAvailable,
          stockReserved,
          isAvailable: stockAvailable > 0,
        };
      });

      return { items, total };
    }),

  /**
   * 2. catalogPortal.getById — dettaglio prodotto con lotti FEFO
   */
  getById: retailerProcedure
    .input(z.object({ productId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // Prodotto
      const [product] = await db
        .select()
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);
      if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "Prodotto non trovato" });

      // Sconto retailer
      const [retailer] = await db
        .select({ pricingPackageId: retailers.pricingPackageId })
        .from(retailers)
        .where(eq(retailers.id, ctx.retailerId))
        .limit(1);

      let discountPercent = 0;
      let packageName: string | null = null;
      if (retailer?.pricingPackageId) {
        const [pkg] = await db
          .select({ discountPercent: pricingPackages.discountPercent, name: pricingPackages.name })
          .from(pricingPackages)
          .where(eq(pricingPackages.id, retailer.pricingPackageId))
          .limit(1);
        if (pkg) {
          discountPercent = parseFloat(pkg.discountPercent);
          packageName = pkg.name;
        }
      }

      const unitPriceBase = parseFloat(product.unitPrice || "0");
      const unitPriceFinal = Math.round(unitPriceBase * (1 - discountPercent / 100) * 100) / 100;

      // Lotti disponibili FEFO nel magazzino centrale (stock > 0)
      const batchRows = await db
        .select({
          batchId: productBatches.id,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
          stock: inventoryByBatch.quantity,
        })
        .from(productBatches)
        .innerJoin(
          inventoryByBatch,
          eq(inventoryByBatch.batchId, productBatches.id),
        )
        .innerJoin(locations, eq(locations.id, inventoryByBatch.locationId))
        .where(
          and(
            eq(productBatches.productId, input.productId),
            eq(locations.type, "central_warehouse"),
            gt(inventoryByBatch.quantity, 0),
          ),
        )
        .orderBy(asc(productBatches.expirationDate));

      // Stock totale e prenotato
      const totalStock = batchRows.reduce((sum, b) => sum + b.stock, 0);

      const reservedRows = await db.execute<{ reservedQty: number }>(sql`
        SELECT COALESCE(SUM(oi."quantity"), 0)::int AS "reservedQty"
        FROM "orderItems" oi
        INNER JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."status" IN ('pending', 'paid')
          AND oi."productId" = ${input.productId}::uuid
      `);
      const totalReserved = (reservedRows as unknown as Array<{ reservedQty: number }>)[0]?.reservedQty ?? 0;
      const stockAvailable = Math.max(0, totalStock - totalReserved);

      return {
        product: {
          ...product,
          unitPriceBase: unitPriceBase.toFixed(2),
          unitPriceFinal: unitPriceFinal.toFixed(2),
          discountPercent: discountPercent.toFixed(2),
          packageName,
        },
        batches: batchRows.map((b) => ({
          batchId: b.batchId,
          batchNumber: b.batchNumber,
          expirationDate: b.expirationDate,
          stock: b.stock,
        })),
        stockTotal: totalStock,
        stockReserved: totalReserved,
        stockAvailable,
      };
    }),

  /**
   * 3. categories — lista categorie distinte per filtro
   */
  categories: retailerProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

    const rows = await db
      .selectDistinct({ category: products.category })
      .from(products)
      .where(sql`${products.category} IS NOT NULL AND ${products.category} != ''`)
      .orderBy(asc(products.category));

    return rows.map((r) => r.category!).filter(Boolean);
  }),
});
