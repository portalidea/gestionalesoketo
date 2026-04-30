import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  writerProcedure,
} from "./_core/trpc";
import { supabaseAdmin } from "./_core/supabase";
import * as db from "./db";

const uuid = z.string().uuid();
const userRoleSchema = z.enum(["admin", "operator", "viewer"]);

export const appRouter = router({
  system: systemRouter,

  // ============= AUTH =============
  // Il logout vero (revoca della sessione, clear localStorage) è gestito
  // lato client da supabase.auth.signOut(). Qui esponiamo solo `me`.
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
  }),

  // ============= USERS (admin-only) =============
  users: router({
    list: adminProcedure.query(async () => {
      return await db.getAllUsers();
    }),

    invite: adminProcedure
      .input(
        z.object({
          email: z.string().email(),
          role: userRoleSchema.default("operator"),
        }),
      )
      .mutation(async ({ input }) => {
        // Invio magic link via Supabase Admin API. Il trigger
        // handle_new_user creerà la riga in public.users con role default;
        // se è stato richiesto un role diverso, lo aggiorniamo subito dopo.
        const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          input.email,
        );
        if (error) {
          throw new Error(`Failed to invite user: ${error.message}`);
        }
        if (input.role !== "operator" && data.user) {
          await db.updateUserRole(data.user.id, input.role);
        }
        return { success: true, userId: data.user?.id ?? null };
      }),

    updateRole: adminProcedure
      .input(z.object({ id: uuid, role: userRoleSchema }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.id === input.id && input.role !== "admin") {
          throw new Error("Cannot demote yourself from admin");
        }
        await db.updateUserRole(input.id, input.role);
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.id === input.id) {
          throw new Error("Cannot delete yourself");
        }
        // Cancellando da auth.users, il CASCADE rimuove anche public.users.
        const { error } = await supabaseAdmin.auth.admin.deleteUser(input.id);
        if (error) {
          throw new Error(`Failed to delete user: ${error.message}`);
        }
        return { success: true };
      }),
  }),

  // ============= RETAILERS =============
  retailers: router({
    list: protectedProcedure.query(async () => {
      return await db.getAllRetailers();
    }),

    getById: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        return await db.getRetailerById(input.id);
      }),

    getDetails: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        const retailer = await db.getRetailerById(input.id);
        if (!retailer) return null;

        const inventoryItems = await db.getInventoryByRetailer(input.id);
        const recentMovements = await db.getStockMovementsByRetailer(input.id, 50);
        const retailerAlerts = await db.getAlertsByRetailer(input.id);

        const enrichedInventory = await Promise.all(
          inventoryItems.map(async (item) => {
            const product = await db.getProductById(item.productId);
            return { ...item, product };
          }),
        );

        const enrichedMovements = await Promise.all(
          recentMovements.map(async (movement) => {
            const product = await db.getProductById(movement.productId);
            return { ...movement, product };
          }),
        );

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
              (new Date(item.expirationDate).getTime() - Date.now()) /
                (1000 * 60 * 60 * 24),
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
            activeAlertsCount: retailerAlerts.filter((a) => a.status === "ACTIVE").length,
          },
        };
      }),

    create: writerProcedure
      .input(
        z.object({
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
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        return await db.createRetailer(input);
      }),

    update: writerProcedure
      .input(
        z.object({
          id: uuid,
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
          syncEnabled: z.number().optional(),
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateRetailer(id, data);
        return { success: true };
      }),

    dependentsCount: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        return await db.getRetailerDependentsCount(input.id);
      }),

    delete: writerProcedure
      .input(z.object({ id: uuid }))
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
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        return await db.getProductById(input.id);
      }),

    getBySku: protectedProcedure
      .input(z.object({ sku: z.string() }))
      .query(async ({ input }) => {
        return await db.getProductBySku(input.sku);
      }),

    create: writerProcedure
      .input(
        z.object({
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
        }),
      )
      .mutation(async ({ input }) => {
        return await db.createProduct(input);
      }),

    update: writerProcedure
      .input(
        z.object({
          id: uuid,
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
        }),
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateProduct(id, data);
        return { success: true };
      }),

    delete: writerProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        await db.deleteProduct(input.id);
        return { success: true };
      }),
  }),

  // ============= INVENTORY =============
  inventory: router({
    getByRetailer: protectedProcedure
      .input(z.object({ retailerId: uuid }))
      .query(async ({ input }) => {
        return await db.getInventoryByRetailer(input.retailerId);
      }),

    upsert: writerProcedure
      .input(
        z.object({
          retailerId: uuid,
          productId: uuid,
          quantity: z.number(),
          expirationDate: z.date().optional(),
          batchNumber: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        return await db.upsertInventory(input);
      }),
  }),

  // ============= STOCK MOVEMENTS =============
  stockMovements: router({
    /**
     * Crea movimento + aggiorna inventory atomicamente.
     * IN: inventory += qty, OUT: -= qty, ADJUSTMENT: replace.
     * batchNumber/expirationDate vengono salvati su inventory (lotto).
     */
    create: writerProcedure
      .input(
        z.object({
          retailerId: uuid,
          productId: uuid,
          type: z.enum(["IN", "OUT", "ADJUSTMENT"]),
          quantity: z.number().int().positive(),
          batchNumber: z.string().optional(),
          expirationDate: z.coerce.date().optional(),
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return await db.createMovementWithInventory({
          ...input,
          createdBy: ctx.user.id,
        });
      }),

    /**
     * Cancella movimento + rollback inventory a previousQuantity.
     * Fail se ci sono stati movimenti successivi (newQuantity non
     * matcha l'inventory corrente).
     */
    delete: writerProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        return await db.deleteMovementWithRollback(input.id);
      }),

    getByRetailer: protectedProcedure
      .input(
        z.object({
          retailerId: uuid,
          limit: z.number().optional(),
        }),
      )
      .query(async ({ input }) => {
        return await db.getStockMovementsByRetailer(input.retailerId, input.limit);
      }),

    getByProduct: protectedProcedure
      .input(
        z.object({
          productId: uuid,
          limit: z.number().optional(),
        }),
      )
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
      .input(z.object({ retailerId: uuid }))
      .query(async ({ input }) => {
        return await db.getAlertsByRetailer(input.retailerId);
      }),

    create: writerProcedure
      .input(
        z.object({
          retailerId: uuid,
          productId: uuid,
          type: z.enum(["LOW_STOCK", "EXPIRING", "EXPIRED"]),
          message: z.string().optional(),
          currentQuantity: z.number().optional(),
          thresholdQuantity: z.number().optional(),
          expirationDate: z.date().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        return await db.createAlert(input);
      }),

    updateStatus: writerProcedure
      .input(
        z.object({
          id: uuid,
          status: z.enum(["ACTIVE", "ACKNOWLEDGED", "RESOLVED"]),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        await db.updateAlertStatus(input.id, input.status, ctx.user.id);
        return { success: true };
      }),
  }),

  // ============= DASHBOARD STATS =============
  dashboard: router({
    getStats: protectedProcedure.query(async () => {
      return await db.getDashboardStats();
    }),
  }),

  // ============= FATTURE IN CLOUD SYNC =============
  sync: router({
    syncRetailer: writerProcedure
      .input(z.object({ retailerId: uuid }))
      .mutation(async ({ input }) => {
        const { syncRetailerData } = await import("./fattureincloud-sync");
        return await syncRetailerData(input.retailerId);
      }),

    getAuthUrl: writerProcedure
      .input(z.object({ retailerId: uuid }))
      .query(async ({ input }) => {
        const { getAuthorizationUrl, getOAuthConfig } = await import(
          "./fattureincloud-oauth"
        );
        const config = getOAuthConfig();
        if (!config) {
          throw new Error(
            "OAuth configuration not available. Please configure FATTUREINCLOUD_CLIENT_ID, FATTUREINCLOUD_CLIENT_SECRET, and FATTUREINCLOUD_REDIRECT_URI in environment variables.",
          );
        }
        const state = JSON.stringify({ retailerId: input.retailerId });
        return { url: getAuthorizationUrl(config, state) };
      }),

    disconnect: writerProcedure
      .input(z.object({ retailerId: uuid }))
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

    getLogs: protectedProcedure
      .input(z.object({ retailerId: uuid, limit: z.number().optional() }))
      .query(async ({ input }) => {
        return await db.getSyncLogsByRetailer(input.retailerId, input.limit || 20);
      }),
  }),
});

export type AppRouter = typeof appRouter;
