import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // ============= RETAILERS =============
  retailers: router({
    list: protectedProcedure.query(async () => {
      return await db.getAllRetailers();
    }),

    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return await db.getRetailerById(input.id);
      }),

    getDetails: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const retailer = await db.getRetailerById(input.id);
        if (!retailer) return null;

        const inventoryItems = await db.getInventoryByRetailer(input.id);
        const recentMovements = await db.getStockMovementsByRetailer(input.id, 50);
        const retailerAlerts = await db.getAlertsByRetailer(input.id);

        // Arricchisci inventario con dati prodotto
        const enrichedInventory = await Promise.all(
          inventoryItems.map(async (item) => {
            const product = await db.getProductById(item.productId);
            return {
              ...item,
              product,
            };
          })
        );

        // Arricchisci movimenti con dati prodotto
        const enrichedMovements = await Promise.all(
          recentMovements.map(async (movement) => {
            const product = await db.getProductById(movement.productId);
            return {
              ...movement,
              product,
            };
          })
        );

        // Calcola statistiche rivenditore
        let totalValue = 0;
        let lowStockCount = 0;
        let expiringCount = 0;

        for (const item of enrichedInventory) {
          if (item.product?.unitPrice) {
            const price = parseFloat(item.product.unitPrice);
            if (!isNaN(price)) {
              totalValue += price * item.quantity;
            }
          }

          if (item.product && item.quantity < (item.product.minStockThreshold || 10)) {
            lowStockCount++;
          }

          if (item.expirationDate) {
            const daysUntilExpiry = Math.floor(
              (new Date(item.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
            );
            if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
              expiringCount++;
            }
          }
        }

        return {
          retailer,
          inventory: enrichedInventory,
          recentMovements: enrichedMovements,
          alerts: retailerAlerts,
          stats: {
            totalValue: totalValue.toFixed(2),
            totalItems: inventoryItems.length,
            lowStockCount,
            expiringCount,
            activeAlertsCount: retailerAlerts.filter(a => a.status === 'ACTIVE').length,
          },
        };
      }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1),
        businessType: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        province: z.string().max(2).optional(),
        postalCode: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        contactPerson: z.string().optional(),
        fattureInCloudCompanyId: z.string().optional(),
        fattureInCloudApiKey: z.string().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        return await db.createRetailer(input);
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        businessType: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        province: z.string().max(2).optional(),
        postalCode: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        contactPerson: z.string().optional(),
        fattureInCloudCompanyId: z.string().optional(),
        fattureInCloudApiKey: z.string().optional(),
        syncEnabled: z.number().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateRetailer(id, data);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteRetailer(input.id);
        return { success: true };
      }),
  }),

  // ============= PRODUCTS =============
  products: router({
    list: protectedProcedure.query(async () => {
      return await db.getAllProducts();
    }),

    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return await db.getProductById(input.id);
      }),

    getBySku: protectedProcedure
      .input(z.object({ sku: z.string() }))
      .query(async ({ input }) => {
        return await db.getProductBySku(input.sku);
      }),

    create: protectedProcedure
      .input(z.object({
        sku: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        category: z.string().optional(),
        isLowCarb: z.number().optional(),
        isGlutenFree: z.number().optional(),
        isKeto: z.number().optional(),
        sugarContent: z.string().optional(),
        supplierId: z.number().optional(),
        supplierName: z.string().optional(),
        unitPrice: z.string().optional(),
        unit: z.string().optional(),
        minStockThreshold: z.number().optional(),
        expiryWarningDays: z.number().optional(),
        imageUrl: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        return await db.createProduct(input);
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        sku: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        isLowCarb: z.number().optional(),
        isGlutenFree: z.number().optional(),
        isKeto: z.number().optional(),
        sugarContent: z.string().optional(),
        supplierId: z.number().optional(),
        supplierName: z.string().optional(),
        unitPrice: z.string().optional(),
        unit: z.string().optional(),
        minStockThreshold: z.number().optional(),
        expiryWarningDays: z.number().optional(),
        imageUrl: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateProduct(id, data);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteProduct(input.id);
        return { success: true };
      }),
  }),

  // ============= INVENTORY =============
  inventory: router({
    getByRetailer: protectedProcedure
      .input(z.object({ retailerId: z.number() }))
      .query(async ({ input }) => {
        return await db.getInventoryByRetailer(input.retailerId);
      }),

    upsert: protectedProcedure
      .input(z.object({
        retailerId: z.number(),
        productId: z.number(),
        quantity: z.number(),
        expirationDate: z.date().optional(),
        batchNumber: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        return await db.upsertInventory(input);
      }),
  }),

  // ============= STOCK MOVEMENTS =============
  stockMovements: router({
    create: protectedProcedure
      .input(z.object({
        inventoryId: z.number(),
        retailerId: z.number(),
        productId: z.number(),
        type: z.enum(["IN", "OUT", "ADJUSTMENT"]),
        quantity: z.number(),
        previousQuantity: z.number().optional(),
        newQuantity: z.number().optional(),
        sourceDocument: z.string().optional(),
        sourceDocumentType: z.string().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return await db.createStockMovement({
          ...input,
          createdBy: ctx.user?.id,
        });
      }),

    getByRetailer: protectedProcedure
      .input(z.object({ 
        retailerId: z.number(),
        limit: z.number().optional(),
      }))
      .query(async ({ input }) => {
        return await db.getStockMovementsByRetailer(input.retailerId, input.limit);
      }),

    getByProduct: protectedProcedure
      .input(z.object({ 
        productId: z.number(),
        limit: z.number().optional(),
      }))
      .query(async ({ input }) => {
        return await db.getStockMovementsByProduct(input.productId, input.limit);
      }),
  }),

  // ============= ALERTS =============
  alerts: router({
    getActive: protectedProcedure.query(async () => {
      return await db.getActiveAlerts();
    }),

    getByRetailer: protectedProcedure
      .input(z.object({ retailerId: z.number() }))
      .query(async ({ input }) => {
        return await db.getAlertsByRetailer(input.retailerId);
      }),

    create: protectedProcedure
      .input(z.object({
        retailerId: z.number(),
        productId: z.number(),
        type: z.enum(["LOW_STOCK", "EXPIRING", "EXPIRED"]),
        message: z.string().optional(),
        currentQuantity: z.number().optional(),
        thresholdQuantity: z.number().optional(),
        expirationDate: z.date().optional(),
      }))
      .mutation(async ({ input }) => {
        return await db.createAlert(input);
      }),

    updateStatus: protectedProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["ACTIVE", "ACKNOWLEDGED", "RESOLVED"]),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateAlertStatus(input.id, input.status, ctx.user?.id);
        return { success: true };
      }),
  }),

  // ============= DASHBOARD STATS =============
  dashboard: router({
    getStats: protectedProcedure.query(async () => {
      const retailers = await db.getAllRetailers();
      const products = await db.getAllProducts();
      const activeAlerts = await db.getActiveAlerts();

      // Calcola statistiche aggregate
      let totalInventoryValue = 0;
      let lowStockItems = 0;
      let expiringItems = 0;

      for (const retailer of retailers) {
        const inventory = await db.getInventoryByRetailer(retailer.id);
        for (const item of inventory) {
          const product = await db.getProductById(item.productId);
          if (product && product.unitPrice) {
            const price = parseFloat(product.unitPrice);
            if (!isNaN(price)) {
              totalInventoryValue += price * item.quantity;
            }
          }
          
          // Conta item con scorte basse
          if (product && item.quantity < (product.minStockThreshold || 10)) {
            lowStockItems++;
          }

          // Conta item in scadenza (entro 30 giorni)
          if (item.expirationDate) {
            const daysUntilExpiry = Math.floor(
              (new Date(item.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
            );
            if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
              expiringItems++;
            }
          }
        }
      }

      return {
        totalRetailers: retailers.length,
        totalProducts: products.length,
        activeAlerts: activeAlerts.length,
        totalInventoryValue: totalInventoryValue.toFixed(2),
        lowStockItems,
        expiringItems,
      };
    }),
  }),

  // ============= FATTURE IN CLOUD SYNC =============
  sync: router({
    // Avvia sincronizzazione manuale per un rivenditore
    syncRetailer: protectedProcedure
      .input(z.object({ retailerId: z.number() }))
      .mutation(async ({ input }) => {
        const { syncRetailerData } = await import("./fattureincloud-sync");
        return await syncRetailerData(input.retailerId);
      }),

    // Ottieni URL per OAuth
    getAuthUrl: protectedProcedure
      .input(z.object({ retailerId: z.number() }))
      .query(async ({ input }) => {
        const { getAuthorizationUrl, getOAuthConfig } = await import("./fattureincloud-oauth");
        const config = getOAuthConfig();
        
        if (!config) {
          throw new Error("OAuth configuration not available. Please configure FATTUREINCLOUD_CLIENT_ID, FATTUREINCLOUD_CLIENT_SECRET, and FATTUREINCLOUD_REDIRECT_URI in environment variables.");
        }

        const state = JSON.stringify({ retailerId: input.retailerId });
        return { url: getAuthorizationUrl(config, state) };
      }),

    // Disconnetti account Fatture in Cloud
    disconnect: protectedProcedure
      .input(z.object({ retailerId: z.number() }))
      .mutation(async ({ input }) => {
        await db.updateRetailer(input.retailerId, {
          fattureInCloudCompanyId: null,
          fattureInCloudAccessToken: null,
          fattureInCloudRefreshToken: null,
          fattureInCloudTokenExpiresAt: null,
          syncEnabled: 0,
        });
        return { success: true };
      }),

    // Ottieni log sincronizzazioni
    getLogs: protectedProcedure
      .input(z.object({ retailerId: z.number(), limit: z.number().optional() }))
      .query(async ({ input }) => {
        return await db.getSyncLogsByRetailer(input.retailerId, input.limit || 20);
      }),
  }),
});

export type AppRouter = typeof appRouter;
