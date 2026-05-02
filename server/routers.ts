import { TRPCError } from "@trpc/server";
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
import {
  createFicProforma,
  disconnectFic,
  getFicAuthorizationUrl,
  getFicClients,
  getFicStatus,
  refreshFicClients,
} from "./fic-integration";

const uuid = z.string().uuid();
const userRoleSchema = z.enum(["admin", "operator", "viewer"]);
const vatRateSchema = z.enum(["4.00", "5.00", "10.00", "22.00"]);

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
          recentMovements,
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

    /**
     * Phase B M3: assegna/rimuove pacchetto commerciale.
     * Pre-condition per generazione proforma su TRANSFER.
     */
    assignPackage: writerProcedure
      .input(z.object({ retailerId: uuid, packageId: uuid.nullable() }))
      .mutation(async ({ input }) => {
        if (input.packageId) {
          const pkg = await db.getPricingPackageById(input.packageId);
          if (!pkg) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Pacchetto commerciale non trovato",
            });
          }
        }
        await db.assignPackageToRetailer(input.retailerId, input.packageId);
        return { success: true };
      }),

    /**
     * Phase B M3: associa retailer a cliente FiC (single-tenant).
     * Pre-condition per generazione proforma su TRANSFER.
     */
    assignFicClient: writerProcedure
      .input(
        z.object({
          retailerId: uuid,
          ficClientId: z.number().int().positive().nullable(),
        }),
      )
      .mutation(async ({ input }) => {
        await db.assignFicClientToRetailer(input.retailerId, input.ficClientId);
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
          vatRate: vatRateSchema.optional(),
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
          vatRate: vatRateSchema.optional(),
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

    /**
     * Phase B M2: lotti del prodotto disponibili per trasferimento al
     * retailer indicato (oggi: tutti i lotti con stock centrale > 0
     * ordinati FEFO). Il `retailerId` non altera la lista in M2 ma è
     * presente per estensioni future (es. preferenze per coppia
     * prodotto-retailer).
     */
    suggestForTransfer: protectedProcedure
      .input(z.object({ productId: uuid, retailerId: uuid }))
      .query(async ({ input }) => {
        return await db.getBatchesAvailableForTransfer(input.productId);
      }),
  }),

  // ============= STOCK MOVEMENTS (Phase B M2) =============
  stockMovements: router({
    /**
     * Trasferimento atomico magazzino centrale → retailer.
     *
     * `generateProforma`: oggi sempre rifiutato con 412 (FiC integration
     * arriva in M3). Il flag esiste già nello schema input perché l'UI
     * espone una checkbox disabilitata e mandare true esplicito è un
     * errore della UI (e va segnalato).
     */
    transfer: writerProcedure
      .input(
        z.object({
          productId: uuid,
          batchId: uuid,
          retailerId: uuid,
          quantity: z.number().int().positive(),
          notes: z.string().optional(),
          generateProforma: z.boolean().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        // Phase B M3: se generateProforma=true, valida pre-condizioni PRIMA
        // del transfer. Se mancano dati il movement non parte (no scrittura).
        let retailer: Awaited<ReturnType<typeof db.getRetailerById>> = undefined;
        if (input.generateProforma) {
          retailer = await db.getRetailerById(input.retailerId);
          if (!retailer) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Retailer non trovato" });
          }
          if (!retailer.pricingPackageId) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Pacchetto commerciale non assegnato al rivenditore — assegnalo prima di generare proforma",
            });
          }
          if (!retailer.ficClientId) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Cliente FiC non mappato per questo rivenditore — mappalo prima di generare proforma",
            });
          }
          const fic = await getFicStatus();
          if (!fic.connected) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Fatture in Cloud non connesso — connetti l'integrazione",
            });
          }
        }

        // Esegui il transfer (movement registrato anche se proforma fallisce)
        const movement = await db.transferBatchToRetailer({
          productId: input.productId,
          batchId: input.batchId,
          retailerId: input.retailerId,
          quantity: input.quantity,
          notes: input.notes ?? null,
          createdBy: ctx.user.id,
        });

        if (!input.generateProforma || !retailer || !retailer.ficClientId) {
          return { movement, proforma: null };
        }

        // Calcola pricing + lookup batch info per descrizione FiC
        let pricingResult: Awaited<ReturnType<typeof db.calculatePricingForRetailer>>;
        try {
          pricingResult = await db.calculatePricingForRetailer({
            retailerId: input.retailerId,
            items: [{ productId: input.productId, qty: input.quantity }],
          });
        } catch (e) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: (e as Error).message,
          });
        }

        const batchInfo = await db.getBatchByIdMinimal(input.batchId);
        const batchSuffix = batchInfo
          ? ` — Lotto ${batchInfo.batchNumber}, scad. ${batchInfo.expirationDate}`
          : "";

        const payload = {
          ficClientId: retailer.ficClientId,
          date: new Date().toISOString().slice(0, 10),
          notesInternal: `Generato da TRANSFER ${movement.id}${batchSuffix}`,
          items: pricingResult.items.map((it) => ({
            description: `${it.productName}${batchSuffix}`,
            qty: it.qty,
            unitPriceFinal: it.unitPriceFinal,
            vatRate: it.vatRate,
          })),
        };

        try {
          const proforma = await createFicProforma(payload);
          await db.setStockMovementProforma(movement.id, proforma.id, proforma.number);
          return {
            movement: { ...movement, ficProformaId: proforma.id, ficProformaNumber: proforma.number },
            proforma: { id: proforma.id, number: proforma.number, queued: false },
          };
        } catch (e) {
          // Salva in coda per retry manuale: il movement procede comunque.
          const errMsg = (e as Error).message ?? "FiC API error";
          const queueRow = await db.enqueueProforma({
            transferMovementId: movement.id,
            payload,
            initialError: errMsg,
          });
          return {
            movement,
            proforma: { id: null, number: null, queued: true, queueId: queueRow.id, lastError: errMsg },
          };
        }
      }),

    /**
     * Write-off di stock per lotto scaduto / non più vendibile, sia su
     * magazzino centrale sia presso retailer.
     */
    expiryWriteOff: writerProcedure
      .input(
        z.object({
          batchId: uuid,
          locationId: uuid,
          quantity: z.number().int().positive(),
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return await db.expiryWriteOff({
          batchId: input.batchId,
          locationId: input.locationId,
          quantity: input.quantity,
          notes: input.notes ?? null,
          createdBy: ctx.user.id,
        });
      }),

    listByRetailer: protectedProcedure
      .input(z.object({ retailerId: uuid, limit: z.number().int().optional() }))
      .query(async ({ input }) => {
        return await db.getStockMovementsByRetailer(
          input.retailerId,
          input.limit ?? 100,
        );
      }),

    listByLocation: protectedProcedure
      .input(z.object({ locationId: uuid, limit: z.number().int().optional() }))
      .query(async ({ input }) => {
        return await db.getStockMovementsByLocationId(
          input.locationId,
          input.limit ?? 100,
        );
      }),

    /**
     * Phase B M2.5: lista globale movimenti con filtri + paginazione.
     * Usata dalla pagina /movements.
     */
    listAll: protectedProcedure
      .input(
        z.object({
          type: z
            .enum([
              "IN",
              "OUT",
              "ADJUSTMENT",
              "RECEIPT_FROM_PRODUCER",
              "TRANSFER",
              "EXPIRY_WRITE_OFF",
            ])
            .optional(),
          locationId: uuid.optional(),
          batchSearch: z.string().optional(),
          startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          endDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).optional(),
        }),
      )
      .query(async ({ input }) => {
        return await db.getStockMovementsAll({
          type: input.type,
          locationId: input.locationId,
          batchSearch: input.batchSearch,
          startDate: input.startDate,
          endDate: input.endDate,
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        });
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

  // ============= PRICING PACKAGES (Phase B M3) =============
  pricingPackages: router({
    list: protectedProcedure.query(async () => {
      return await db.getAllPricingPackages();
    }),

    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(1).max(100),
          discountPercent: z.number().min(0).max(100),
          description: z.string().optional(),
          sortOrder: z.number().int().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        return await db.createPricingPackage({
          name: input.name,
          discountPercent: input.discountPercent.toFixed(2),
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? 0,
        });
      }),

    update: adminProcedure
      .input(
        z.object({
          id: uuid,
          name: z.string().min(1).max(100).optional(),
          discountPercent: z.number().min(0).max(100).optional(),
          description: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const { id, discountPercent, ...rest } = input;
        await db.updatePricingPackage(id, {
          ...rest,
          ...(discountPercent !== undefined
            ? { discountPercent: discountPercent.toFixed(2) }
            : {}),
        });
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        await db.deletePricingPackage(input.id);
        return { success: true };
      }),
  }),

  // ============= PRICING CALCULATION (Phase B M3) =============
  pricing: router({
    calculateForRetailer: protectedProcedure
      .input(
        z.object({
          retailerId: uuid,
          items: z
            .array(
              z.object({
                productId: uuid,
                qty: z.number().int().positive(),
              }),
            )
            .min(1),
        }),
      )
      .query(async ({ input }) => {
        try {
          return await db.calculatePricingForRetailer(input);
        } catch (e) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: (e as Error).message,
          });
        }
      }),
  }),

  // ============= FIC INTEGRATION (Phase B M3) =============
  ficIntegration: router({
    getStatus: protectedProcedure.query(async () => {
      return await getFicStatus();
    }),

    startOAuth: adminProcedure
      .input(z.object({ forceLogin: z.boolean().optional() }).optional())
      .query(async ({ input }) => {
        try {
          return { url: getFicAuthorizationUrl({ forceLogin: input?.forceLogin }) };
        } catch (e) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: (e as Error).message,
          });
        }
      }),

    disconnect: adminProcedure.mutation(async () => {
      const result = await disconnectFic();
      return { success: true, deleted: result.deleted };
    }),
  }),

  // ============= FIC CLIENTS CACHE (Phase B M3) =============
  ficClients: router({
    list: protectedProcedure.query(async () => {
      try {
        return await getFicClients(false);
      } catch (e) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: (e as Error).message,
        });
      }
    }),

    refresh: writerProcedure.mutation(async () => {
      try {
        return await refreshFicClients();
      } catch (e) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: (e as Error).message,
        });
      }
    }),
  }),

  // ============= PROFORMA QUEUE (Phase B M3) =============
  proformaQueue: router({
    list: protectedProcedure
      .input(
        z
          .object({
            status: z.enum(["pending", "processing", "success", "failed"]).optional(),
          })
          .optional(),
      )
      .query(async ({ input }) => {
        return await db.getProformaQueueList({ status: input?.status });
      }),

    getByMovement: protectedProcedure
      .input(z.object({ movementId: uuid }))
      .query(async ({ input }) => {
        return (await db.getProformaQueueByMovement(input.movementId)) ?? null;
      }),

    /**
     * Retry MANUALE: ritenta la generazione proforma per la riga in coda.
     * Se la chiamata FiC ha successo: aggiorna lo stockMovement con
     * id/number proforma, marca queue=success.
     * Se fallisce: incrementa attempts, aggiorna lastError, status=failed.
     * Se attempts >= maxAttempts: rifiuta con 412 (l'admin deve cancellare
     * o investigare manualmente).
     */
    retry: writerProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        const list = await db.getProformaQueueList();
        const row = list.find((r) => r.id === input.id);
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Riga in coda non trovata" });
        }
        if (row.status === "success") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Proforma già generata — niente da ritentare",
          });
        }
        if (row.attempts >= row.maxAttempts) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Max attempts (${row.maxAttempts}) raggiunto — investiga il problema o cancella la riga`,
          });
        }

        await db.markProformaQueueProcessing(row.id);
        try {
          const payload = row.payload as Parameters<typeof createFicProforma>[0];
          const proforma = await createFicProforma(payload);
          await db.setStockMovementProforma(
            row.transferMovementId,
            proforma.id,
            proforma.number,
          );
          await db.markProformaQueueSuccess(row.id);
          return {
            success: true,
            proformaId: proforma.id,
            proformaNumber: proforma.number,
          };
        } catch (e) {
          const errMsg = (e as Error).message ?? "FiC API error";
          await db.markProformaQueueFailed(row.id, errMsg);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Retry fallito: ${errMsg}`,
          });
        }
      }),

    delete: writerProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        const dbRef = await db.getDb();
        if (!dbRef) throw new Error("Database not available");
        const { proformaQueue: pq } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        await dbRef.delete(pq).where(eq(pq.id, input.id));
        return { success: true };
      }),
  }),

  // ============= FATTURE IN CLOUD SYNC =============
  // Phase B M3: refactor in arrivo (single-tenant, multi-provider).
  // Mantenuta in M1 con shape attuale per non rompere
  // FattureInCloudSync.tsx (UI già nascosta in produzione).
  sync: router({
    /**
     * Phase B M2: disabilitata in attesa del refactor FiC single-tenant
     * (Milestone 3). La tabella `inventory` legacy è stata droppata e gli
     * helper `db.upsertInventory`/`getInventoryItem` rimossi: una sync ora
     * fallirebbe silenziosamente. Risposta 412 esplicita per chiunque la
     * chiamasse via UI residua o API direct.
     */
    syncRetailer: writerProcedure
      .input(z.object({ retailerId: uuid }))
      .mutation(async () => {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Sincronizzazione FiC temporaneamente disabilitata — refactor architetturale in corso (Milestone 3)",
        });
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
