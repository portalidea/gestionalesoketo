/**
 * M8.1 — Shopify Router
 * 12 tRPC procedures for Shopify marketplace integration.
 * All procedures require staff access (staffProcedure).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { router, staffProcedure, staffProcedureLongRunning } from "./_core/trpc";
import { getDb } from "./db";
import {
  channelVariants,
  channelVariantComponents,
  inventoryByBatch,
  locations,
  marketplaceOrderItems,
  marketplaceOrders,
  productBatches,
  products,
  salesStores,
  stockMovements,
} from "../drizzle/schema";
import { ShopifyClient } from "./services/shopifyService";
import {
  importShopifyOrder,
  processStockForMarketplaceOrder,
  retryFailedOrders,
} from "./services/marketplaceOrderService";
import {
  syncVariantsFromShopify,
  getVariantCounts,
  computeVariantAvailableStock,
  type SyncVariantsResult,
} from "./services/channelVariantService";

const uuid = z.string().uuid();

export const shopifyRouter = router({
  // ─── Store ───────────────────────────────────────────────────────────────

  store: router({
    get: staffProcedure.query(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [store] = await db
        .select({
          id: salesStores.id,
          name: salesStores.name,
          storeIdentifier: salesStores.storeIdentifier,
          isActive: salesStores.isActive,
          lastSyncAt: salesStores.lastSyncAt,
          apiCredentials: salesStores.apiCredentials,
        })
        .from(salesStores)
        .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)))
        .limit(1);

      if (!store) return null;

      return {
        id: store.id,
        name: store.name,
        storeIdentifier: store.storeIdentifier,
        isActive: store.isActive,
        lastSyncAt: store.lastSyncAt,
        isConfigured: !!(store.apiCredentials as any)?.accessToken,
      };
    }),

    configure: staffProcedure
      .input(
        z.object({
          name: z.string().min(1),
          storeIdentifier: z.string().min(1),
          accessToken: z.string().min(1),
        }),
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

        // Test connection first
        let testSuccess = false;
        try {
          const client = new ShopifyClient(input.storeIdentifier, input.accessToken);
          await client.testConnection();
          testSuccess = true;
        } catch (e: any) {
          console.error(`[shopify.store.configure] test connection failed: ${e.message}`);
        }

        // UPSERT store
        const existing = await db
          .select({ id: salesStores.id })
          .from(salesStores)
          .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)))
          .limit(1);

        let storeId: string;

        if (existing.length > 0) {
          storeId = existing[0].id;
          await db
            .update(salesStores)
            .set({
              name: input.name,
              storeIdentifier: input.storeIdentifier,
              apiCredentials: { accessToken: input.accessToken },
              updatedAt: new Date(),
            })
            .where(eq(salesStores.id, storeId));
        } else {
          const [newStore] = await db
            .insert(salesStores)
            .values({
              channel: "shopify",
              name: input.name,
              storeIdentifier: input.storeIdentifier,
              apiCredentials: { accessToken: input.accessToken },
              isActive: true,
            })
            .returning();
          storeId = newStore.id;
        }

        console.log(
          `[shopify.store.configure] storeId=${storeId} testSuccess=${testSuccess}`,
        );

        return { storeId, testConnectionSuccess: testSuccess };
      }),
  }),

  // ─── Variants ────────────────────────────────────────────────────────────

  variants: router({
    syncFromShopify: staffProcedureLongRunning.mutation(async (): Promise<SyncVariantsResult> => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      const [store] = await db
        .select({ id: salesStores.id })
        .from(salesStores)
        .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)))
        .limit(1);

      if (!store)
        throw new TRPCError({ code: "NOT_FOUND", message: "Nessuno store Shopify configurato" });

      try {
        const result = await syncVariantsFromShopify(store.id);
        console.log(
          `[shopify.variants.syncFromShopify] completed: status=${result.status} imported=${result.imported} updated=${result.updated} errors=${result.errors.length}`,
        );
        return result;
      } catch (err: any) {
        console.error(
          `[shopify.variants.syncFromShopify] uncaught error: ${err.message}`,
        );
        // Return partial result instead of throwing
        return {
          imported: 0,
          updated: 0,
          unmapped: 0,
          errors: [`Errore sync varianti: ${err.message}`],
          status: "partial",
          totalProducts: 0,
          totalVariants: 0,
        };
      }
    }),

    list: staffProcedure
      .input(
        z.object({
          storeId: z.string().uuid().optional(),
          productId: z.string().uuid().optional(),
          onlyUnmapped: z.boolean().optional(),
          search: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        }),
      )
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

        // Find active shopify store if storeId not provided
        let storeId = input.storeId;
        if (!storeId) {
          const [store] = await db
            .select({ id: salesStores.id })
            .from(salesStores)
            .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)))
            .limit(1);
          if (!store) return { items: [], totalCount: 0 };
          storeId = store.id;
        }

        const conditions: any[] = [eq(channelVariants.storeId, storeId)];

        if (input.productId) {
          conditions.push(eq(channelVariants.productId, input.productId));
        }
        if (input.onlyUnmapped) {
          conditions.push(isNull(channelVariants.productId));
        }
        if (input.search) {
          const term = `%${input.search}%`;
          conditions.push(
            or(
              like(channelVariants.channelSku, term),
              like(channelVariants.displayName, term),
            ),
          );
        }

        const whereClause = and(...conditions);

        const [{ count: totalCount }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(channelVariants)
          .where(whereClause);

        const items = await db
          .select({
            id: channelVariants.id,
            storeId: channelVariants.storeId,
            productId: channelVariants.productId,
            channelSku: channelVariants.channelSku,
            channelProductId: channelVariants.channelProductId,
            channelVariantId: channelVariants.channelVariantId,
            displayName: channelVariants.displayName,
            multiplier: channelVariants.multiplier,
            isActive: channelVariants.isActive,
            createdAt: channelVariants.createdAt,
            updatedAt: channelVariants.updatedAt,
            productName: products.name,
            productSku: products.sku,
          })
          .from(channelVariants)
          .leftJoin(products, eq(channelVariants.productId, products.id))
          .where(whereClause)
          .orderBy(desc(channelVariants.updatedAt))
          .limit(input.limit)
          .offset(input.offset);

        return { items, totalCount };
      }),

    updateMapping: staffProcedure
      .input(
        z.object({
          variantId: z.string().uuid(),
          productId: z.string().uuid().nullable(),
          multiplier: z.number().int().min(1),
          displayName: z.string().optional(),
          isActive: z.boolean().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

        // Validate productId exists if not null
        if (input.productId) {
          const [product] = await db
            .select({ id: products.id })
            .from(products)
            .where(eq(products.id, input.productId))
            .limit(1);
          if (!product) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Prodotto non trovato" });
          }
        }

        const updateData: any = {
          productId: input.productId,
          multiplier: input.multiplier,
          updatedAt: new Date(),
        };
        if (input.displayName !== undefined) updateData.displayName = input.displayName;
        if (input.isActive !== undefined) updateData.isActive = input.isActive;

        await db
          .update(channelVariants)
          .set(updateData)
          .where(eq(channelVariants.id, input.variantId));

        console.log(
          `[shopify.variants.updateMapping] variantId=${input.variantId} productId=${input.productId} multiplier=${input.multiplier}`,
        );

        return { success: true };
      }),

    setBundle: staffProcedure
      .input(
        z.object({
          variantId: z.string().uuid(),
          isBundle: z.boolean(),
          components: z
            .array(
              z.object({
                productId: z.string().uuid(),
                quantity: z.number().int().min(1),
              }),
            )
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

        // Verify variant exists
        const [variant] = await db
          .select({ id: channelVariants.id })
          .from(channelVariants)
          .where(eq(channelVariants.id, input.variantId))
          .limit(1);

        if (!variant)
          throw new TRPCError({ code: "NOT_FOUND", message: "Variant non trovata" });

        if (input.isBundle) {
          // Validate components
          if (!input.components || input.components.length === 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Un bundle deve avere almeno un componente",
            });
          }

          // Validate all productIds exist
          const productIds = input.components.map((c) => c.productId);
          const existingProducts = await db
            .select({ id: products.id })
            .from(products)
            .where(inArray(products.id, productIds));

          if (existingProducts.length !== new Set(productIds).size) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Uno o pi\u00f9 prodotti componente non trovati",
            });
          }

          // Transaction: update variant + replace components
          await db.transaction(async (tx: any) => {
            // Set isBundle=true, clear productId (bundle doesn't map to single product)
            await tx
              .update(channelVariants)
              .set({
                isBundle: true,
                productId: null,
                updatedAt: new Date(),
              })
              .where(eq(channelVariants.id, input.variantId));

            // Delete existing components
            await tx
              .delete(channelVariantComponents)
              .where(eq(channelVariantComponents.channelVariantId, input.variantId));

            // Insert new components
            await tx.insert(channelVariantComponents).values(
              input.components!.map((c, i) => ({
                channelVariantId: input.variantId,
                productId: c.productId,
                quantity: c.quantity,
                sortOrder: i,
              })),
            );
          });

          console.log(
            `[shopify.variants.setBundle] variantId=${input.variantId} set as bundle with ${input.components.length} components`,
          );
        } else {
          // Unset bundle: remove components, set isBundle=false
          await db.transaction(async (tx: any) => {
            await tx
              .delete(channelVariantComponents)
              .where(eq(channelVariantComponents.channelVariantId, input.variantId));

            await tx
              .update(channelVariants)
              .set({
                isBundle: false,
                updatedAt: new Date(),
              })
              .where(eq(channelVariants.id, input.variantId));
          });

          console.log(
            `[shopify.variants.setBundle] variantId=${input.variantId} unset bundle`,
          );
        }

        return { success: true };
      }),

    getComponents: staffProcedure
      .input(z.object({ variantId: z.string().uuid() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

        const components = await db
          .select({
            id: channelVariantComponents.id,
            productId: channelVariantComponents.productId,
            productName: products.name,
            productSku: products.sku,
            quantity: channelVariantComponents.quantity,
            sortOrder: channelVariantComponents.sortOrder,
          })
          .from(channelVariantComponents)
          .leftJoin(products, eq(channelVariantComponents.productId, products.id))
          .where(eq(channelVariantComponents.channelVariantId, input.variantId))
          .orderBy(asc(channelVariantComponents.sortOrder));

        return components;
      }),
  }),

  // ─── Orders ──────────────────────────────────────────────────────────────

  orders: router({
    syncRecent: staffProcedure
      .input(
        z.object({
          hoursBack: z.number().int().min(1).max(720).default(24),
          financialStatus: z.enum(["paid", "any"]).default("paid"),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
        // Get active store
         const [store] = await db
          .select()
          .from(salesStores)
          .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)))
          .limit(1);
        if (!store)
          throw new TRPCError({ code: "NOT_FOUND", message: "Nessuno store Shopify configurato" });
        if (!(store.apiCredentials as any)?.accessToken)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Store non ha accessToken configurato" });

        const client = new ShopifyClient(
          store.storeIdentifier,
          (store.apiCredentials as any).accessToken,
        );

        // Calculate created_at_min
        const createdAtMin = new Date(
          Date.now() - input.hoursBack * 60 * 60 * 1000,
        ).toISOString();

        console.log(
          `[shopify.orders.syncRecent] hoursBack=${input.hoursBack} financialStatus=${input.financialStatus} createdAtMin=${createdAtMin}`,
        );

        // Fetch all orders (paginated)
        let allOrders: any[] = [];
        let result = await client.fetchOrders({
          createdAtMin,
          financialStatus: input.financialStatus,
          status: "any",
          limit: 50,
        });
        allOrders.push(...result.orders);

        while (result.nextPageInfo) {
          result = await client.fetchOrdersByPageInfo(result.nextPageInfo, 50);
          allOrders.push(...result.orders);
        }

        console.log(`[shopify.orders.syncRecent] fetched ${allOrders.length} orders from Shopify`);

        // Process each order
        let imported = 0;
        let duplicates = 0;
        let processedStock = 0;
        let failed = 0;
        const errors: Array<{ orderId: string; error: string }> = [];

        for (const shopifyOrder of allOrders) {
          try {
            const importResult = await importShopifyOrder(store.id, shopifyOrder);

            if (importResult.status === "duplicate") {
              duplicates++;
              continue;
            }

            imported++;

            // Process stock (M11.A: pass companyId)
            const stockResult = await processStockForMarketplaceOrder(
              importResult.marketplaceOrderId,
              ctx.activeCompanyId,
            );

            if (stockResult.status === "processed") {
              processedStock++;
            } else {
              failed++;
              errors.push({
                orderId: String(shopifyOrder.order_number),
                error: stockResult.errors.join("; "),
              });
            }
          } catch (e: any) {
            failed++;
            errors.push({
              orderId: String(shopifyOrder.order_number || shopifyOrder.id),
              error: e.message,
            });
          }
        }

        // Update lastSyncAt
        await db
          .update(salesStores)
          .set({ lastSyncAt: new Date(), updatedAt: new Date() })
          .where(eq(salesStores.id, store.id));

        console.log(
          `[shopify.orders.syncRecent] done: fetched=${allOrders.length} imported=${imported} duplicates=${duplicates} processedStock=${processedStock} failed=${failed}`,
        );

        return {
          fetched: allOrders.length,
          imported,
          duplicates,
          processedStock,
          failed,
          errors,
        };
      }),

    list: staffProcedure
      .input(
        z.object({
          status: z.enum(["pending", "processed", "partial", "failed"]).optional(),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          search: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(25),
          offset: z.number().int().min(0).default(0),
          sortBy: z.enum(["orderDate", "syncedAt", "channelOrderNumber"]).default("orderDate"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
        }),
      )
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

        const conditions: any[] = [];

        if (input.status) {
          conditions.push(eq(marketplaceOrders.stockProcessingStatus, input.status));
        }
        if (input.dateFrom) {
          conditions.push(gte(marketplaceOrders.orderDate, new Date(input.dateFrom)));
        }
        if (input.dateTo) {
          conditions.push(lt(marketplaceOrders.orderDate, new Date(input.dateTo)));
        }
        if (input.search) {
          const term = `%${input.search}%`;
          conditions.push(
            or(
              like(marketplaceOrders.channelOrderNumber, term),
              like(marketplaceOrders.customerEmail, term),
              like(marketplaceOrders.customerName, term),
            ),
          );
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        const [{ count: totalCount }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(marketplaceOrders)
          .where(whereClause);

        const sortColumn =
          input.sortBy === "orderDate"
            ? marketplaceOrders.orderDate
            : input.sortBy === "syncedAt"
              ? marketplaceOrders.syncedAt
              : marketplaceOrders.channelOrderNumber;

        const sortFn = input.sortOrder === "asc" ? asc : desc;

        const items = await db
          .select({
            id: marketplaceOrders.id,
            channelOrderId: marketplaceOrders.channelOrderId,
            channelOrderNumber: marketplaceOrders.channelOrderNumber,
            customerEmail: marketplaceOrders.customerEmail,
            customerName: marketplaceOrders.customerName,
            orderDate: marketplaceOrders.orderDate,
            totalGross: marketplaceOrders.totalGross,
            currency: marketplaceOrders.currency,
            stockProcessingStatus: marketplaceOrders.stockProcessingStatus,
            stockProcessingAttempts: marketplaceOrders.stockProcessingAttempts,
            stockProcessingError: marketplaceOrders.stockProcessingError,
            syncedAt: marketplaceOrders.syncedAt,
            stockProcessedAt: marketplaceOrders.stockProcessedAt,
          })
          .from(marketplaceOrders)
          .where(whereClause)
          .orderBy(sortFn(sortColumn))
          .limit(input.limit)
          .offset(input.offset);

        return { items, totalCount };
      }),

    getById: staffProcedure
      .input(z.object({ marketplaceOrderId: uuid }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

        const [order] = await db
          .select()
          .from(marketplaceOrders)
          .where(eq(marketplaceOrders.id, input.marketplaceOrderId))
          .limit(1);

        if (!order)
          throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });

        // Items with product mapping
        const items = await db
          .select({
            id: marketplaceOrderItems.id,
            channelSku: marketplaceOrderItems.channelSku,
            productId: marketplaceOrderItems.productId,
            channelQuantity: marketplaceOrderItems.channelQuantity,
            piecesQuantity: marketplaceOrderItems.piecesQuantity,
            unitPrice: marketplaceOrderItems.unitPrice,
            lineTotal: marketplaceOrderItems.lineTotal,
            displayName: marketplaceOrderItems.displayName,
            productName: products.name,
            productSku: products.sku,
          })
          .from(marketplaceOrderItems)
          .leftJoin(products, eq(marketplaceOrderItems.productId, products.id))
          .where(eq(marketplaceOrderItems.marketplaceOrderId, input.marketplaceOrderId));

        // Stock movements generated for this order
        const movements = await db
          .select({
            id: stockMovements.id,
            productId: stockMovements.productId,
            type: stockMovements.type,
            quantity: stockMovements.quantity,
            batchId: stockMovements.batchId,
            previousQuantity: stockMovements.previousQuantity,
            newQuantity: stockMovements.newQuantity,
            timestamp: stockMovements.timestamp,
            notesInternal: stockMovements.notesInternal,
          })
          .from(stockMovements)
          .where(eq(stockMovements.marketplaceOrderId, input.marketplaceOrderId))
          .orderBy(asc(stockMovements.timestamp));

        const canRetry =
          ["failed", "partial"].includes(order.stockProcessingStatus || "") &&
          order.stockProcessingAttempts < 5;

        return { order, items, stockMovements: movements, canRetry };
      }),

    retry: staffProcedure
      .input(z.object({ marketplaceOrderId: uuid }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
        // Reset error before retry
        await db
          .update(marketplaceOrders)
          .set({ stockProcessingError: null, updatedAt: new Date() })
          .where(eq(marketplaceOrders.id, input.marketplaceOrderId));

        const result = await processStockForMarketplaceOrder(input.marketplaceOrderId, ctx.activeCompanyId);

        return {
          success: result.status === "processed",
          status: result.status,
          errors: result.errors,
        };
      }),

    retryAllFailed: staffProcedure.mutation(async () => {
      return await retryFailedOrders();
    }),
  }),

  // ─── Stock Sync ──────────────────────────────────────────────────────────

  stock: router({
    syncToShopify: staffProcedure
      .input(
        z.object({
          productIds: z.array(z.string().uuid()).optional(),
        }),
      )
       .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
        // Get active store
        const [store] = await db
          .select()
          .from(salesStores)
          .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)))
          .limit(1);
        if (!store)
          throw new TRPCError({ code: "NOT_FOUND", message: "Nessuno store Shopify configurato" });
        if (!(store.apiCredentials as any)?.accessToken)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Store non ha accessToken configurato" });

        const client = new ShopifyClient(
          store.storeIdentifier,
          (store.apiCredentials as any).accessToken,
        );

        // Get central warehouse
        const [warehouse] = await db
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.type, "central_warehouse"), eq(locations.companyId, ctx.activeCompanyId)))
          .limit(1);

        if (!warehouse)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Magazzino centrale non configurato" });

        // Get active variants (both mapped simple + bundles)
        const conditions: any[] = [
          eq(channelVariants.storeId, store.id),
          eq(channelVariants.isActive, true),
        ];

        if (input.productIds && input.productIds.length > 0) {
          // Filter by productId only for non-bundle variants
          conditions.push(inArray(channelVariants.productId, input.productIds));
        } else {
          // Sync mapped variants + bundles
          conditions.push(
            or(
              sql`${channelVariants.productId} IS NOT NULL`,
              eq(channelVariants.isBundle, true),
            ),
          );
        }

        const variants = await db
          .select({
            id: channelVariants.id,
            productId: channelVariants.productId,
            channelVariantId: channelVariants.channelVariantId,
            channelSku: channelVariants.channelSku,
            multiplier: channelVariants.multiplier,
            isBundle: channelVariants.isBundle,
          })
          .from(channelVariants)
          .where(and(...conditions));

        console.log(
          `[shopify.stock.syncToShopify] syncing ${variants.length} variants (incl bundles)`,
        );

        // Fetch Shopify locations (we need the primary location)
        const shopifyLocations = await client.fetchLocations();
        const primaryLocation = shopifyLocations.find((l) => l.active);
        if (!primaryLocation) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Nessuna location attiva su Shopify" });
        }

        let synced = 0;
        let skipped = 0;
        const errors: Array<{ productId: string; sku: string; error: string }> = [];

        for (const variant of variants) {
          if (!variant.channelVariantId) {
            skipped++;
            continue;
          }

          // Skip non-bundle variants without productId
          if (!variant.isBundle && !variant.productId) {
            skipped++;
            continue;
          }

          try {
            // Use computeVariantAvailableStock for both simple and bundle variants
            const available = await computeVariantAvailableStock(variant.id, ctx.activeCompanyId);

            // TODO: Store inventory_item_id in channel_variants for direct access
            await client.updateInventoryLevel(
              parseInt(variant.channelVariantId),
              primaryLocation.id,
              available,
            );

            synced++;
          } catch (e: any) {
            errors.push({
              productId: variant.productId || "bundle",
              sku: variant.channelSku,
              error: e.message,
            });
          }
        }

        console.log(
          `[shopify.stock.syncToShopify] done: synced=${synced} skipped=${skipped} errors=${errors.length}`,
        );

        return { synced, skipped, errors };
      }),
  }),
});
