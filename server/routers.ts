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

// Date validation: il client invia stringa "YYYY-MM-DD" (form HTML date input).
// Drizzle mappa il tipo `date` Postgres a string in entrambe le direzioni
// (no conversione automatica a Date), quindi qui validiamo come stringa.
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato data atteso YYYY-MM-DD");

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

    /**
     * Phase B M1: rifatto sul nuovo modello.
     *   - `inventory` array popolato da `inventoryByBatch` per la
     *     retailer location, con shape compatibile col vecchio frontend
     *     (id, quantity, expirationDate, batchNumber, product).
     *   - `recentMovements` resta sulla tabella legacy (read-only): in M2
     *     conterrà TRANSFER + RETAIL_OUT, oggi è 0 righe per quasi tutti.
     *   - `stats` ora calcolate su lotti + scadenze del nuovo modello;
     *     `lowStockCount` aggregato per (location, product) confrontato
     *     con `minStockThreshold` di `products`.
     */
    getDetails: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        const retailer = await db.getRetailerById(input.id);
        if (!retailer) return null;

        const inventoryItems = await db.getInventoryByBatchByRetailer(input.id);
        const recentMovements = await db.getStockMovementsByRetailer(input.id, 50);
        const retailerAlerts = await db.getAlertsByRetailer(input.id);

        // Arricchisci movimenti col product (la shape attesa dal frontend
        // RetailerDetail.tsx ha `movement.product?.name`)
        const enrichedMovements = await Promise.all(
          recentMovements.map(async (movement) => {
            const product = await db.getProductById(movement.productId);
            return { ...movement, product };
          }),
        );

        // Calcola stats: aggrega per (productId) per low stock check
        const qtyByProduct = new Map<string, { qty: number; threshold: number }>();
        let totalValue = 0;
        let expiringCount = 0;
        const now = Date.now();

        for (const item of inventoryItems) {
          const price = item.product?.unitPrice
            ? parseFloat(item.product.unitPrice)
            : NaN;
          if (!Number.isNaN(price)) {
            totalValue += price * item.quantity;
          }
          if (item.expirationDate) {
            const days = Math.floor(
              (item.expirationDate.getTime() - now) / 86_400_000,
            );
            if (days > 0 && days <= 30 && item.quantity > 0) expiringCount++;
          }
          if (item.product?.id) {
            const cur = qtyByProduct.get(item.product.id);
            const threshold = item.product.minStockThreshold ?? 10;
            if (cur) cur.qty += item.quantity;
            else qtyByProduct.set(item.product.id, { qty: item.quantity, threshold });
          }
        }

        let lowStockCount = 0;
        for (const v of Array.from(qtyByProduct.values())) {
          if (v.qty < v.threshold) lowStockCount++;
        }

        return {
          retailer,
          inventory: inventoryItems,
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
        // createRetailer crea anche la location associata in transazione.
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

  // ============= PRODUCERS (Phase B M1) =============
  producers: router({
    list: protectedProcedure.query(async () => {
      return await db.getAllProducers();
    }),

    getById: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        return await db.getProducerById(input.id);
      }),

    create: writerProcedure
      .input(
        z.object({
          name: z.string().min(1),
          contactName: z.string().optional(),
          email: z.string().email().optional().or(z.literal("")),
          phone: z.string().optional(),
          address: z.string().optional(),
          vatNumber: z.string().optional(),
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const { email, ...rest } = input;
        return await db.createProducer({
          ...rest,
          email: email && email.length > 0 ? email : undefined,
        });
      }),

    update: writerProcedure
      .input(
        z.object({
          id: uuid,
          name: z.string().min(1).optional(),
          contactName: z.string().optional(),
          email: z.string().email().optional().or(z.literal("")),
          phone: z.string().optional(),
          address: z.string().optional(),
          vatNumber: z.string().optional(),
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const { id, email, ...rest } = input;
        await db.updateProducer(id, {
          ...rest,
          email: email && email.length > 0 ? email : null,
        });
        return { success: true };
      }),

    delete: writerProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        await db.deleteProducer(input.id);
        return { success: true };
      }),
  }),

  // ============= PRODUCT BATCHES (Phase B M1) =============
  productBatches: router({
    listByProduct: protectedProcedure
      .input(z.object({ productId: uuid }))
      .query(async ({ input }) => {
        return await db.getBatchesByProduct(input.productId);
      }),

    /**
     * Crea un lotto + ingresso al magazzino centrale (atomico).
     * Movimento generato: RECEIPT_FROM_PRODUCER.
     */
    create: writerProcedure
      .input(
        z.object({
          productId: uuid,
          producerId: uuid.optional(),
          batchNumber: z.string().min(1),
          expirationDate: dateString,
          productionDate: dateString.optional(),
          initialQuantity: z.number().int().positive(),
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return await db.createBatchWithReceipt({
          productId: input.productId,
          producerId: input.producerId ?? null,
          batchNumber: input.batchNumber,
          expirationDate: input.expirationDate,
          productionDate: input.productionDate ?? null,
          initialQuantity: input.initialQuantity,
          notes: input.notes ?? null,
          createdBy: ctx.user.id,
        });
      }),

    /**
     * Cancellazione consentita solo se il lotto è ancora "intatto"
     * (stock centrale = initialQuantity, nessuna distribuzione).
     */
    delete: writerProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        await db.deleteBatchIfFresh(input.id);
        return { success: true };
      }),
  }),

  // ============= LOCATIONS (Phase B M1) =============
  locations: router({
    list: protectedProcedure.query(async () => {
      return await db.getAllLocations();
    }),

    getCentralWarehouse: protectedProcedure.query(async () => {
      return (await db.getCentralWarehouseLocation()) ?? null;
    }),

    getByRetailer: protectedProcedure
      .input(z.object({ retailerId: uuid }))
      .query(async ({ input }) => {
        return (await db.getRetailerLocation(input.retailerId)) ?? null;
      }),
  }),

  // ============= INVENTORY BY BATCH (Phase B M1) =============
  inventoryByBatch: router({
    listByLocation: protectedProcedure
      .input(z.object({ locationId: uuid }))
      .query(async ({ input }) => {
        return await db.getInventoryByLocationId(input.locationId);
      }),

    listByRetailer: protectedProcedure
      .input(z.object({ retailerId: uuid }))
      .query(async ({ input }) => {
        return await db.getInventoryByBatchByRetailer(input.retailerId);
      }),
  }),

  // ============= WAREHOUSE OVERVIEW (Phase B M1) =============
  warehouse: router({
    getStockOverview: protectedProcedure.query(async () => {
      return await db.getWarehouseStockOverview();
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
  // Phase B M3: refactor in arrivo (single-tenant, multi-provider).
  // Mantenuta in M1 con shape attuale per non rompere
  // FattureInCloudSync.tsx (UI già nascosta in produzione).
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
