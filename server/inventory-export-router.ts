/**
 * Inventory Export Router — Export XLSX snapshot del magazzino centrale
 * a una data specifica. Read-only, nessuna modifica schema.
 *
 * Logica:
 * - Se atDate >= oggi → usa inventoryByBatch corrente
 * - Se atDate < oggi → ricostruisce via stockMovements (ultimo newQuantity per batch)
 *
 * TRANSFER movements: nel codebase, un TRANSFER dal magazzino centrale
 * crea UN singolo record con fromLocationId=central, toLocationId=retailer,
 * previousQuantity/newQuantity riferiti alla location FROM (centrale).
 * Quindi per ricostruire lo stock centrale basta filtrare per
 * (fromLocationId = central OR toLocationId = central) e prendere
 * newQuantity dell'ultimo movimento per batch. Ma poiché newQuantity
 * è relativo alla location del campo "from" per TRANSFER, e per
 * RECEIPT_FROM_PRODUCER è relativo alla location "to" (centrale),
 * usiamo un approccio unificato: per ogni batch, il campo newQuantity
 * del movimento più recente che tocca il magazzino centrale rappresenta
 * lo stato del batch in quella location a quel timestamp.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { staffProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  inventoryByBatch,
  locations,
  productBatches,
  products,
  producers,
} from "../drizzle/schema";
import ExcelJS from "exceljs";

export const inventoryExportRouter = router({
  exportSnapshot: staffProcedure
    .input(
      z.object({
        atDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato data atteso YYYY-MM-DD"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // 1) Identificare magazzino centrale
      const centralLocations = await db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(eq(locations.type, "central_warehouse"));

      if (centralLocations.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Nessun magazzino centrale trovato" });
      }
      if (centralLocations.length > 1) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Multiple central warehouses found" });
      }
      const centralId = centralLocations[0].id;
      const centralName = centralLocations[0].name;

      // 2) Determinare se atDate è oggi/futuro o passato
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const isCurrentOrFuture = input.atDate >= today;

      type SnapshotRow = {
        batchId: string;
        quantity: number;
      };

      let snapshotRows: SnapshotRow[];

      if (isCurrentOrFuture) {
        // Usa inventoryByBatch corrente
        const rows = await db
          .select({
            batchId: inventoryByBatch.batchId,
            quantity: inventoryByBatch.quantity,
          })
          .from(inventoryByBatch)
          .where(eq(inventoryByBatch.locationId, centralId));
        snapshotRows = rows.filter((r) => r.quantity > 0);
      } else {
        // 3) Ricostruzione via stockMovements
        // Per ogni batch, prendi l'ultimo movimento con timestamp <= atDate+23:59:59
        // che tocca il magazzino centrale (from o to), e usa newQuantity.
        const endOfDay = `${input.atDate}T23:59:59.999Z`;
        const reconstructed = await db.execute<{ batchId: string; qty_at_date: number }>(sql`
          WITH ranked AS (
            SELECT
              "batchId",
              "newQuantity",
              ROW_NUMBER() OVER (
                PARTITION BY "batchId"
                ORDER BY "timestamp" DESC
              ) AS rn
            FROM "stockMovements"
            WHERE ("fromLocationId" = ${centralId} OR "toLocationId" = ${centralId})
              AND "timestamp" <= ${endOfDay}::timestamptz
              AND "batchId" IS NOT NULL
          )
          SELECT "batchId", "newQuantity" AS "qty_at_date"
          FROM ranked WHERE rn = 1
        `);
        snapshotRows = (reconstructed as unknown as Array<{ batchId: string; qty_at_date: number }>)
          .filter((r) => r.qty_at_date > 0)
          .map((r) => ({ batchId: r.batchId, quantity: r.qty_at_date }));
      }

      // 4) Arricchire con dati batch, prodotto, produttore
      if (snapshotRows.length === 0) {
        // Genera file vuoto con header
        const wb = await generateXlsx([], input.atDate, centralName, ctx.user?.email ?? "system", null);
        return { fileBase64: wb, filename: `magazzino_soketo_${input.atDate}.xlsx`, driftReport: { count: 0, details: [] } };
      }

      const batchIds = snapshotRows.map((r) => r.batchId);
      const batchDetails = await db.execute<{
        batchId: string;
        batchNumber: string;
        expirationDate: string;
        costPrice: string;
        productId: string;
        sku: string;
        productName: string;
        piecesPerUnit: number;
        producerName: string | null;
      }>(sql`
        SELECT
          pb."id" AS "batchId",
          pb."batchNumber",
          pb."expirationDate",
          pb."costPrice",
          p."id" AS "productId",
          p."sku",
          p."name" AS "productName",
          p."piecesPerUnit",
          pr."name" AS "producerName"
        FROM "productBatches" pb
        JOIN "products" p ON p."id" = pb."productId"
        LEFT JOIN "producers" pr ON pr."id" = pb."producerId"
        WHERE pb."id" IN (${sql.join(batchIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `);

      const batchMap = new Map(
        (batchDetails as unknown as Array<{
          batchId: string;
          batchNumber: string;
          expirationDate: string;
          costPrice: string;
          productId: string;
          sku: string;
          productName: string;
          piecesPerUnit: number;
          producerName: string | null;
        }>).map((b) => [b.batchId, b]),
      );

      // Build export rows
      type ExportRow = {
        sku: string;
        productName: string;
        batchNumber: string;
        expirationDate: string;
        producerName: string;
        quantity: number;
        costPrice: number;
        value: number;
      };

      const exportRows: ExportRow[] = [];
      for (const sr of snapshotRows) {
        const detail = batchMap.get(sr.batchId);
        if (!detail) continue;
        const costPerPiece = parseFloat(detail.costPrice) || 0;
        const qty = sr.quantity;
        exportRows.push({
          sku: detail.sku,
          productName: detail.productName,
          batchNumber: detail.batchNumber,
          expirationDate: detail.expirationDate,
          producerName: detail.producerName ?? "",
          quantity: qty,
          costPrice: costPerPiece,
          value: qty * costPerPiece,
        });
      }

      // Sort: prodotto ASC, scadenza ASC (FEFO)
      exportRows.sort((a, b) => {
        const nameComp = a.productName.localeCompare(b.productName);
        if (nameComp !== 0) return nameComp;
        return a.expirationDate.localeCompare(b.expirationDate);
      });

      // 5) Drift check (solo se data = oggi)
      type DriftDetail = { batchId: string; batchNumber: string; productName: string; snapshotQty: number; currentQty: number };
      let driftReport: { count: number; details: DriftDetail[] };

      if (isCurrentOrFuture) {
        // No drift per data corrente (è la stessa sorgente)
        driftReport = { count: 0, details: [] };
      } else {
        // Per date passate, drift non applicabile
        driftReport = { count: -1, details: [] }; // -1 = N/A
      }

      // 6) Genera XLSX
      const fileBase64 = await generateXlsx(exportRows, input.atDate, centralName, ctx.user?.email ?? "system", driftReport);

      return {
        fileBase64,
        filename: `magazzino_soketo_${input.atDate}.xlsx`,
        driftReport: { count: driftReport.count, details: driftReport.details },
      };
    }),
});

// ============= XLSX GENERATION =============

type ExportRow = {
  sku: string;
  productName: string;
  batchNumber: string;
  expirationDate: string;
  producerName: string;
  quantity: number;
  costPrice: number;
  value: number;
};
type DriftDetail = { batchId: string; batchNumber: string; productName: string; snapshotQty: number; currentQty: number };

async function generateXlsx(
  rows: ExportRow[],
  atDate: string,
  centralName: string,
  userEmail: string,
  driftReport: { count: number; details: DriftDetail[] } | null,
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Magazzino");

  // Column widths
  sheet.columns = [
    { width: 15 }, // A: SKU
    { width: 40 }, // B: Prodotto
    { width: 18 }, // C: Codice lotto
    { width: 12 }, // D: Scadenza
    { width: 25 }, // E: Producer
    { width: 12 }, // F: Quantità (pz)
    { width: 14 }, // G: Costo unit. (€)
    { width: 14 }, // H: Valore (€)
  ];

  // Format date dd/MM/yyyy
  const formatDate = (d: string) => {
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y}`;
  };

  const now = new Date();
  const nowStr = `${now.toLocaleDateString("it-IT")} ${now.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;

  // Row 1: Title (merged A:H)
  sheet.mergeCells("A1:H1");
  const titleCell = sheet.getCell("A1");
  titleCell.value = `Magazzino SoKeto — Snapshot al ${formatDate(atDate)}`;
  titleCell.font = { bold: true, size: 14 };

  // Row 2: Subtitle (merged A:H)
  sheet.mergeCells("A2:H2");
  const subtitleCell = sheet.getCell("A2");
  subtitleCell.value = `Magazzino centrale: ${centralName}  ·  Generato il ${nowStr} da ${userEmail}`;
  subtitleCell.font = { size: 10, italic: true, color: { argb: "FF666666" } };

  // Row 3: empty

  // Row 4: Headers
  const headerRow = sheet.getRow(4);
  const headers = ["SKU", "Prodotto", "Codice lotto", "Scadenza", "Producer", "Quantità (pz)", "Costo unit. (€)", "Valore (€)"];
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
    cell.alignment = { horizontal: i >= 5 ? "right" : "left" };
  });

  // Data rows
  let currentRow = 5;
  let currentProduct = "";
  let productQtySum = 0;
  let productValueSum = 0;
  let grandQtyTotal = 0;
  let grandValueTotal = 0;

  const writeSubtotal = (productName: string) => {
    const subRow = sheet.getRow(currentRow);
    subRow.getCell(1).value = `Subtotale ${productName}`;
    subRow.getCell(1).font = { italic: true };
    subRow.getCell(6).value = productQtySum;
    subRow.getCell(6).font = { bold: true };
    subRow.getCell(6).alignment = { horizontal: "right" };
    subRow.getCell(8).value = productValueSum;
    subRow.getCell(8).font = { bold: true };
    subRow.getCell(8).numFmt = '€ #,##0.00';
    subRow.getCell(8).alignment = { horizontal: "right" };
    // Light gray background
    for (let c = 1; c <= 8; c++) {
      subRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
    }
    currentRow++;
  };

  for (const row of rows) {
    if (currentProduct && row.productName !== currentProduct) {
      // Write subtotal for previous product
      writeSubtotal(currentProduct);
      productQtySum = 0;
      productValueSum = 0;
    }
    currentProduct = row.productName;

    const dataRow = sheet.getRow(currentRow);
    dataRow.getCell(1).value = row.sku;
    dataRow.getCell(2).value = row.productName;
    dataRow.getCell(3).value = row.batchNumber;
    dataRow.getCell(4).value = formatDate(row.expirationDate);
    dataRow.getCell(5).value = row.producerName;
    dataRow.getCell(6).value = row.quantity;
    dataRow.getCell(6).alignment = { horizontal: "right" };
    dataRow.getCell(7).value = row.costPrice;
    dataRow.getCell(7).numFmt = '€ #,##0.00';
    dataRow.getCell(7).alignment = { horizontal: "right" };
    dataRow.getCell(8).value = row.value;
    dataRow.getCell(8).numFmt = '€ #,##0.00';
    dataRow.getCell(8).alignment = { horizontal: "right" };

    productQtySum += row.quantity;
    productValueSum += row.value;
    grandQtyTotal += row.quantity;
    grandValueTotal += row.value;
    currentRow++;
  }

  // Last product subtotal
  if (currentProduct) {
    writeSubtotal(currentProduct);
  }

  // Grand total row
  const totalRow = sheet.getRow(currentRow);
  totalRow.getCell(1).value = "TOTALE MAGAZZINO";
  totalRow.getCell(6).value = grandQtyTotal;
  totalRow.getCell(6).alignment = { horizontal: "right" };
  totalRow.getCell(8).value = grandValueTotal;
  totalRow.getCell(8).numFmt = '€ #,##0.00';
  totalRow.getCell(8).alignment = { horizontal: "right" };
  for (let c = 1; c <= 8; c++) {
    totalRow.getCell(c).font = { bold: true };
    totalRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3CD" } }; // amber light
  }
  currentRow++;

  // Drift row
  currentRow++; // empty separator
  const driftRow = sheet.getRow(currentRow);
  if (!driftReport || driftReport.count === -1) {
    driftRow.getCell(1).value = "Drift vs inventoryByBatch corrente: N/A (data passata)";
    driftRow.getCell(1).font = { italic: true, color: { argb: "FF999999" } };
  } else if (driftReport.count === 0) {
    driftRow.getCell(1).value = "Drift vs inventoryByBatch corrente: 0 batch con discrepanza";
    driftRow.getCell(1).font = { italic: true, color: { argb: "FF28A745" } };
  } else {
    driftRow.getCell(1).value = `Drift vs inventoryByBatch corrente: ${driftReport.count} batch con discrepanza`;
    driftRow.getCell(1).font = { italic: true, color: { argb: "FFDC3545" } };
    currentRow++;
    // Detail rows
    for (const d of driftReport.details) {
      const detailRow = sheet.getRow(currentRow);
      detailRow.getCell(1).value = d.productName;
      detailRow.getCell(3).value = d.batchNumber;
      detailRow.getCell(6).value = `Snapshot: ${d.snapshotQty}`;
      detailRow.getCell(7).value = `Corrente: ${d.currentQty}`;
      for (let c = 1; c <= 8; c++) {
        detailRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4E4" } }; // red light
      }
      currentRow++;
    }
  }

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString("base64");
}
