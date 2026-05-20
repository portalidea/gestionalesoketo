import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import {
  adminProcedure,
  protectedProcedure,
  staffProcedure,
  publicProcedure,
  router,
  writerProcedure,
} from "./_core/trpc";
import { supabaseAdmin } from "./_core/supabase";
import { ENV } from "./_core/env";
import * as db from "./db";
import {
  createFicProforma,
  disconnectFic,
  getFicAuthorizationUrl,
  getFicClients,
  getFicStatus,
  refreshFicClients,
} from "./fic-integration";
import { ddtImportsRouter } from "./ddt-imports-router";
import { retailerPortalRouter } from "./retailer-portal-router";
import { ordersRouter } from "./orders-router";
import { catalogPortalRouter } from "./catalog-portal-router";
import { retailerCheckoutRouter } from "./retailer-checkout-router";
import { retailerOrdersRouter } from "./retailer-orders-router";
import { retailerSelfServiceRouter } from "./retailer-selfservice-router";
import { affiliatesRouter } from "./affiliates-router";
import { affiliatePortalRouter } from "./affiliate-portal-router";
import { shopifyRouter } from "./shopify-router";
import { reportsRouter } from "./reports-router";


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
        // M6.1.4: createUser + generateLink + customMagicUrl (no supabase.co URL)
        const { data: authData, error: authError } =
          await supabaseAdmin.auth.admin.createUser({
            email: input.email,
            email_confirm: false,
            user_metadata: { role: input.role },
          });

        let userId: string | null = null;
        if (authError && authError.message.includes('already')) {
          // Utente già esiste in auth, recupera ID
          const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
          const existing = listData?.users?.find(
            (u) => u.email?.toLowerCase() === input.email.toLowerCase(),
          );
          userId = existing?.id ?? null;
        } else if (authError) {
          throw new Error(`Failed to create user: ${authError.message}`);
        } else {
          userId = authData!.user.id;
        }

        // Aggiorna role se diverso da default trigger
        if (input.role !== "operator" && userId) {
          await db.updateUserRole(userId, input.role);
        }

        // Genera magic link con URL custom
        const { data: linkData, error: linkError } =
          await supabaseAdmin.auth.admin.generateLink({
            type: "magiclink",
            email: input.email,
          });

        if (!linkError && linkData?.properties?.hashed_token) {
          const tokenHash = linkData.properties.hashed_token;
          const baseUrl = ENV.publicAppUrl;
          const customMagicUrl = `${baseUrl}/auth/verify` +
            `?token_hash=${encodeURIComponent(tokenHash)}` +
            `&type=magiclink` +
            `&email=${encodeURIComponent(input.email)}`;

          // Invia email invito staff
          const { sendEmail } = await import("./email");
          await sendEmail({
            to: input.email,
            subject: "Invito al gestionale SoKeto",
            html: `<p>Sei stato invitato al gestionale SoKeto come <strong>${input.role}</strong>.</p>
                   <p><a href="${customMagicUrl}" style="display:inline-block;background:#2D5A27;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Accedi al gestionale</a></p>
                   <p style="color:#666;font-size:13px;">Se non hai richiesto questo invito, ignora questa email.</p>`,
          });
        }

        return { success: true, userId };
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

    /**
     * M10: Invia link "imposta password" a tutti gli utenti esistenti.
     * Da usare una tantum dopo la migrazione da magic-link a email+password.
     */
    sendSetPasswordToAll: adminProcedure
      .mutation(async () => {
        const allUsers = await db.getAllUsers();
        const results: { email: string; status: string }[] = [];
        const baseUrl = ENV.publicAppUrl;
        for (const u of allUsers) {
          try {
            const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(
              u.email,
              { redirectTo: `${baseUrl}/reset-password` },
            );
            if (resetError) {
              results.push({ email: u.email, status: `errore: ${resetError.message}` });
            } else {
              results.push({ email: u.email, status: "inviato" });
            }
          } catch (e: any) {
            results.push({ email: u.email, status: `errore: ${e.message}` });
          }
        }
        return results;
      }),
  }),

  // ============= RETAILERS =============
  retailers: router({
    list: staffProcedure.query(async () => {
      return await db.getAllRetailers();
    }),

    getById: staffProcedure
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
    getDetails: staffProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        // M3.0.8 perf timing: timestamp ogni step. Log solo se total >500ms.
        const tAll = Date.now();
        const t0 = Date.now();
        const retailer = await db.getRetailerById(input.id);
        const tRetailer = Date.now() - t0;
        if (!retailer) return null;

        const t1 = Date.now();
        const inventoryItems = await db.getInventoryByBatchByRetailer(input.id);
        const tInv = Date.now() - t1;
        const t2 = Date.now();
        const recentMovements = await db.getStockMovementsByRetailer(input.id, 50);
        const tMov = Date.now() - t2;
        const t3 = Date.now();
        const retailerAlerts = await db.getAlertsByRetailer(input.id);
        const tAlerts = Date.now() - t3;
        const tTotal = Date.now() - tAll;
        if (tTotal > 500) {
          console.log(
            `[retailers.getDetails] retailer=${tRetailer}ms inv=${tInv}ms mov=${tMov}ms alerts=${tAlerts}ms total=${tTotal}ms`,
          );
        }

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
          // M3.0.6: ficClientId in creazione (workflow "import da FiC")
          ficClientId: z.number().int().positive().optional(),
          // M7-A: affiliato opzionale in creazione
          affiliateId: z.string().uuid().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        // Se affiliateId è presente, setta anche affiliateAssignedAt
        const createData: any = { ...input };
        if (input.affiliateId) {
          createData.affiliateAssignedAt = new Date();
        }
        return await db.createRetailer(createData);
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

    dependentsCount: staffProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        const t0 = Date.now();
        console.log('[dependentsCount] start', { retailerId: input.id });
        const r = await db.getRetailerDependentsCount(input.id);
        const totalMs = Date.now() - t0;
        console.log('[dependentsCount] DONE', { ...r, total_ms: totalMs });
        return r;
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
    /**
     * M7-A: Assegna/rimuovi affiliato a retailer.
     */
    assignAffiliate: writerProcedure
      .input(
        z.object({
          retailerId: uuid,
          affiliateId: z.string().uuid().nullable(),
        }),
      )
      .mutation(async ({ input }) => {
        const database = (await db.getDb())!;
        const { eq: eqOp } = await import("drizzle-orm");
        const { retailers: retailersTable } = await import("../drizzle/schema");
        const updateData: Record<string, any> = {
          affiliateId: input.affiliateId,
          affiliateAssignedAt: input.affiliateId ? new Date() : null,
          updatedAt: new Date(),
        };
        await database.update(retailersTable).set(updateData).where(eqOp(retailersTable.id, input.retailerId));
        return { success: true };
      }),
  }),

  // ============= PRODUCTS =============
  products: router({
    list: staffProcedure.query(async () => {
      return await db.getAllProducts();
    }),

    getById: staffProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input }) => {
        return await db.getProductById(input.id);
      }),

    getBySku: staffProcedure
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
          piecesPerUnit: z.number().min(1).optional(),
          sellableUnitLabel: z.string().optional(),
          costPrice: z.string().optional(), // M6.2.E: costo unitario standard
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
          piecesPerUnit: z.number().min(1).optional(),
          sellableUnitLabel: z.string().optional(),
          costPrice: z.string().optional(), // M6.2.E: costo unitario standard
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

    /**
     * M5.5: Crea prodotto con codici fornitore e lotto iniziale opzionale.
     * Transazione atomica: product + supplier codes + batch + inventory + movement.
     */
    createExtended: writerProcedure
      .input(
        z.object({
          sku: z.string().min(1),
          name: z.string().min(1),
          description: z.string().optional(),
          category: z.string().optional(),
          supplierName: z.string().optional(),
          unitPrice: z.string().optional(),
          unit: z.string().optional(),
          minStockThreshold: z.number().optional(),
          expiryWarningDays: z.number().optional(),
          vatRate: vatRateSchema.optional(),
          imageUrl: z.string().optional(),
          piecesPerUnit: z.number().min(1).optional(),
          sellableUnitLabel: z.string().optional(),
          costPrice: z.string().optional(), // M6.2.E
          supplierCodes: z
            .array(
              z.object({
                producerId: uuid,
                supplierCode: z.string().min(1),
              }),
            )
            .optional()
            .default([]),
          initialBatch: z
            .object({
              producerId: uuid,
              batchNumber: z.string().min(1),
              expirationDate: dateString,
              quantity: z.number().int().positive(),
              costPrice: z.string().optional(), // M6.2.E: costo lotto
            })
            .optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const { supplierCodes, initialBatch, ...productFields } = input;

        // Resolve central warehouse for initial batch
        let warehouseId: string | undefined;
        if (initialBatch) {
          const warehouse = await db.getCentralWarehouseLocation();
          if (!warehouse) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Magazzino centrale non configurato",
            });
          }
          warehouseId = warehouse.id;
        }

        return await db.createProductExtended({
          productData: {
            ...productFields,
            isLowCarb: 1,
            isGlutenFree: 1,
            isKeto: 1,
            sugarContent: "0%",
          },
          supplierCodes,
          initialBatch: initialBatch && warehouseId
            ? {
                ...initialBatch,
                locationId: warehouseId,
              }
            : undefined,
          createdBy: ctx.user.id,
        });
      }),

    // M5.5: CRUD codici fornitore
    getSupplierCodes: staffProcedure
      .input(z.object({ productId: uuid }))
      .query(async ({ input }) => {
        return await db.getSupplierCodesByProduct(input.productId);
      }),

    addSupplierCode: writerProcedure
      .input(
        z.object({
          productId: uuid,
          producerId: uuid,
          supplierCode: z.string().min(1),
        }),
      )
      .mutation(async ({ input }) => {
        return await db.addSupplierCode(input);
      }),

    removeSupplierCode: writerProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input }) => {
        await db.removeSupplierCode(input.id);
        return { success: true };
      }),
  }),

  // ============= PRODUCERS (Phase B M1) =============
  producers: router({
    list: staffProcedure.query(async () => {
      return await db.getAllProducers();
    }),

    getById: staffProcedure
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
    listByProduct: staffProcedure
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
          costPrice: z.string().optional(), // M6.2.E
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
          costPrice: input.costPrice,
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
    suggestForTransfer: staffProcedure
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
          totalGross: parseFloat(pricingResult.total),
          notesInternal: `Generato da TRANSFER ${movement.id}${batchSuffix}`,
          items: pricingResult.items.map((it) => ({
            code: it.productSku,
            name: it.productName,
            description: batchSuffix ? batchSuffix.trim() : "",
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

    listByRetailer: staffProcedure
      .input(z.object({ retailerId: uuid, limit: z.number().int().optional() }))
      .query(async ({ input }) => {
        return await db.getStockMovementsByRetailer(
          input.retailerId,
          input.limit ?? 100,
        );
      }),

    listByLocation: staffProcedure
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
    listAll: staffProcedure
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
    list: staffProcedure.query(async () => {
      return await db.getAllLocations();
    }),

    getCentralWarehouse: staffProcedure.query(async () => {
      return (await db.getCentralWarehouseLocation()) ?? null;
    }),

    getByRetailer: staffProcedure
      .input(z.object({ retailerId: uuid }))
      .query(async ({ input }) => {
        return (await db.getRetailerLocation(input.retailerId)) ?? null;
      }),
  }),

  // ============= INVENTORY BY BATCH (Phase B M1) =============
  inventoryByBatch: router({
    listByLocation: staffProcedure
      .input(z.object({ locationId: uuid }))
      .query(async ({ input }) => {
        return await db.getInventoryByLocationId(input.locationId);
      }),

    listByRetailer: staffProcedure
      .input(z.object({ retailerId: uuid }))
      .query(async ({ input }) => {
        return await db.getInventoryByBatchByRetailer(input.retailerId);
      }),
  }),

  // ============= WAREHOUSE OVERVIEW (Phase B M1) =============
  warehouse: router({
    getStockOverview: staffProcedure.query(async () => {
      return await db.getWarehouseStockOverview();
    }),
    /**
     * M8.2: Valore magazzino overview — stat cards.
     * Calcola valore al costo, al listino, margine, scadenze imminenti.
     * costPrice = products.costPrice (costo unitario standard IVA esclusa)
     * listPrice = products.unitPrice (varchar, prezzo base catalogo)
     */
    getValueOverview: staffProcedure.query(async () => {
      const startTime = Date.now();
      const database = await db.getDb();
      if (!database) return null;
      const { sql } = await import("drizzle-orm");
      const rows = await database.execute(sql`
        SELECT
          COALESCE(SUM(ibb."quantity"), 0)::int AS "totalUnits",
          COALESCE(SUM(ibb."quantity" * p."costPrice"::numeric), 0)::numeric(18,2) AS "totalValueAtCost",
          COALESCE(SUM(
            ibb."quantity" * COALESCE(NULLIF(p."unitPrice", '')::numeric, 0) / COALESCE(p."piecesPerUnit", 1)
          ), 0)::numeric(18,2) AS "totalValueAtListPrice",
          COUNT(DISTINCT p."id")::int AS "uniqueProductsCount",
          COUNT(DISTINCT pb."id")::int AS "activeBatchesCount"
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'central_warehouse'
        WHERE ibb."quantity" > 0
      `);

      const expRows = await database.execute(sql`
        SELECT
          COALESCE(SUM(ibb."quantity"), 0)::int AS "expiringSoonUnits",
          COALESCE(SUM(ibb."quantity" * p."costPrice"::numeric), 0)::numeric(18,2) AS "expiringSoonValue"
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'central_warehouse'
        WHERE ibb."quantity" > 0
          AND pb."expirationDate" IS NOT NULL
          AND pb."expirationDate" < NOW() + INTERVAL '30 days'
          AND pb."expirationDate" > NOW()
      `);

      const r = (rows as any[])[0] || {};
      const e = (expRows as any[])[0] || {};

      const totalValueAtCost = parseFloat(r.totalValueAtCost || "0");
      const totalValueAtListPrice = parseFloat(r.totalValueAtListPrice || "0");
      const potentialMargin = totalValueAtListPrice - totalValueAtCost;
      const potentialMarginPercent = totalValueAtListPrice > 0
        ? (potentialMargin / totalValueAtListPrice) * 100
        : 0;

      const elapsed = Date.now() - startTime;
      console.log(`[warehouse.getValueOverview] computed in ${elapsed}ms`);

      return {
        totalUnits: Number(r.totalUnits || 0),
        totalValueAtCost,
        totalValueAtListPrice,
        potentialMargin,
        potentialMarginPercent,
        uniqueProductsCount: Number(r.uniqueProductsCount || 0),
        activeBatchesCount: Number(r.activeBatchesCount || 0),
        expiringSoonValue: parseFloat(e.expiringSoonValue || "0"),
        expiringSoonUnits: Number(e.expiringSoonUnits || 0),
      };
    }),
    /**
     * M6.2.E: Valorizzazione magazzino — solo admin.
     * Calcola valore totale stock centrale usando costPrice dei lotti
     * (fallback su costPrice prodotto se lotto ha costPrice = 0).
     */
    getValuation: adminProcedure.query(async () => {
      const database = await db.getDb();
      if (!database) return { totalValue: "0", totalUnits: 0, products: [] };
      const { sql } = await import("drizzle-orm");
      const rows = await database.execute(sql`
        SELECT
          p."id" AS "productId",
          p."name" AS "productName",
          p."sku",
          p."costPrice" AS "productCostPrice",
          COALESCE(SUM(ibb."quantity"), 0)::int AS "totalStock",
          COALESCE(SUM(
            ibb."quantity" * COALESCE(
              NULLIF(pb."costPrice"::numeric, 0),
              p."costPrice"::numeric
            )
          ), 0)::numeric(18,2) AS "value"
        FROM "products" p
        INNER JOIN "productBatches" pb ON pb."productId" = p."id"
        INNER JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb."id"
        INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'central_warehouse'
        WHERE ibb."quantity" > 0
        GROUP BY p."id", p."name", p."sku", p."costPrice"
        ORDER BY "value" DESC
      `);
      const products = (rows as any[]).map((r: any) => ({
        productId: r.productId,
        productName: r.productName,
        sku: r.sku,
        productCostPrice: String(r.productCostPrice),
        totalStock: Number(r.totalStock),
        value: String(r.value),
      }));
      const totalValue = products.reduce((sum, p) => sum + parseFloat(p.value || "0"), 0).toFixed(2);
      const totalUnits = products.reduce((sum, p) => sum + p.totalStock, 0);
      return { totalValue, totalUnits, products };
    }),

    // M8.5: Rettifica manuale quantità lotto
    adjustBatchQuantity: staffProcedure
      .input(z.object({
        batchId: z.string().uuid(),
        locationId: z.string().uuid(),
        newQuantity: z.number().int().min(0),
        reason: z.enum([
          'physical_count',
          'not_inventoried',
          'breakage',
          'registration_error',
          'other',
        ]),
        notes: z.string().max(500).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const database = await db.getDb();
        if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
        const { eq, and } = await import("drizzle-orm");
        const { inventoryByBatch, productBatches, stockMovements } = await import("../drizzle/schema");

        return await database.transaction(async (tx) => {
          // 1. Lock riga inventoryByBatch
          const invRows = await tx
            .select()
            .from(inventoryByBatch)
            .where(and(
              eq(inventoryByBatch.batchId, input.batchId),
              eq(inventoryByBatch.locationId, input.locationId),
            ))
            .for("update")
            .limit(1);
          const inv = invRows[0] ?? null;

          // 2. Recupera productId dal batch
          const batchRows = await tx
            .select({ productId: productBatches.productId, batchNumber: productBatches.batchNumber })
            .from(productBatches)
            .where(eq(productBatches.id, input.batchId))
            .limit(1);
          const batch = batchRows[0];
          if (!batch) throw new TRPCError({ code: "NOT_FOUND", message: "Lotto non trovato" });

          const previousQuantity = inv?.quantity ?? 0;
          const newQuantity = input.newQuantity;
          const delta = newQuantity - previousQuantity;

          if (delta === 0) {
            return { success: true, previousQuantity, newQuantity, delta: 0, message: "Nessuna modifica" };
          }

          // 3. Aggiorna o crea riga inventoryByBatch
          if (inv) {
            await tx
              .update(inventoryByBatch)
              .set({ quantity: newQuantity, updatedAt: new Date() })
              .where(eq(inventoryByBatch.id, inv.id));
          } else {
            await tx.insert(inventoryByBatch).values({
              batchId: input.batchId,
              locationId: input.locationId,
              quantity: newQuantity,
            });
          }

          // 4. Registra movimento ADJUSTMENT
          const reasonLabels: Record<string, string> = {
            physical_count: 'Conta fisica',
            not_inventoried: 'Prodotto non inventariato',
            breakage: 'Rottura/Scarto',
            registration_error: 'Errore registrazione',
            other: 'Altro',
          };
          const reasonLabel = reasonLabels[input.reason] ?? input.reason;
          const fullNote = input.notes
            ? `${reasonLabel}: ${input.notes}`
            : reasonLabel;

          await tx.insert(stockMovements).values({
            productId: batch.productId,
            batchId: input.batchId,
            type: 'ADJUSTMENT',
            quantity: Math.abs(delta),
            previousQuantity,
            newQuantity,
            sourceDocumentType: 'manual_adjustment',
            sourceDocument: null,
            notes: `${fullNote} (lotto ${batch.batchNumber})`,
            createdBy: ctx.user?.id ?? null,
          });

          console.log(`[warehouse.adjustBatchQuantity] batchId=${input.batchId} ${previousQuantity}\u2192${newQuantity} (\u0394${delta}) reason=${input.reason}`);

          return { success: true, previousQuantity, newQuantity, delta };
        });
      }),
  }),

  // ============= ALERTS =============
  alerts: router({
    getActive: staffProcedure.query(async () => {
      console.time("[alerts.getActive]");
      const result = await db.getActiveAlerts();
      console.timeEnd("[alerts.getActive]");
      return result;
    }),

    getByRetailer: staffProcedure
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
  // Cache TTL 2 min implementata in db.ts per mantenere i tipi tRPC
  dashboard: router({
    getStats: staffProcedure.query(async () => {
      console.time("[dashboard.getStats]");
      const result = await db.getDashboardStats();
      console.timeEnd("[dashboard.getStats]");
      return result;
    }),
    getStockAlerts: staffProcedure.query(async () => {
      console.time("[dashboard.getStockAlerts]");
      const result = await db.getProductsUnderThreshold(20);
      console.timeEnd("[dashboard.getStockAlerts]");
      return result;
    }),
    getExpiringBatches: staffProcedure.query(async () => {
      console.time("[dashboard.getExpiringBatches]");
      const result = await db.getExpiringBatches(20);
      console.timeEnd("[dashboard.getExpiringBatches]");
      return result;
    }),
  }),

  // ============= PRICING PACKAGES (Phase B M3) =============
  pricingPackages: router({
    list: staffProcedure.query(async () => {
      const t0 = Date.now();
      console.log('[pricingPackages.list] start');
      const r = await db.getAllPricingPackages();
      const totalMs = Date.now() - t0;
      console.log('[pricingPackages.list] DONE', { count: r.length, total_ms: totalMs });
      return r;
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
    calculateForRetailer: staffProcedure
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
    getStatus: staffProcedure.query(async () => {
      const t = Date.now();
      const r = await getFicStatus();
      const ms = Date.now() - t;
      if (ms > 500) console.log(`[ficIntegration.getStatus] ${ms}ms`);
      return r;
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
    list: staffProcedure.query(async () => {
      const t = Date.now();
      try {
        const r = await getFicClients(false);
        const ms = Date.now() - t;
        if (ms > 500) console.log(`[ficClients.list] ${ms}ms count=${r.clients.length}`);
        return r;
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
    list: staffProcedure
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

    getByMovement: staffProcedure
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

    getLogs: staffProcedure
      .input(z.object({ retailerId: uuid, limit: z.number().optional() }))
      .query(async ({ input }) => {
        return await db.getSyncLogsByRetailer(input.retailerId, input.limit || 20);
      }),
  }),

  // ============= DDT IMPORTS (Phase B M5) =============
  ddtImports: ddtImportsRouter,

  // ============= ORDERS (Phase B M6.2.A) =============
  orders: ordersRouter,

  // ============= RETAILER PORTAL (Phase B M6.1) =============
  retailerPortal: retailerPortalRouter,

  // ============= M6.2.B — PORTALE RETAILER SELF-SERVICE =============
  catalogPortal: catalogPortalRouter,
  retailerCheckout: retailerCheckoutRouter,
  retailerOrders: retailerOrdersRouter,

  // ============= M6.2.B Parte B — PORTALE RETAILER SELF-SERVICE =============
  retailerSelfService: retailerSelfServiceRouter,

  // ============= M7-A — AFFILIATI =============
  affiliates: affiliatesRouter,

  // ============= M7-B — PORTALE AFFILIATI =============
  affiliatePortal: affiliatePortalRouter,

  // ============= M8.1 — SHOPIFY MARKETPLACE =============
  shopify: shopifyRouter,
  // ============= M9 — REPORTS =============
  reports: reportsRouter,
});

export type AppRouter = typeof appRouter;
