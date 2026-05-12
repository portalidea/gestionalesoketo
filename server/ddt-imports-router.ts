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
} from "../drizzle/schema";
import { extractFromPdf } from "./ddt-vision";
import { uploadDdtPdf, downloadDdtPdf, getSignedUrl, deleteDdtPdf } from "../lib/storage";
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
   * Upload PDF e avvia estrazione.
   * Input: base64 del PDF (per compatibilità tRPC, no multipart).
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

        // Aggiorna path e status
        await db
          .update(ddtImports)
          .set({ pdfStoragePath: path, status: "extracting" })
          .where(eq(ddtImports.id, importId));

        // Estrazione AI (Claude Vision)
        const extractedData = await extractFromPdf(fileBuffer);

        // Salva dati estratti
        await db
          .update(ddtImports)
          .set({
            extractedData: extractedData as unknown as Record<string, unknown>,
            ddtNumber: extractedData.ddtNumber,
            ddtDate: extractedData.ddtDate,
            status: "review",
            updatedAt: new Date(),
          })
          .where(eq(ddtImports.id, importId));

        // Carica anagrafica prodotti per fuzzy match
        const allProducts = await db
          .select({ id: products.id, name: products.name })
          .from(products);

        // Crea items con tentativo di match
        for (const item of extractedData.items) {
          const match = findBestMatch(item.productName, allProducts, 0.7);

          await db.insert(ddtImportItems).values({
            ddtImportId: importId,
            productNameExtracted: item.productName,
            productCodeExtracted: item.productCode,
            batchNumber: item.batchNumber,
            expirationDate: item.expirationDate,
            quantityPieces: item.quantityPieces,
            unitOfMeasure: "PZ",
            productMatchedId: match?.productId ?? null,
            status: match ? "matched" : "unmatched",
          });
        }

        return { id: importId, status: "review" as const, itemCount: extractedData.items.length };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await db
          .update(ddtImports)
          .set({ status: "failed", errorMessage: errorMsg, updatedAt: new Date() })
          .where(eq(ddtImports.id, importId));

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Estrazione fallita: ${errorMsg}`,
        });
      }
    }),

  /**
   * Riprova estrazione su un DDT fallito.
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

      await db
        .update(ddtImports)
        .set({ status: "extracting", errorMessage: null, updatedAt: new Date() })
        .where(eq(ddtImports.id, input.id));

      try {
        const pdfBuffer = await downloadDdtPdf(importRow.pdfStoragePath);
        const extractedData = await extractFromPdf(pdfBuffer);

        // Elimina vecchi items
        await db.delete(ddtImportItems).where(eq(ddtImportItems.ddtImportId, input.id));

        // Salva nuovi dati
        await db
          .update(ddtImports)
          .set({
            extractedData: extractedData as unknown as Record<string, unknown>,
            ddtNumber: extractedData.ddtNumber,
            ddtDate: extractedData.ddtDate,
            status: "review",
            updatedAt: new Date(),
          })
          .where(eq(ddtImports.id, input.id));

        // Fuzzy match
        const allProducts = await db
          .select({ id: products.id, name: products.name })
          .from(products);

        for (const item of extractedData.items) {
          const match = findBestMatch(item.productName, allProducts, 0.7);
          await db.insert(ddtImportItems).values({
            ddtImportId: input.id,
            productNameExtracted: item.productName,
            productCodeExtracted: item.productCode,
            batchNumber: item.batchNumber,
            expirationDate: item.expirationDate,
            quantityPieces: item.quantityPieces,
            unitOfMeasure: "PZ",
            productMatchedId: match?.productId ?? null,
            status: match ? "matched" : "unmatched",
          });
        }

        return { status: "review" as const, itemCount: extractedData.items.length };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await db
          .update(ddtImports)
          .set({ status: "failed", errorMessage: errorMsg, updatedAt: new Date() })
          .where(eq(ddtImports.id, input.id));

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Estrazione fallita: ${errorMsg}`,
        });
      }
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

        // Cerca lotto esistente per (productId, batchNumber)
        const [existingBatch] = await db
          .select()
          .from(productBatches)
          .where(
            and(
              eq(productBatches.productId, productId),
              eq(productBatches.batchNumber, item.batchNumber)
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
              batchNumber: item.batchNumber,
              expirationDate: item.expirationDate,
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
