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
  createFicProformaForCompany,
  disconnectFic,
  disconnectFicForCompany,
  getFicAuthorizationUrl,
  getFicAuthorizationUrlForCompany,
  getCachedFicClients,
  getFicStatus,
  getFicStatusForCompany,
  refreshFicClientsForCompany,
  getRetailerFicClientId,
  syncRetailerFicMappings,
  getActiveFicConnection,
  getFicConnection,
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
import { inventoryExportRouter } from "./inventory-export-router";
import { companiesRouter } from "./companies-router";
import { uuidSchema } from "../shared/schemas";

const uuid = uuidSchema;
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
        if (ctx.user!.id === input.id && input.role !== "admin") {
          throw new Error("Cannot demote yourself from admin");
        }
        await db.updateUserRole(input.id, input.role);
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user!.id === input.id) {
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

    /**
     * M10: Invia link "imposta password" a un singolo utente.
     */
    sendSetPasswordToUser: adminProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => {
        const baseUrl = ENV.publicAppUrl;
        const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(
          input.email,
          { redirectTo: `${baseUrl}/reset-password` },
        );
        if (resetError) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Errore invio a ${input.email}: ${resetError.message}`,
          });
        }
        return { email: input.email, status: "inviato" };
      }),
  }),
  // ============= RETAILERS =============
  retailers: router({
    list: staffProcedure.query(async ({ ctx }) => {
      return await db.getAllRetailers(ctx.activeCompanyId);
    }),

    getById: staffProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ input, ctx }) => {
        return await db.getRetailerById(input.id, ctx.activeCompanyId);
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
      .query(async ({ input, ctx }) => {
        // M3.0.8 perf timing: timestamp ogni step. Log solo se total >500ms.
        const tAll = Date.now();
        const t0 = Date.now();
        const retailer = await db.getRetailerById(input.id, ctx.activeCompanyId);
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
          notes: z.string().optional(),
          // M7-A: affiliato opzionale in creazione
          affiliateId: uuidSchema.optional(),
          // M11.A.markup: pricing model
          pricingModel: z.enum(["tier_discount", "cost_markup"]).default("tier_discount"),
          markupPercentage: z.number().min(0).max(100).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        // Se affiliateId è presente, setta anche affiliateAssignedAt
        const createData: any = {
          ...input,
          companyId: ctx.activeCompanyId, // M11.A
          // M11.A.markup: serialize markupPercentage
          markupPercentage: input.markupPercentage != null ? String(input.markupPercentage) : null,
        };
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
          syncEnabled: z.number().optional(),
          notes: z.string().optional(),
          // M11.A.markup: pricing model
          pricingModel: z.enum(["tier_discount", "cost_markup"]).optional(),
          markupPercentage: z.number().min(0).max(100).nullish(),
        }),
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        // M11.A.markup: serialize markupPercentage
        const updateData: any = { ...data };
        if (data.markupPercentage !== undefined) {
          updateData.markupPercentage = data.markupPercentage != null ? String(data.markupPercentage) : null;
        }
        await db.updateRetailer(id, updateData);
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
    /**
     * M11.C: assignFicClient ora scrive su retailerFicMapping per-company.
     * Mantiene backward-compat per UI legacy.
     */
    assignFicClient: writerProcedure
      .input(
        z.object({
          retailerId: uuid,
          ficClientId: z.number().int().positive().nullable(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const { retailerFicMapping } = await import("../drizzle/schema");
        const { eq: eqFn, and: andFn } = await import("drizzle-orm");
        const db2 = await db.getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
        if (input.ficClientId === null) {
          // Rimuovi mapping
          await db2.delete(retailerFicMapping).where(
            andFn(
              eqFn(retailerFicMapping.retailerId, input.retailerId),
              eqFn(retailerFicMapping.companyId, ctx.activeCompanyId),
            ),
          );
        } else {
          // Upsert mapping
          await db2.insert(retailerFicMapping).values({
            retailerId: input.retailerId,
            companyId: ctx.activeCompanyId,
            ficClientId: input.ficClientId,
          }).onConflictDoUpdate({
            target: [retailerFicMapping.retailerId, retailerFicMapping.companyId],
            set: { ficClientId: input.ficClientId, updatedAt: new Date() },
          });
        }
        return { success: true };
      }),
    /**
     * M7-A: Assegna/rimuovi affiliato a retailer.
     */
    assignAffiliate: writerProcedure
      .input(
        z.object({
          retailerId: uuid,
          affiliateId: uuidSchema.nullable(),
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
          createdBy: ctx.user!.id,
          companyId: ctx.activeCompanyId, // M11.A
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
     * M6.2.F: Controlla se un lotto con lo stesso batchNumber esiste già.
     * Restituisce 'new', 'merge' o 'conflict'.
     */
    checkLotConflict: staffProcedure
      .input(
        z.object({
          productId: uuid,
          batchNumber: z.string().min(1),
          expirationDate: dateString,
          producerId: uuid.nullable(),
        }),
      )
      .query(async ({ input }) => {
        return await db.checkLotConflict({
          productId: input.productId,
          batchNumber: input.batchNumber,
          expirationDate: input.expirationDate,
          producerId: input.producerId,
        });
      }),
    /**
     * Crea un lotto + ingresso al magazzino centrale (atomico).
     * Movimento generato: RECEIPT_FROM_PRODUCER.
     * Se mergeWithBatchId è presente, incrementa il lotto esistente.
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
          mergeWithBatchId: uuid.optional(), // M6.2.F: merge
        }),
      )
      .mutation(async ({ input, ctx }) => {
        // M6.2.F: Smart merge
        if (input.mergeWithBatchId) {
          const conflict = await db.checkLotConflict({
            productId: input.productId,
            batchNumber: input.batchNumber,
            expirationDate: input.expirationDate,
            producerId: input.producerId ?? null,
          });
          if (conflict.status !== "merge" || conflict.batch.id !== input.mergeWithBatchId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Lotto target non corrisponde. Ricarica e riprova.",
            });
          }
          const result = await db.mergeBatchReceipt({
            batchId: input.mergeWithBatchId,
            productId: input.productId,
            quantity: input.initialQuantity,
            costPrice: input.costPrice,
            notes: input.notes ?? null,
            createdBy: ctx.user!.id,
            companyId: ctx.activeCompanyId, // M11.A
          });
          return { id: input.mergeWithBatchId, merged: true, newQuantity: result.newQuantity } as any;
        }
        // Standard flow: create new batch
        try {
          return await db.createBatchWithReceipt({
            productId: input.productId,
            producerId: input.producerId ?? null,
            batchNumber: input.batchNumber,
            expirationDate: input.expirationDate,
            productionDate: input.productionDate ?? null,
            initialQuantity: input.initialQuantity,
            costPrice: input.costPrice,
            notes: input.notes ?? null,
            createdBy: ctx.user!.id,
            companyId: ctx.activeCompanyId, // M11.A
          });
        } catch (err: any) {
          if (err?.code === "23505" || err?.message?.includes("unique") || err?.message?.includes("duplicate")) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Lotto duplicato. Usa il flow di merge per aggiungere quantit\u00e0 a un lotto esistente.",
            });
          }
          throw err;
        }
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
          // M11.C: verifica ficClientId via retailerFicMapping
          const transferFicClientId = await getRetailerFicClientId(input.retailerId, ctx.activeCompanyId);
          if (!transferFicClientId) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Cliente FiC non mappato per questo rivenditore — configura il mapping in Impostazioni → Integrazioni",
            });
          }
          const fic = await getFicStatusForCompany(ctx.activeCompanyId);
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
          createdBy: ctx.user!.id,
          companyId: ctx.activeCompanyId, // M11.A
        });

        if (!input.generateProforma) {
          return { movement, proforma: null };
        }

        // M11.C: recupera ficClientId per-company
        const ficClientIdForProforma = await getRetailerFicClientId(input.retailerId, ctx.activeCompanyId);
        if (!ficClientIdForProforma) {
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
          ficClientId: ficClientIdForProforma,
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
          const proforma = await createFicProformaForCompany(ctx.activeCompanyId, payload);
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
          createdBy: ctx.user!.id,
          companyId: ctx.activeCompanyId, // M11.A
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
    list: staffProcedure.query(async ({ ctx }) => {
      return await db.getAllLocations(ctx.activeCompanyId);
    }),

    getCentralWarehouse: staffProcedure.query(async ({ ctx }) => {
      return (await db.getCentralWarehouseLocation(ctx.activeCompanyId)) ?? null;
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
    getStockOverview: staffProcedure.query(async ({ ctx }) => {
      return await db.getWarehouseStockOverview(ctx.activeCompanyId);
    }),
    /**
     * M8.2: Valore magazzino overview — stat cards.
     * Calcola valore al costo, al listino, margine, scadenze imminenti.
     * costPrice = products.costPrice (costo unitario standard IVA esclusa)
     * listPrice = products.unitPrice (varchar, prezzo base catalogo)
     */
    getValueOverview: staffProcedure.query(async ({ ctx }) => {
      const startTime = Date.now();
      const database = await db.getDb();
      if (!database) return null;
      const { sql } = await import("drizzle-orm");
      const companyFilter = ctx.activeCompanyId ? sql` AND l."companyId" = ${ctx.activeCompanyId}::uuid` : sql``;
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
        INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'central_warehouse'${companyFilter}
        WHERE ibb."quantity" > 0
      `);

      const expRows = await database.execute(sql`
        SELECT
          COALESCE(SUM(ibb."quantity"), 0)::int AS "expiringSoonUnits",
          COALESCE(SUM(ibb."quantity" * p."costPrice"::numeric), 0)::numeric(18,2) AS "expiringSoonValue"
        FROM "inventoryByBatch" ibb
        INNER JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        INNER JOIN "products" p ON p."id" = pb."productId"
        INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'central_warehouse'${companyFilter}
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
    getValuation: adminProcedure.query(async ({ ctx }) => {
      const database = await db.getDb();
      if (!database) return { totalValue: "0", totalUnits: 0, products: [] };
      const { sql } = await import("drizzle-orm");
      const companyFilter = ctx.activeCompanyId ? sql` AND l."companyId" = ${ctx.activeCompanyId}::uuid` : sql``;
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
        INNER JOIN "locations" l ON l."id" = ibb."locationId" AND l."type" = 'central_warehouse'${companyFilter}
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
        batchId: uuidSchema,
        locationId: uuidSchema,
        newQuantity: z.number().int().min(0),
        reason: z.enum([
          'typo',
          'recount',
          'damage',
          'loss',
          'found',
          'other',
        ]),
        notes: z.string().max(500).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const database = await db.getDb();
        if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
        const { eq, and } = await import("drizzle-orm");
        const { inventoryByBatch, productBatches, stockMovements } = await import("../drizzle/schema");

        // Validate: if reason is 'other', notes are required
        if (input.reason === 'other' && (!input.notes || input.notes.trim().length === 0)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Note obbligatorie per motivo 'Altro'" });
        }

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
              companyId: ctx.activeCompanyId, // M11.A
            });
          }

          // 4. Registra movimento ADJUSTMENT con adjustmentReason + adjustmentNote
          const reasonLabels: Record<string, string> = {
            typo: 'Errore di digitazione',
            recount: 'Riconteggio fisico',
            damage: 'Danno/Rottura',
            loss: 'Smarrimento',
            found: 'Ritrovamento',
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
            adjustmentReason: input.reason,
            adjustmentNote: input.notes ?? null,
            createdBy: ctx.user?.id ?? null,
            companyId: ctx.activeCompanyId, // M11.A
          });

          console.log(`[warehouse.adjustBatchQuantity] batchId=${input.batchId} ${previousQuantity}\u2192${newQuantity} (\u0394${delta}) reason=${input.reason}`);

          return { success: true, previousQuantity, newQuantity, delta };
        });
      }),

    /**
     * M11.E: Vista magazzino aggregato cross-company.
     *
     * SECURITY: This procedure intentionally bypasses per-company isolation.
     * It is SAFE because:
     * - User's authorized companies are fetched from userCompanyAccess FIRST
     * - Only stock from those companies is queried
     * - Backend enforces minimum 2 companies (otherwise FORBIDDEN)
     * - Output never exposes data from unauthorized companies
     */
    getAggregatedStock: staffProcedure
      .input(z.object({ lowStockOnly: z.boolean().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { getUserCompanyIds } = await import("./services/multiCompanyAccess");
        const userCompanyIds = await getUserCompanyIds(ctx.user!.id);
        if (userCompanyIds.length < 2) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `La vista aggregata richiede accesso ad almeno 2 company. Hai accesso solo a ${userCompanyIds.length}.`,
          });
        }
        const database = await db.getDb();
        if (!database) return [];
        const { sql } = await import("drizzle-orm");
        const rows = await database.execute(sql`
          SELECT
            p."id" AS "productId",
            p."sku",
            p."name" AS "productName",
            p."imageUrl" AS "productImage",
            p."minStockThreshold" AS "reorderThreshold",
            COALESCE(p."piecesPerUnit", 1)::int AS "piecesPerUnit",
            COALESCE(SUM(per_company_qty.company_qty), 0)::int AS "totalQuantity",
            jsonb_agg(jsonb_build_object(
              'companyId', per_company_qty."companyId",
              'companyName', c."name",
              'quantity', per_company_qty.company_qty
            ) ORDER BY c."name") AS "perCompany"
          FROM (
            SELECT
              pb."productId",
              pb."companyId",
              COALESCE(SUM(ibb."quantity"), 0)::int AS company_qty
            FROM "inventoryByBatch" ibb
            JOIN "productBatches" pb ON pb."id" = ibb."batchId"
            JOIN "locations" l ON l."id" = ibb."locationId"
            WHERE pb."companyId" = ANY(${sql.raw(`ARRAY[${userCompanyIds.map(id => `'${id}'::uuid`).join(',')}]`)})
              AND l."type" = 'central_warehouse'
              AND ibb."quantity" > 0
            GROUP BY pb."productId", pb."companyId"
          ) per_company_qty
          JOIN "products" p ON p."id" = per_company_qty."productId"
          JOIN "companies" c ON c."id" = per_company_qty."companyId"
          GROUP BY p."id", p."sku", p."name", p."imageUrl", p."minStockThreshold", p."piecesPerUnit"
          ORDER BY p."name"
        `);

        const results = (rows as any[]).map((r: any) => {
          const totalQuantity = Number(r.totalQuantity || 0);
          const threshold = Number(r.reorderThreshold || 10);
          let status: 'normal' | 'low' | 'critical' = 'normal';
          if (totalQuantity < threshold * 0.5) status = 'critical';
          else if (totalQuantity < threshold) status = 'low';
          return {
            productId: r.productId,
            sku: r.sku,
            productName: r.productName,
            productImage: r.productImage,
            piecesPerUnit: Number(r.piecesPerUnit || 1),
            totalQuantity,
            perCompany: r.perCompany || [],
            reorderThreshold: threshold,
            status,
          };
        });

        if (input?.lowStockOnly) {
          return results.filter((r) => r.status === 'low' || r.status === 'critical');
        }
        return results;
      }),

    /**
     * M11.E: Summary for dashboard widget (counts only).
     */
    getAggregatedStockSummary: staffProcedure.query(async ({ ctx }) => {
      const { getUserCompanies } = await import("./services/multiCompanyAccess");
      const userCompanies = await getUserCompanies(ctx.user!.id);
      if (userCompanies.length < 2) {
        return null; // Not eligible for aggregated view
      }
      const database = await db.getDb();
      if (!database) return null;
      const { sql } = await import("drizzle-orm");
      const companyIds = userCompanies.map((c) => c.companyId);
      const rows = await database.execute(sql`
        SELECT
          p."id" AS "productId",
          p."minStockThreshold" AS "reorderThreshold",
          COALESCE(SUM(ibb."quantity"), 0)::int AS "totalQuantity"
        FROM "inventoryByBatch" ibb
        JOIN "productBatches" pb ON pb."id" = ibb."batchId"
        JOIN "locations" l ON l."id" = ibb."locationId"
        JOIN "products" p ON p."id" = pb."productId"
        WHERE pb."companyId" = ANY(${sql.raw(`ARRAY[${companyIds.map(id => `'${id}'::uuid`).join(',')}]`)})
          AND l."type" = 'central_warehouse'
          AND ibb."quantity" > 0
        GROUP BY p."id", p."minStockThreshold"
      `);

      let totalProducts = 0;
      let lowStockCount = 0;
      let criticalCount = 0;
      for (const r of rows as any[]) {
        totalProducts++;
        const qty = Number(r.totalQuantity || 0);
        const threshold = Number(r.reorderThreshold || 10);
        if (qty < threshold * 0.5) criticalCount++;
        else if (qty < threshold) lowStockCount++;
      }

      return {
        totalProducts,
        lowStockCount,
        criticalCount,
        companiesAggregated: userCompanies.map((c) => ({ id: c.companyId, name: c.companyName })),
      };
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
        await db.updateAlertStatus(input.id, input.status, ctx.user!.id);
        return { success: true };
      }),
  }),

  // ============= DASHBOARD STATS =============
  // Cache TTL 2 min implementata in db.ts per mantenere i tipi tRPC
  dashboard: router({
    getStats: staffProcedure.query(async ({ ctx }) => {
      console.time("[dashboard.getStats]");
      const result = await db.getDashboardStats(ctx.activeCompanyId);
      console.timeEnd("[dashboard.getStats]");
      return result;
    }),
    getStockAlerts: staffProcedure.query(async ({ ctx }) => {
      console.time("[dashboard.getStockAlerts]");
      const result = await db.getProductsUnderThreshold(20, ctx.activeCompanyId);
      console.timeEnd("[dashboard.getStockAlerts]");
      return result;
    }),
    getExpiringBatches: staffProcedure.query(async ({ ctx }) => {
      console.time("[dashboard.getExpiringBatches]");
      const result = await db.getExpiringBatches(20, ctx.activeCompanyId);
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
    // Legacy: status senza companyId (backward compat)
    getStatus: staffProcedure.query(async () => {
      const t = Date.now();
      const r = await getFicStatus();
      const ms = Date.now() - t;
      if (ms > 500) console.log(`[ficIntegration.getStatus] ${ms}ms`);
      return r;
    }),

    // M11.C: status per company specifica
    getStatusForCompany: staffProcedure
      .input(z.object({ companyId: uuid }))
      .query(async ({ input }) => {
        return await getFicStatusForCompany(input.companyId);
      }),

    // M11.C: lista status per tutte le company accessibili
    listConnections: staffProcedure.query(async ({ ctx }) => {
      // Get all companies the user can access
      const userCompanies = (ctx as any).userCompanies ?? [];
      const results = [];
      for (const comp of userCompanies) {
        const status = await getFicStatusForCompany(comp.id);
        results.push({
          companyId: comp.id,
          companyName: comp.name,
          ...status,
        });
      }
      // If no userCompanies in context, fallback to known companies
      if (results.length === 0) {
        const eKetoStatus = await getFicStatusForCompany("00000000-0000-0000-0000-000000000001");
        const soKetoStatus = await getFicStatusForCompany("00000000-0000-0000-0000-000000000002");
        results.push(
          { companyId: "00000000-0000-0000-0000-000000000001", companyName: "E-Keto Food Srls", ...eKetoStatus },
          { companyId: "00000000-0000-0000-0000-000000000002", companyName: "SoKeto Srl", ...soKetoStatus },
        );
      }
      return results;
    }),

    // Legacy: startOAuth senza companyId
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

    // M11.C: startOAuth per company specifica
    startOAuthForCompany: adminProcedure
      .input(z.object({ companyId: uuid, forceLogin: z.boolean().optional() }))
      .query(async ({ input }) => {
        try {
          return { url: getFicAuthorizationUrlForCompany(input.companyId, { forceLogin: input.forceLogin }) };
        } catch (e) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: (e as Error).message,
          });
        }
      }),

    // Legacy: disconnect senza companyId
    disconnect: adminProcedure.mutation(async () => {
      const result = await disconnectFic();
      return { success: true, deleted: result.deleted };
    }),

    // M11.C: disconnect per company specifica
    disconnectForCompany: adminProcedure
      .input(z.object({ companyId: uuid }))
      .mutation(async ({ input }) => {
        const result = await disconnectFicForCompany(input.companyId);
        return { success: true, deleted: result.deleted };
      }),

    // M11.C: sincronizza mapping retailer ↔ FiC client per company
    syncRetailerMappings: adminProcedure
      .input(z.object({ companyId: uuid }))
      .mutation(async ({ input }) => {
        try {
          return await syncRetailerFicMappings(input.companyId);
        } catch (e) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: (e as Error).message,
          });
        }
      }),
  }),

  // ============= FIC CLIENTS CACHE (Phase B M3) =============
  ficClients: router({
    list: staffProcedure.query(async ({ ctx }) => {
      const t = Date.now();
      try {
        const r = await getCachedFicClients(ctx.activeCompanyId);
        const ms = Date.now() - t;
        if (ms > 500) console.log(`[ficClients.list] ${ms}ms count=${r.clients.length} company=${ctx.activeCompanyId}`);
        return r;
      } catch (e) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: (e as Error).message,
        });
      }
    }),

    refresh: writerProcedure.mutation(async ({ ctx }) => {
      try {
        return await refreshFicClientsForCompany(ctx.activeCompanyId);
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
      .mutation(async ({ input, ctx }) => {
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
          const payload = row.payload as Parameters<typeof createFicProformaForCompany>[1];
          const proforma = await createFicProformaForCompany(ctx.activeCompanyId, payload);
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
        // M11.C: dead FiC columns removed from retailers table.
        // Legacy sync disconnect now only resets syncEnabled.
        await db.updateRetailer(input.retailerId, {
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
  // ============= INVENTORY EXPORT =============
  inventoryExport: inventoryExportRouter,
  // ============= M11.A — COMPANIES =============
  companies: companiesRouter,
});

export type AppRouter = typeof appRouter;
