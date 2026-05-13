/**
 * M5 — DDT Imports tRPC Router.
 * Gestisce upload PDF, estrazione AI, review, conferma e storico.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { router, writerProcedure, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import {
  ddtImports,
  ddtImportItems,
  products,
  productBatches,
  inventoryByBatch,
  stockMovements,
  locations,
  producers,
  productSupplierCodes,
} from "../drizzle/schema";
// extractFromPdf non più usato nel router: l'estrazione AI avviene
// tramite Edge Function /api/ddt-extract (M5.4 refactor)
import { uploadDdtPdf, getSignedUrl, deleteDdtPdf } from "../lib/storage";
import { findBestMatch } from "../lib/fuzzyMatch";

const uuid = z.string().uuid();

export const ddtImportsRouter = router({
  /**
   * Lista DDT imports con paginazione e filtri.
   */
  list: protectedProcedure
    .input(
      z.object({
        status: z.enum(["uploaded", "extracting", "review", "confirmed", "failed"]).optional(),
        producerId: uuid.optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      const conditions: ReturnType<typeof eq>[] = [];
      if (input.status) {
        conditions.push(eq(ddtImports.status, input.status));
      }
      if (input.producerId) {
        conditions.push(eq(ddtImports.producerId, input.producerId));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, countResult] = await Promise.all([
        db
          .select({
            id: ddtImports.id,
            producerId: ddtImports.producerId,
            ddtNumber: ddtImports.ddtNumber,
            ddtDate: ddtImports.ddtDate,
            status: ddtImports.status,
            pdfFileName: ddtImports.pdfFileName,
            pdfFileSize: ddtImports.pdfFileSize,
            confirmedAt: ddtImports.confirmedAt,
            createdAt: ddtImports.createdAt,
            errorMessage: ddtImports.errorMessage,
          })
          .from(ddtImports)
          .where(where)
          .orderBy(desc(ddtImports.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ddtImports)
          .where(where),
      ]);

      // Join producer names
      const producerIds = items
        .map((i) => i.producerId)
        .filter((id): id is string => id !== null);
      let producerMap: Record<string, string> = {};
      if (producerIds.length > 0) {
        const prods = await db
          .select({ id: producers.id, name: producers.name })
          .from(producers)
          .where(inArray(producers.id, producerIds));
        producerMap = Object.fromEntries(prods.map((p) => [p.id, p.name]));
      }

      // Count items per import
      const importIds = items.map((i) => i.id);
      let itemCountMap: Record<string, number> = {};
      if (importIds.length > 0) {
        const counts = await db
          .select({
            ddtImportId: ddtImportItems.ddtImportId,
            count: sql<number>`count(*)::int`,
          })
          .from(ddtImportItems)
          .where(inArray(ddtImportItems.ddtImportId, importIds))
          .groupBy(ddtImportItems.ddtImportId);
        itemCountMap = Object.fromEntries(counts.map((c) => [c.ddtImportId, c.count]));
      }

      return {
        items: items.map((i) => ({
          ...i,
          producerName: i.producerId ? producerMap[i.producerId] ?? null : null,
          itemCount: itemCountMap[i.id] ?? 0,
        })),
        total: countResult[0]?.count ?? 0,
      };
    }),

  /**
   * Dettaglio singolo DDT import con tutti gli items.
   */
  getById: protectedProcedure
    .input(z.object({ id: uuid }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      const [importRow] = await db
        .select()
        .from(ddtImports)
        .where(eq(ddtImports.id, input.id))
        .limit(1);

      if (!importRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "DDT import non trovato" });
      }

      const items = await db
        .select()
        .from(ddtImportItems)
        .where(eq(ddtImportItems.ddtImportId, input.id));

      // Arricchisci items con nome prodotto matchato
      const matchedIds = items
        .map((i) => i.productMatchedId)
        .filter((id): id is string => id !== null);
      let productMap: Record<string, string> = {};
      if (matchedIds.length > 0) {
        const prods = await db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(inArray(products.id, matchedIds));
        productMap = Object.fromEntries(prods.map((p) => [p.id, p.name]));
      }

      // Producer name
      let producerName: string | null = null;
      if (importRow.producerId) {
        const [prod] = await db
          .select({ name: producers.name })
          .from(producers)
          .where(eq(producers.id, importRow.producerId))
          .limit(1);
        producerName = prod?.name ?? null;
      }

      return {
        ...importRow,
        producerName,
        items: items.map((item) => ({
          ...item,
          productMatchedName: item.productMatchedId
            ? productMap[item.productMatchedId] ?? null
            : null,
        })),
      };
    }),

  /**
   * Upload PDF su Supabase Storage e crea record DDT.
   *
   * M5.4 refactor: NON chiama più Claude Vision.
   * L'estrazione AI avviene tramite Edge Function /api/ddt-extract
   * chiamata dal frontend dopo l'upload.
   *
   * Ritorna { id, storagePath } per permettere al frontend di
   * chiamare l'Edge Function con il path del PDF.
   */
  upload: writerProcedure
    .input(
      z.object({
        fileBase64: z.string(),
        fileName: z.string(),
        fileSize: z.number().max(10 * 1024 * 1024, "Max 10MB"),
        producerId: uuid.optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      const fileBuffer = Buffer.from(input.fileBase64, "base64");

      // Crea record iniziale
      const [newImport] = await db
        .insert(ddtImports)
        .values({
          producerId: input.producerId ?? null,
          status: "uploaded",
          pdfStoragePath: "pending",
          pdfFileName: input.fileName,
          pdfFileSize: input.fileSize,
        })
        .returning({ id: ddtImports.id });

      const importId = newImport.id;

      try {
        // Upload su Supabase Storage
        const { path } = await uploadDdtPdf(fileBuffer, input.fileName, importId);

        // Aggiorna path e status → 'uploaded' (pronto per estrazione Edge)
        await db
          .update(ddtImports)
          .set({ pdfStoragePath: path, status: "uploaded", updatedAt: new Date() })
          .where(eq(ddtImports.id, importId));

        return {
          id: importId,
          storagePath: path,
          status: "uploaded" as const,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await db
          .update(ddtImports)
          .set({ status: "failed", errorMessage: errorMsg, updatedAt: new Date() })
          .where(eq(ddtImports.id, importId));

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Upload fallito: ${errorMsg}`,
        });
      }
    }),

  /**
   * Riprova estrazione su un DDT fallito.
   *
   * M5.4 refactor: non chiama più Claude Vision direttamente.
   * Resetta lo stato a 'uploaded' e ritorna storagePath per permettere
   * al frontend di richiamare l'Edge Function /api/ddt-extract.
   */
  retryExtraction: writerProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      const [importRow] = await db
        .select()
        .from(ddtImports)
        .where(eq(ddtImports.id, input.id))
        .limit(1);

      if (!importRow) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (importRow.status !== "failed") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Solo DDT in stato 'failed' possono essere rielaborati",
        });
      }

      // Elimina vecchi items se presenti
      await db.delete(ddtImportItems).where(eq(ddtImportItems.ddtImportId, input.id));

      // Resetta stato a 'uploaded' per ri-estrazione via Edge Function
      await db
        .update(ddtImports)
        .set({
          status: "uploaded",
          errorMessage: null,
          extractedData: null,
          updatedAt: new Date(),
        })
        .where(eq(ddtImports.id, input.id));

      return {
        id: input.id,
        storagePath: importRow.pdfStoragePath,
        status: "uploaded" as const,
      };
    }),

  /**
   * Conferma i dati estratti dall'Edge Function e crea gli items.
   *
   * M5.4: nuova procedura. Riceve il JSON estratto da Claude Vision
   * (passato dal frontend dopo la chiamata all'Edge Function),
   * salva i dati in DB, esegue fuzzy match, crea ddt_import_items.
   *
   * Flusso:
   * 1. Frontend chiama upload → riceve { id, storagePath }
   * 2. Frontend chiama /api/ddt-extract (Edge) → riceve extractedData
   * 3. Frontend chiama confirmExtraction → salva dati + crea items
   */
  confirmExtraction: writerProcedure
    .input(
      z.object({
        ddtImportId: uuid,
        extractedData: z.object({
          ddtNumber: z.string().nullable(),
          ddtDate: z.string().nullable(),
          producerName: z.string().nullable(),
          destinationName: z.string().nullable(),
          items: z.array(
            z.object({
              productCode: z.string().nullable(),
              productName: z.string(),
              quantityPieces: z.number().int(),
              quantityKg: z.number().nullable(),
              batchNumber: z.string().nullable(),
              expirationDate: z.string().nullable(),
            })
          ),
        }),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      // Verifica che il DDT esista e sia in stato 'uploaded' o 'extracting'
      const [importRow] = await db
        .select()
        .from(ddtImports)
        .where(eq(ddtImports.id, input.ddtImportId))
        .limit(1);

      if (!importRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "DDT import non trovato" });
      }
      if (importRow.status !== "uploaded" && importRow.status !== "extracting") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `DDT in stato '${importRow.status}', atteso 'uploaded' o 'extracting'`,
        });
      }

      try {
        // Salva dati estratti nel record DDT
        await db
          .update(ddtImports)
          .set({
            extractedData: input.extractedData as unknown as Record<string, unknown>,
            ddtNumber: input.extractedData.ddtNumber,
            ddtDate: input.extractedData.ddtDate,
            status: "review",
            updatedAt: new Date(),
          })
          .where(eq(ddtImports.id, input.ddtImportId));

        // Carica anagrafica prodotti per fuzzy match
        const allProducts = await db
          .select({ id: products.id, name: products.name })
          .from(products);

        // M5.5: Carica codici fornitore per code-based match prioritario
        // Se il DDT ha un producerId, cerca match per codice fornitore prima del fuzzy
        const producerId = importRow.producerId;
        let supplierCodeMap: Map<string, string> = new Map();
        if (producerId) {
          const codes = await db
            .select({
              supplierCode: productSupplierCodes.supplierCode,
              productId: productSupplierCodes.productId,
            })
            .from(productSupplierCodes)
            .where(eq(productSupplierCodes.producerId, producerId));
          for (const c of codes) {
            supplierCodeMap.set(c.supplierCode.toLowerCase().trim(), c.productId);
          }
        }

        // Crea items con tentativo di match (code-based prioritario, poi fuzzy)
        for (const item of input.extractedData.items) {
          let matchedProductId: string | null = null;
          let matchStatus: "matched" | "unmatched" = "unmatched";

          // 1. Code-based match (prioritario, 100% affidabile)
          if (item.productCode && supplierCodeMap.size > 0) {
            const codeKey = item.productCode.toLowerCase().trim();
            const codeMatch = supplierCodeMap.get(codeKey);
            if (codeMatch) {
              matchedProductId = codeMatch;
              matchStatus = "matched";
            }
          }

          // 2. Fuzzy match (fallback se code-based non ha trovato)
          if (!matchedProductId) {
            const fuzzyMatch = findBestMatch(item.productName, allProducts, 0.7);
            if (fuzzyMatch) {
              matchedProductId = fuzzyMatch.productId;
              matchStatus = "matched";
            }
          }

          await db.insert(ddtImportItems).values({
            ddtImportId: input.ddtImportId,
            productNameExtracted: item.productName,
            productCodeExtracted: item.productCode,
            batchNumber: item.batchNumber,
            expirationDate: item.expirationDate,
            quantityPieces: item.quantityPieces,
            unitOfMeasure: "PZ",
            productMatchedId: matchedProductId,
            status: matchStatus,
          });
        }

        return {
          id: input.ddtImportId,
          status: "review" as const,
          itemCount: input.extractedData.items.length,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await db
          .update(ddtImports)
          .set({ status: "failed", errorMessage: errorMsg, updatedAt: new Date() })
          .where(eq(ddtImports.id, input.ddtImportId));

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Salvataggio dati estratti fallito: ${errorMsg}`,
        });
      }
    }),

  /**
   * Segna un DDT come 'extracting' (chiamato dal frontend prima
   * di invocare l'Edge Function, per aggiornare lo stato in UI).
   */
  markExtracting: writerProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      await db
        .update(ddtImports)
        .set({ status: "extracting", updatedAt: new Date() })
        .where(eq(ddtImports.id, input.id));

      return { success: true };
    }),

  /**
   * Segna un DDT come 'failed' (chiamato dal frontend se l'Edge
   * Function fallisce, per aggiornare lo stato in DB).
   */
  markFailed: writerProcedure
    .input(z.object({ id: uuid, errorMessage: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      await db
        .update(ddtImports)
        .set({ status: "failed", errorMessage: input.errorMessage, updatedAt: new Date() })
        .where(eq(ddtImports.id, input.id));

      return { success: true };
    }),

  /**
   * Aggiorna un singolo item (match manuale, modifica batch/scadenza/qty).
   */
  updateItem: writerProcedure
    .input(
      z.object({
        itemId: uuid,
        productMatchedId: uuid.optional(),
        batchNumber: z.string().min(1).optional(),
        expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        quantityPieces: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      const updateData: Record<string, unknown> = {};
      if (input.productMatchedId !== undefined) {
        updateData.productMatchedId = input.productMatchedId;
        updateData.status = "matched";
      }
      if (input.batchNumber !== undefined) updateData.batchNumber = input.batchNumber;
      if (input.expirationDate !== undefined) updateData.expirationDate = input.expirationDate;
      if (input.quantityPieces !== undefined) updateData.quantityPieces = input.quantityPieces;

      if (Object.keys(updateData).length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Nessun campo da aggiornare" });
      }

      await db.update(ddtImportItems).set(updateData).where(eq(ddtImportItems.id, input.itemId));

      return { success: true };
    }),

  /**
   * Rimuovi un item dal DDT (pre-conferma).
   */
  removeItem: writerProcedure
    .input(z.object({ itemId: uuid }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });
      await db.delete(ddtImportItems).where(eq(ddtImportItems.id, input.itemId));
      return { success: true };
    }),

  /**
   * Conferma DDT: crea lotti, aggiorna inventario, registra movimenti.
   */
  confirm: writerProcedure
    .input(
      z.object({
        id: uuid,
        producerId: uuid,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      // Verifica stato
      const [importRow] = await db
        .select()
        .from(ddtImports)
        .where(eq(ddtImports.id, input.id))
        .limit(1);

      if (!importRow) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (importRow.status !== "review") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Solo DDT in stato 'review' possono essere confermati",
        });
      }

      // Carica items
      const items = await db
        .select()
        .from(ddtImportItems)
        .where(eq(ddtImportItems.ddtImportId, input.id));

      // Verifica che tutti gli items siano matchati
      const unmatchedItems = items.filter((i) => !i.productMatchedId);
      if (unmatchedItems.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${unmatchedItems.length} item(s) non matchati. Risolvere prima di confermare.`,
        });
      }

      // Verifica che tutti gli items abbiano batchNumber e expirationDate compilati
      const missingBatch = items.filter((i) => !i.batchNumber);
      const missingExpiry = items.filter((i) => !i.expirationDate);
      if (missingBatch.length > 0 || missingExpiry.length > 0) {
        const parts: string[] = [];
        if (missingBatch.length > 0) parts.push(`${missingBatch.length} item(s) senza lotto`);
        if (missingExpiry.length > 0) parts.push(`${missingExpiry.length} item(s) senza scadenza`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Compila tutti i lotti e scadenze prima di confermare: ${parts.join(", ")}.`,
        });
      }

      // Trova location magazzino centrale
      const [centralLocation] = await db
        .select()
        .from(locations)
        .where(eq(locations.type, "central_warehouse"))
        .limit(1);

      if (!centralLocation) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Location magazzino centrale non trovata",
        });
      }

      let batchesCreated = 0;
      let batchesMerged = 0;

      // Processa ogni item
      for (const item of items) {
        const productId = item.productMatchedId!;
        const batchNumber = item.batchNumber!;
        const expirationDate = item.expirationDate!;

        // Cerca lotto esistente per (productId, batchNumber)
        const [existingBatch] = await db
          .select()
          .from(productBatches)
          .where(
            and(
              eq(productBatches.productId, productId),
              eq(productBatches.batchNumber, batchNumber)
            )
          )
          .limit(1);

        let batchId: string;

        if (existingBatch) {
          // MERGE: incrementa quantità in inventoryByBatch
          batchId = existingBatch.id;
          batchesMerged++;

          await db
            .update(inventoryByBatch)
            .set({
              quantity: sql`${inventoryByBatch.quantity} + ${item.quantityPieces}`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(inventoryByBatch.batchId, batchId),
                eq(inventoryByBatch.locationId, centralLocation.id)
              )
            );

          // Aggiorna item con mergedIntoBatchId
          await db
            .update(ddtImportItems)
            .set({ mergedIntoBatchId: batchId, status: "merged" })
            .where(eq(ddtImportItems.id, item.id));
        } else {
          // CREATE: nuovo lotto + inventoryByBatch
          batchesCreated++;

          const [newBatch] = await db
            .insert(productBatches)
            .values({
              productId,
              producerId: input.producerId,
              batchNumber,
              expirationDate,
              initialQuantity: item.quantityPieces,
            })
            .returning({ id: productBatches.id });

          batchId = newBatch.id;

          await db.insert(inventoryByBatch).values({
            batchId,
            locationId: centralLocation.id,
            quantity: item.quantityPieces,
          });

          // Aggiorna item con createdBatchId
          await db
            .update(ddtImportItems)
            .set({ createdBatchId: batchId, status: "confirmed" })
            .where(eq(ddtImportItems.id, item.id));
        }

        // Registra movimento RECEIPT_FROM_PRODUCER
        await db.insert(stockMovements).values({
          productId: productId,
          batchId,
          type: "RECEIPT_FROM_PRODUCER",
          quantity: item.quantityPieces,
          toLocationId: centralLocation.id,
          createdBy: ctx.user.id,
          notesInternal: `DDT ${importRow.ddtNumber ?? input.id} - ${item.productNameExtracted}`,
        });
      }

      // Aggiorna DDT import come confermato
      await db
        .update(ddtImports)
        .set({
          producerId: input.producerId,
          status: "confirmed",
          confirmedAt: new Date(),
          confirmedBy: ctx.user.id,
          updatedAt: new Date(),
        })
        .where(eq(ddtImports.id, input.id));

      // Invio email notifica conferma DDT
      try {
        const { sendEmail } = await import("./email");
        await sendEmail({
          to: ctx.user.email ?? "",
          subject: `DDT ${importRow.ddtNumber ?? importRow.pdfFileName} confermato`,
          html: `<h2>DDT Confermato</h2>
            <p><strong>File:</strong> ${importRow.pdfFileName}</p>
            <p><strong>Numero DDT:</strong> ${importRow.ddtNumber ?? "N/A"}</p>
            <p><strong>Righe processate:</strong> ${items.length}</p>
            <p><strong>Lotti creati:</strong> ${batchesCreated}</p>
            <p><strong>Lotti aggiornati (merge):</strong> ${batchesMerged}</p>
            <p>I prodotti sono stati caricati nel magazzino centrale.</p>`,
        });
      } catch (emailErr) {
        // Non bloccare la conferma se l'email fallisce
        console.warn("[DDT] Email notifica fallita:", emailErr);
      }

      return {
        success: true,
        itemsProcessed: items.length,
        batchesCreated,
        batchesMerged,
      };
    }),

  /**
   * Download PDF originale (signed URL temporanea).
   */
  downloadPdf: protectedProcedure
    .input(z.object({ id: uuid }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      const [importRow] = await db
        .select({ pdfStoragePath: ddtImports.pdfStoragePath })
        .from(ddtImports)
        .where(eq(ddtImports.id, input.id))
        .limit(1);

      if (!importRow) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const signedUrl = await getSignedUrl(importRow.pdfStoragePath);
      return { url: signedUrl };
    }),

  /**
   * Elimina un DDT import (solo admin, cancella anche file Storage).
   */
  delete: writerProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

      const [importRow] = await db
        .select({ pdfStoragePath: ddtImports.pdfStoragePath })
        .from(ddtImports)
        .where(eq(ddtImports.id, input.id))
        .limit(1);

      if (!importRow) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Elimina file da Storage
      try {
        await deleteDdtPdf(importRow.pdfStoragePath);
      } catch (err) {
        console.warn("[DDT] Errore eliminazione file storage:", err);
      }

      // Elimina record (cascade elimina items)
      await db.delete(ddtImports).where(eq(ddtImports.id, input.id));

      return { success: true };
    }),
});
