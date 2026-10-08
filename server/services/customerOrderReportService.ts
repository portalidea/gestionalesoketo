import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { sql } from "drizzle-orm";
import { SOKETO_LOGO_PNG_BASE64 } from "../assets/soketoLogo";
import { getDb } from "../db";

export type CustomerOrderReportInput = {
  retailerId: string;
  dateFrom: string;
  dateTo: string;
  includeRelatedProfiles: boolean;
  authorizedCompanyIds: string[];
};

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type ReportItem = {
  id: string;
  productName: string;
  quantity: number;
  unitPriceFinal: number;
  lineTotalNet: number;
  creditCovered: number;
};

type ReportOrder = {
  id: string;
  orderNumber: string;
  orderDate: string;
  status: string;
  companyName: string;
  subtotalNet: number;
  vatAmount: number;
  totalGross: number;
  creditCovered: number;
  items: ReportItem[];
};

export type CustomerOrderReport = {
  generatedAt: string;
  period: { from: string; to: string };
  customer: { name: string; vatNumber: string | null; relatedProfilesIncluded: boolean };
  companies: string[];
  orders: ReportOrder[];
  totals: {
    orderCount: number;
    subtotalNet: number;
    vatAmount: number;
    totalGross: number;
    creditCovered: number;
  };
  allowances: Array<{
    type: "restaurant_package" | "investor_benefit";
    initialAmount: number;
    consumedAmount: number;
    remainingAmount: number;
  }>;
};

const euro = (value: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(value);

const dateIT = (date: string) => {
  const normalized = date.slice(0, 10);
  const [year, month, day] = normalized.split("-");
  return year && month && day ? `${day}/${month}/${year}` : date;
};

const parseNumeric = (value: unknown): number => {
  const numberValue = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const formatAllowanceType = (type: CustomerOrderReport["allowances"][number]["type"]) =>
  type === "investor_benefit" ? "Beneficio investitore" : "Pacchetto ristoratore";

const orderStatusLabel = (status: string) => ({
  pending: "In attesa",
  paid: "Pagato",
  transferring: "In trasferimento",
  shipped: "Spedito",
  delivered: "Consegnato",
  cancelled: "Annullato",
}[status] ?? status);

function assertIsoDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${field} non valida`);
  }
}

function endExclusive(dateTo: string) {
  const date = new Date(`${dateTo}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

/**
 * Carica un report read-only e strettamente scope-ato alle company autorizzate.
 * La scelta di includere anagrafiche correlate è limitata alle company in
 * authorizedCompanyIds: una P. IVA non allarga mai l'accesso dell'operatore.
 */
export async function loadCustomerOrderReport(
  db: Database,
  input: CustomerOrderReportInput,
): Promise<CustomerOrderReport> {
  assertIsoDate(input.dateFrom, "Data iniziale");
  assertIsoDate(input.dateTo, "Data finale");
  if (input.dateFrom > input.dateTo) throw new Error("La data iniziale non può essere successiva alla data finale");
  if (!input.authorizedCompanyIds.length) throw new Error("Nessuna company autorizzata");

  const selectedRows = await db.execute<{
    id: string;
    name: string;
    vatNumber: string | null;
    companyId: string;
  }>(sql`
    SELECT id, name, "vatNumber", "companyId"
    FROM retailers
    WHERE id = ${input.retailerId}::uuid
      AND "companyId" IN (${sql.join(input.authorizedCompanyIds.map((id) => sql`${id}::uuid`), sql`, `)})
    LIMIT 1
  `);
  const selected = (selectedRows as unknown as Array<{ id: string; name: string; vatNumber: string | null; companyId: string }>)[0];
  if (!selected) throw new Error("Rivenditore non trovato o non autorizzato");

  const relatedProfilesEnabled = input.includeRelatedProfiles && Boolean(selected.vatNumber);
  const retailerRows = relatedProfilesEnabled
    ? await db.execute<{ id: string; companyId: string; companyName: string }>(sql`
        SELECT r.id, r."companyId", c.name AS "companyName"
        FROM retailers r
        INNER JOIN companies c ON c.id = r."companyId"
        WHERE r."vatNumber" = ${selected.vatNumber!}
          AND r."companyId" IN (${sql.join(input.authorizedCompanyIds.map((id) => sql`${id}::uuid`), sql`, `)})
        ORDER BY c.name, r.name
      `)
    : await db.execute<{ id: string; companyId: string; companyName: string }>(sql`
        SELECT r.id, r."companyId", c.name AS "companyName"
        FROM retailers r
        INNER JOIN companies c ON c.id = r."companyId"
        WHERE r.id = ${selected.id}::uuid
        LIMIT 1
      `);

  const profiles = retailerRows as unknown as Array<{ id: string; companyId: string; companyName: string }>;
  const retailerIds = profiles.map((profile) => profile.id);
  if (!retailerIds.length) throw new Error("Nessuna anagrafica cliente autorizzata");

  const ordersRows = await db.execute<{
    id: string;
    orderNumber: string;
    orderDate: string;
    status: string;
    companyName: string;
    subtotalNet: string;
    vatAmount: string;
    totalGross: string;
    creditCovered: string;
  }>(sql`
    WITH credit_by_order AS (
      SELECT "orderId", SUM("consumptionAmount"::numeric) AS "creditCovered"
      FROM retailer_allowance_consumptions
      GROUP BY "orderId"
    )
    SELECT
      o.id,
      o."orderNumber",
      o."createdAt"::date::text AS "orderDate",
      o.status,
      c.name AS "companyName",
      o."subtotalNet"::text AS "subtotalNet",
      o."vatAmount"::text AS "vatAmount",
      o."totalGross"::text AS "totalGross",
      COALESCE(cbo."creditCovered", 0)::text AS "creditCovered"
    FROM orders o
    INNER JOIN companies c ON c.id = o."companyId"
    LEFT JOIN credit_by_order cbo ON cbo."orderId" = o.id
    WHERE o."retailerId" IN (${sql.join(retailerIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND o."companyId" IN (${sql.join(input.authorizedCompanyIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND o."createdAt" >= ${input.dateFrom}::date
      AND o."createdAt" < ${endExclusive(input.dateTo)}::timestamptz
    ORDER BY o."createdAt", o."orderNumber"
  `);
  const rawOrders = ordersRows as unknown as Array<{
    id: string;
    orderNumber: string;
    orderDate: string;
    status: string;
    companyName: string;
    subtotalNet: string;
    vatAmount: string;
    totalGross: string;
    creditCovered: string;
  }>;

  const orderIds = rawOrders.map((order) => order.id);
  const itemRows = orderIds.length
    ? await db.execute<{
        id: string;
        orderId: string;
        productName: string;
        quantity: string;
        unitPriceFinal: string;
        lineTotalNet: string;
        creditCovered: string;
      }>(sql`
        WITH credit_by_item AS (
          SELECT "orderItemId", SUM("consumptionAmount"::numeric) AS "creditCovered"
          FROM retailer_allowance_consumptions
          WHERE "orderItemId" IS NOT NULL
          GROUP BY "orderItemId"
        )
        SELECT
          oi.id,
          oi."orderId",
          oi."productName",
          oi.quantity::text AS quantity,
          oi."unitPriceFinal"::text AS "unitPriceFinal",
          oi."lineTotalNet"::text AS "lineTotalNet",
          COALESCE(cbi."creditCovered", 0)::text AS "creditCovered"
        FROM "orderItems" oi
        LEFT JOIN credit_by_item cbi ON cbi."orderItemId" = oi.id
        WHERE oi."orderId" IN (${sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `)})
        ORDER BY oi."orderId", oi."productName", oi.id
      `)
    : [];

  const itemsByOrder = new Map<string, ReportItem[]>();
  for (const item of itemRows as unknown as Array<{
    id: string;
    orderId: string;
    productName: string;
    quantity: string;
    unitPriceFinal: string;
    lineTotalNet: string;
    creditCovered: string;
  }>) {
    const items = itemsByOrder.get(item.orderId) ?? [];
    items.push({
      id: item.id,
      productName: item.productName,
      quantity: parseNumeric(item.quantity),
      unitPriceFinal: parseNumeric(item.unitPriceFinal),
      lineTotalNet: parseNumeric(item.lineTotalNet),
      creditCovered: parseNumeric(item.creditCovered),
    });
    itemsByOrder.set(item.orderId, items);
  }

  const orders: ReportOrder[] = rawOrders.map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    status: order.status,
    companyName: order.companyName,
    subtotalNet: parseNumeric(order.subtotalNet),
    vatAmount: parseNumeric(order.vatAmount),
    totalGross: parseNumeric(order.totalGross),
    creditCovered: parseNumeric(order.creditCovered),
    items: itemsByOrder.get(order.id) ?? [],
  }));

  const allowanceRows = await db.execute<{
    type: "restaurant_package" | "investor_benefit";
    initialAmount: string;
    consumedAmount: string;
  }>(sql`
    SELECT
      ra."allowanceType" AS type,
      ra."initialAmount"::text AS "initialAmount",
      COALESCE(SUM(rac."consumptionAmount"::numeric), 0)::text AS "consumedAmount"
    FROM retailer_allowances ra
    LEFT JOIN retailer_allowance_consumptions rac ON rac."allowanceId" = ra.id
    WHERE ra."retailerId" IN (${sql.join(retailerIds.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY ra.id, ra."allowanceType", ra."initialAmount"
    ORDER BY ra."allowanceType", ra."activatedAt"
  `);
  const allowances = (allowanceRows as unknown as Array<{
    type: "restaurant_package" | "investor_benefit";
    initialAmount: string;
    consumedAmount: string;
  }>).map((allowance) => {
    const initialAmount = parseNumeric(allowance.initialAmount);
    const consumedAmount = parseNumeric(allowance.consumedAmount);
    return {
      type: allowance.type,
      initialAmount,
      consumedAmount,
      remainingAmount: Math.round((initialAmount - consumedAmount) * 100) / 100,
    };
  });

  const validOrders = orders.filter((order) => order.status !== "cancelled");
  const totals = validOrders.reduce(
    (accumulator, order) => ({
      orderCount: accumulator.orderCount + 1,
      subtotalNet: accumulator.subtotalNet + order.subtotalNet,
      vatAmount: accumulator.vatAmount + order.vatAmount,
      totalGross: accumulator.totalGross + order.totalGross,
      creditCovered: accumulator.creditCovered + order.creditCovered,
    }),
    { orderCount: 0, subtotalNet: 0, vatAmount: 0, totalGross: 0, creditCovered: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    period: { from: input.dateFrom, to: input.dateTo },
    customer: {
      name: selected.name,
      vatNumber: selected.vatNumber,
      relatedProfilesIncluded: relatedProfilesEnabled && profiles.length > 1,
    },
    companies: Array.from(new Set(profiles.map((profile) => profile.companyName))),
    orders,
    totals: Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [key, typeof value === "number" ? Math.round(value * 100) / 100 : value]),
    ) as CustomerOrderReport["totals"],
    allowances,
  };
}

export async function generateCustomerOrderPdf(report: CustomerOrderReport): Promise<string> {
  const document = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: `Riepilogo ordini ${report.customer.name}` } });
  const buffers: Buffer[] = [];
  document.on("data", (chunk: Buffer) => buffers.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(buffers)));
    document.on("error", reject);
  });

  const pageBottom = () => document.page.height - document.page.margins.bottom;
  const ensureSpace = (height: number) => {
    if (document.y + height > pageBottom()) document.addPage();
  };
  const drawText = (
    text: string,
    x: number,
    y: number,
    options: PDFKit.Mixins.TextOptions & { fontSize?: number; color?: string } = {},
  ) => {
    const { fontSize = 7, color = "#213421", ...textOptions } = options;
    document.fillColor(color).font("Helvetica").fontSize(fontSize).text(text, x, y, textOptions);
  };
  const drawRule = () => {
    document.moveTo(42, document.y).lineTo(553, document.y).lineWidth(0.7).strokeColor("#D9E8D4").stroke();
    document.moveDown(0.7);
  };

  document.image(Buffer.from(SOKETO_LOGO_PNG_BASE64, "base64"), 42, 38, { fit: [130, 50] });
  document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(10).text("RIEPILOGO ORDINI CLIENTE", 350, 42, { width: 203, align: "right" });
  document.fillColor("#52634D").font("Helvetica").fontSize(8).text(
    `Generato il ${dateIT(report.generatedAt)}`,
    350,
    57,
    { width: 203, align: "right" },
  );
  document.moveDown(3.7);

  document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(19).text(report.customer.name, 42, document.y, { width: 511 });
  document.fillColor("#52634D").font("Helvetica").fontSize(9).text(
    `${report.customer.vatNumber ? `P. IVA ${report.customer.vatNumber} · ` : ""}Periodo ${dateIT(report.period.from)} — ${dateIT(report.period.to)}`,
    42,
    document.y,
    { width: 511 },
  );
  document.fontSize(8).text(
    `Società incluse: ${report.companies.join(" · ")}${report.customer.relatedProfilesIncluded ? " · anagrafiche collegate incluse" : ""}`,
    42,
    document.y,
    { width: 511 },
  );
  document.moveDown(1.1);

  const cards = [
    ["ORDINI", String(report.totals.orderCount)],
    ["NETTO", euro(report.totals.subtotalNet)],
    ["IVA", euro(report.totals.vatAmount)],
    ["TOTALE", euro(report.totals.totalGross)],
    ["COPERTO DA CREDITO", euro(report.totals.creditCovered)],
  ];
  const cardWidth = 98;
  const cardsY = document.y;
  cards.forEach(([label, value], index) => {
    const x = 42 + index * 102;
    document.roundedRect(x, cardsY, cardWidth, 43, 4).fillAndStroke("#F3F7ED", "#D9E8D4");
    document.fillColor("#52634D").font("Helvetica-Bold").fontSize(6.5).text(label, x + 7, cardsY + 8, { width: cardWidth - 14 });
    document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(10).text(value, x + 7, cardsY + 22, { width: cardWidth - 14 });
  });
  document.y = cardsY + 55;

  document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(12).text("Ordini inclusi", 42, document.y, { width: 511 });
  document.moveDown(0.35);
  const orderColumns = [42, 112, 178, 286, 355, 425, 493];
  const orderHeaders = ["Ordine", "Data", "Società", "Stato", "Netto", "Lordo", "Credito"];
  const orderHeaderY = document.y;
  document.font("Helvetica-Bold").fontSize(7).fillColor("#FFFFFF");
  document.rect(42, orderHeaderY, 511, 17).fill("#2D5A27");
  orderHeaders.forEach((header, index) => document.fillColor("#FFFFFF").text(header, orderColumns[index] + 4, orderHeaderY + 5, { width: (orderColumns[index + 1] ?? 553) - orderColumns[index] - 8 }));
  document.y = orderHeaderY + 21;

  const includedOrders = report.orders.filter((order) => order.status !== "cancelled");
  for (const order of includedOrders) {
    ensureSpace(36);
    const rowY = document.y;
    document.rect(42, rowY, 511, 27).fillAndStroke("#FFFFFF", "#E4EDE0");
    const cells = [order.orderNumber, dateIT(order.orderDate), order.companyName, orderStatusLabel(order.status), euro(order.subtotalNet), euro(order.totalGross), euro(order.creditCovered)];
    cells.forEach((cell, index) => {
      const right = index >= 4;
      drawText(cell, orderColumns[index] + 4, rowY + 6, {
        width: (orderColumns[index + 1] ?? 553) - orderColumns[index] - 8,
        align: right ? "right" : "left",
        fontSize: 7,
      });
    });
    document.y = rowY + 31;
  }

  document.moveDown(0.8);
  document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(12).text("Dettaglio prodotti", 42, document.y, { width: 511 });
  document.moveDown(0.35);
  for (const order of includedOrders) {
    const drawOrderHeader = (continues = false) => {
      document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(9).text(
        `${order.orderNumber} · ${dateIT(order.orderDate)} · ${order.companyName}${continues ? " (continua)" : ""}`,
        42,
        document.y,
        { width: 511 },
      );
      document.fillColor("#52634D").font("Helvetica").fontSize(7).text(`Stato: ${orderStatusLabel(order.status)}`, 42, document.y, { width: 511 });
      document.moveDown(0.25);
      const detailHeaderY = document.y;
      document.font("Helvetica-Bold").fontSize(7).fillColor("#52634D").text("Prodotto", 42, detailHeaderY, { width: 260 });
      document.text("Q.tà", 306, detailHeaderY, { width: 42, align: "right" });
      document.text("Prezzo unit.", 353, detailHeaderY, { width: 76, align: "right" });
      document.text("Totale riga", 432, detailHeaderY, { width: 60, align: "right" });
      document.text("Credito", 497, detailHeaderY, { width: 56, align: "center" });
      document.y = detailHeaderY + 13;
    };
    document.font("Helvetica").fontSize(7);
    const firstItemHeight = Math.max(16, document.heightOfString(order.items[0]?.productName ?? "", { width: 260 }) + 2);
    ensureSpace(44 + firstItemHeight);
    drawOrderHeader();
    for (const item of order.items) {
      document.font("Helvetica").fontSize(7);
      const itemHeight = Math.max(16, document.heightOfString(item.productName, { width: 260 }) + 2);
      if (document.y + itemHeight + 3 > pageBottom()) {
        document.addPage();
        drawOrderHeader(true);
      }
      const itemY = document.y;
      document.font("Helvetica").fontSize(7).fillColor("#213421").text(item.productName, 42, itemY, { width: 260 });
      document.text(String(item.quantity), 306, itemY, { width: 42, align: "right" });
      document.text(euro(item.unitPriceFinal), 353, itemY, { width: 76, align: "right" });
      document.text(euro(item.lineTotalNet), 432, itemY, { width: 60, align: "right" });
      document.fillColor(item.creditCovered > 0 ? "#2D5A27" : "#52634D").text(item.creditCovered > 0 ? "Coperto\ncredito" : "—", 497, itemY, { width: 56, align: "center" });
      document.y = itemY + itemHeight;
    }
    drawRule();
  }

  if (report.allowances.length) {
    ensureSpace(100);
    document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(12).text("Crediti prodotti", 42, document.y, { width: 511 });
    document.fillColor("#52634D").font("Helvetica").fontSize(8).text("Riepilogo delle disponibilità di credito collegate al cliente.", 42, document.y, { width: 511 });
    document.moveDown(0.4);
    for (const allowance of report.allowances) {
      ensureSpace(34);
      const allowanceY = document.y;
      document.roundedRect(42, allowanceY, 511, 28, 3).fillAndStroke("#F3F7ED", "#D9E8D4");
      document.fillColor("#2D5A27").font("Helvetica-Bold").fontSize(8).text(formatAllowanceType(allowance.type), 50, allowanceY + 10, { width: 170 });
      document.fillColor("#52634D").font("Helvetica").fontSize(7).text(`Iniziale ${euro(allowance.initialAmount)}`, 235, allowanceY + 10, { width: 92, align: "right" });
      document.text(`Utilizzato ${euro(allowance.consumedAmount)}`, 335, allowanceY + 10, { width: 100, align: "right" });
      document.fillColor("#2D5A27").font("Helvetica-Bold").text(`Residuo ${euro(allowance.remainingAmount)}`, 442, allowanceY + 10, { width: 102, align: "right" });
      document.y = allowanceY + 34;
    }
  }

  document.moveDown(1.2);
  document.fillColor("#52634D").font("Helvetica").fontSize(7).text(
    "Le righe indicate come “Coperto credito” sono finanziate da credito. Gli ordini annullati non sono inclusi nel riepilogo né nei totali. Documento informativo generato dal gestionale SoKeto.",
    42,
    document.y,
    { width: 511 },
  );

  const range = document.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    document.switchToPage(index);
    document.fillColor("#71806D").font("Helvetica").fontSize(7).text(`Pagina ${index + 1} di ${range.count}`, 42, 780, { width: 511, align: "right" });
  }
  document.end();
  return (await done).toString("base64");
}

export async function generateCustomerOrderXlsx(report: CustomerOrderReport): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SoKeto Gestionale";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Riepilogo");
  summary.columns = [{ width: 28 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  summary.mergeCells("A1:E1");
  summary.getCell("A1").value = "Riepilogo ordini cliente";
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF2D5A27" } };
  summary.mergeCells("A2:E2");
  summary.getCell("A2").value = `${report.customer.name}${report.customer.vatNumber ? ` · P. IVA ${report.customer.vatNumber}` : ""}`;
  summary.getCell("A2").font = { bold: true, size: 11 };
  summary.mergeCells("A3:E3");
  summary.getCell("A3").value = `Periodo ${dateIT(report.period.from)} — ${dateIT(report.period.to)} · Generato il ${dateIT(report.generatedAt)}`;
  summary.getCell("A3").font = { italic: true, color: { argb: "FF52634D" } };
  summary.addRow([]);
  summary.addRow(["Riepilogo ordini non annullati", "Importo"]);
  summary.addRow(["Numero ordini", report.totals.orderCount]);
  summary.addRow(["Totale netto", report.totals.subtotalNet]);
  summary.addRow(["IVA", report.totals.vatAmount]);
  summary.addRow(["Totale lordo", report.totals.totalGross]);
  summary.addRow(["Totale coperto da credito", report.totals.creditCovered]);
  for (const row of [5, 7, 8, 9, 10]) {
    summary.getRow(row).getCell(2).numFmt = row === 5 ? "0" : '€ #,##0.00';
  }
  summary.getRow(5).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summary.getRow(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D5A27" } };
  summary.addRow([]);
  summary.addRow(["Crediti prodotti", "Iniziale", "Utilizzato", "Residuo"]);
  const allowanceHeader = summary.lastRow!;
  allowanceHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  allowanceHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D5A27" } };
  for (const allowance of report.allowances) {
    const row = summary.addRow([formatAllowanceType(allowance.type), allowance.initialAmount, allowance.consumedAmount, allowance.remainingAmount]);
    for (const cell of row.values as Array<unknown>) void cell;
    [2, 3, 4].forEach((column) => (row.getCell(column).numFmt = '€ #,##0.00'));
  }

  summary.addRow([]);
  summary.addRow(["Elenco ordini (gli annullati sono marcati e non entrano nei totali)"]);
  const orderHeader = summary.addRow(["Numero", "Data", "Società", "Stato", "Netto", "IVA", "Lordo", "Coperto da credito"]);
  orderHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  orderHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D5A27" } };
  orderHeader.eachCell((cell) => (cell.alignment = { vertical: "middle" }));
  for (const order of report.orders) {
    const row = summary.addRow([
      order.orderNumber,
      dateIT(order.orderDate),
      order.companyName,
      orderStatusLabel(order.status),
      order.subtotalNet,
      order.vatAmount,
      order.totalGross,
      order.creditCovered,
    ]);
    [5, 6, 7, 8].forEach((column) => (row.getCell(column).numFmt = '€ #,##0.00'));
    if (order.status === "cancelled") {
      row.font = { italic: true, color: { argb: "FF8A3333" } };
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDECEC" } };
    }
  }

  const details = workbook.addWorksheet("Dettaglio ordini");
  details.columns = [{ width: 18 }, { width: 14 }, { width: 22 }, { width: 16 }, { width: 42 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 20 }];
  const detailHeader = details.addRow(["Numero ordine", "Data", "Società", "Stato", "Prodotto", "Quantità", "Prezzo unitario", "Totale riga", "Copertura credito"]);
  detailHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  detailHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D5A27" } };
  for (const order of report.orders) {
    for (const item of order.items) {
      const row = details.addRow([
        order.orderNumber,
        dateIT(order.orderDate),
        order.companyName,
        orderStatusLabel(order.status),
        item.productName,
        item.quantity,
        item.unitPriceFinal,
        item.lineTotalNet,
        item.creditCovered > 0 ? "Coperto da credito" : "",
      ]);
      row.getCell(7).numFmt = '€ #,##0.00';
      row.getCell(8).numFmt = '€ #,##0.00';
      if (order.status === "cancelled") {
        row.font = { italic: true, color: { argb: "FF8A3333" } };
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDECEC" } };
      }
    }
  }

  [summary, details].forEach((sheet) => {
    sheet.views = [{ state: "frozen", ySplit: sheet === details ? 1 : 15 }];
    sheet.eachRow((row) => {
      row.alignment = { vertical: "middle", wrapText: true };
    });
  });

  const content = await workbook.xlsx.writeBuffer();
  return Buffer.from(content).toString("base64");
}

export function reportFilename(report: CustomerOrderReport, extension: "pdf" | "xlsx") {
  const safeName = report.customer.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();
  return `riepilogo-ordini-${safeName || "cliente"}-${report.period.from}-${report.period.to}.${extension}`;
}
