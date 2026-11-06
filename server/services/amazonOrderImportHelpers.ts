import { gunzipSync } from "node:zlib";
import { AmazonImportError } from "./amazonImportErrors";

export const AMAZON_REPORT_MAX_BYTES = 8 * 1024 * 1024;
export const AMAZON_REPORT_MAX_ROWS = 2000;
const CORE_HEADERS = [
  "purchase-date",
  "last-updated-date",
  "order-status",
  "item-status",
  "fulfillment-channel",
  "sku",
  "quantity",
  "currency",
  "item-price",
] as const;
const SAFE_HEADERS = [
  "amazon-order-id",
  "order-item-id",
  ...CORE_HEADERS,
  "item-tax",
] as const;
export type AmazonReportDiagnosticField =
  | (typeof SAFE_HEADERS)[number]
  | "column-count";
export type AmazonReportRowDiagnosticCode =
  | "DOCUMENT_ROW_INVALID"
  | "DOCUMENT_TIMESTAMP_INVALID"
  | "DOCUMENT_IDENTIFIER_INVALID"
  | "DOCUMENT_PRICE_INVALID";
/** Static metadata only: never include received values or unknown header names. */
export interface AmazonReportRowDiagnostics {
  rowNumber: number;
  expectedColumns?: number;
  actualColumns?: number;
  field?: AmazonReportDiagnosticField;
  code: AmazonReportRowDiagnosticCode;
}
export type AmazonStockStatus =
  | "pending"
  | "not_shipped"
  | "pre_cutoff"
  | "review_required"
  | "dry_run"
  | "processed"
  | "cancelled"
  | "post_stock_alert";
export interface AmazonReportRow {
  rowKey: string;
  source: Record<string, string>;
  orderId: string;
  orderItemId: string;
  sku: string;
  quantity: number;
  purchaseDate: Date;
  updatedAt: Date;
  itemStatus: string;
  orderStatus: string;
  fulfillmentChannel: string;
  lineTotal: string;
  unitPrice: string;
  quarantineReason: string | null;
  rowDiagnostics?: AmazonReportRowDiagnostics;
}

/** Explicit ISO timezone only; validate calendar components before constructing. */
export function parseAmazonTimestamp(value: string): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match) throw new AmazonImportError("DOCUMENT_TIMESTAMP_INVALID");
  const [, y, m, d, h, min, s, , zone] = match;
  const calendar = new Date(Date.UTC(+y, +m - 1, +d));
  if (
    calendar.getUTCFullYear() !== +y ||
    calendar.getUTCMonth() !== +m - 1 ||
    calendar.getUTCDate() !== +d ||
    +h > 23 ||
    +min > 59 ||
    +s > 59 ||
    (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))
  )
    throw new AmazonImportError("DOCUMENT_TIMESTAMP_INVALID");
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new AmazonImportError("DOCUMENT_TIMESTAMP_INVALID");
  return result;
}

export function amazonRomeDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** EUR line total, never multiplied by quantity. No parseFloat/silent defaults. */
export function parseAmazonMoney(
  value: string,
  currency: "EUR" | "GBP" = "EUR"
): string {
  let clean = value
    .trim()
    .replace(
      currency === "GBP"
        ? /^(?:GBP|£)\s*|\s*(?:GBP|£)$/g
        : /^(?:EUR|€)\s*|\s*(?:EUR|€)$/g,
      ""
    );
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(clean))
    clean = clean.replaceAll(".", "").replace(",", ".");
  else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(clean))
    clean = clean.replaceAll(",", "");
  else if (/^\d+(?:,\d{1,2})?$/.test(clean)) clean = clean.replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean))
    throw new AmazonImportError("DOCUMENT_PRICE_INVALID");
  const [whole, fraction = ""] = clean.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 9999999999)
    throw new AmazonImportError("DOCUMENT_PRICE_INVALID");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// Compatibilità dei test e dei chiamanti EUR: nessuna conversione valutaria.
export const parseAmazonEuro = (value: string) =>
  parseAmazonMoney(value, "EUR");

/** Amazon TSV has no quoting: tabs and physical newlines always delimit cells. */
function cells(text: string): string[][] {
  const lines = text.split(/\r\n|\n|\r/);
  // A final line terminator does not create a report row. Interior empty lines do.
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > AMAZON_REPORT_MAX_ROWS + 1)
    throw new AmazonImportError("DOCUMENT_ROWS_LIMIT");
  return lines.map(line => line.split("\t"));
}

export function parseAmazonReport(
  body: Buffer,
  compression?: string
): AmazonReportRow[] {
  if (body.length > AMAZON_REPORT_MAX_BYTES)
    throw new AmazonImportError("DOCUMENT_TOO_LARGE");
  if (compression && compression !== "GZIP" && compression !== "NONE")
    throw new AmazonImportError("COMPRESSION_UNSUPPORTED");
  if (!body.length) throw new AmazonImportError("DOCUMENT_EMPTY");
  const isGzip = body[0] === 0x1f && body[1] === 0x8b;
  if (isGzip !== (compression === "GZIP"))
    throw new AmazonImportError("COMPRESSION_MISMATCH");
  let decoded = body;
  if (compression === "GZIP") {
    try {
      decoded = gunzipSync(body, { maxOutputLength: AMAZON_REPORT_MAX_BYTES });
    } catch (error) {
      throw new AmazonImportError(
        (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
          ? "DOCUMENT_TOO_LARGE"
          : "DOCUMENT_GZIP_INVALID"
      );
    }
  }
  if (decoded.length > AMAZON_REPORT_MAX_BYTES)
    throw new AmazonImportError("DOCUMENT_TOO_LARGE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(decoded)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new AmazonImportError("DOCUMENT_ENCODING");
  }
  if (text.includes("\0")) throw new AmazonImportError("DOCUMENT_NUL");
  if (!text.trim()) throw new AmazonImportError("DOCUMENT_EMPTY");
  const table = cells(text);
  const headers = table.shift();
  if (
    !headers ||
    headers.some(header => !header.trim()) ||
    new Set(headers).size !== headers.length
  )
    throw new AmazonImportError("DOCUMENT_HEADERS_INVALID");
  for (const header of CORE_HEADERS)
    if (!headers.includes(header))
      throw new AmazonImportError("DOCUMENT_HEADER_MISSING", {
        missingHeader: header,
      });
  return table.map((values, index) => {
    const rowNumber = index + 2;
    // A structural mismatch makes every cell position untrustworthy. Do not map
    // even apparently valid IDs or persist any received values from this row.
    if (values.length !== headers.length)
      return {
        rowKey: String(rowNumber),
        source: {},
        orderId: "",
        orderItemId: "",
        sku: "",
        quantity: 0,
        purchaseDate: new Date(0),
        updatedAt: new Date(0),
        itemStatus: "",
        orderStatus: "",
        fulfillmentChannel: "",
        lineTotal: "0.00",
        unitPrice: "0.00",
        quarantineReason: `column_count_mismatch:expected=${headers.length};actual=${values.length}`,
        rowDiagnostics: {
          rowNumber,
          expectedColumns: headers.length,
          actualColumns: values.length,
          field: "column-count",
          code: "DOCUMENT_ROW_INVALID",
        },
      };
    const source: Record<string, string> = {};
    for (const header of SAFE_HEADERS)
      source[header] = (values[headers.indexOf(header)] ?? "").trim();
    const cancelled =
      source["order-status"] === "Cancelled" ||
      source["item-status"] === "Cancelled";
    const required: readonly (typeof SAFE_HEADERS)[number][] = cancelled
      ? [
          "amazon-order-id",
          "order-item-id",
          "purchase-date",
          "last-updated-date",
        ]
      : SAFE_HEADERS.filter(h => h !== "item-tax");
    const missing = required.filter(header => !source[header]);
    const issues: string[] = missing.length
      ? [`missing_fields:${missing.join(",")}`]
      : [];
    // One primary diagnostic; all issues remain in the value-free reason.
    let rowDiagnostics: AmazonReportRowDiagnostics | undefined;
    const diagnose = (
      field: AmazonReportDiagnosticField,
      code: AmazonReportRowDiagnosticCode
    ) => {
      rowDiagnostics ??= { rowNumber, field, code };
    };
    if (missing.length) diagnose(missing[0], "DOCUMENT_ROW_INVALID");
    // Missing mandatory values are quarantined, not converted into fake IDs or stock.
    // Invalid dates/quantity also use placeholders confined to observations.
    let unreliableDates = false;
    const timestamp = (field: "purchase-date" | "last-updated-date") => {
      if (!source[field]) {
        unreliableDates = true;
        return new Date(0);
      }
      try {
        return parseAmazonTimestamp(source[field]);
      } catch {
        unreliableDates = true;
        issues.push(`invalid_timestamp:${field}`);
        diagnose(field, "DOCUMENT_TIMESTAMP_INVALID");
        return new Date(0);
      }
    };
    const purchaseDate = timestamp("purchase-date");
    const updatedAt = timestamp("last-updated-date");
    const validQuantity =
      /^[1-9]\d*$/.test(source.quantity) &&
      Number.isSafeInteger(Number(source.quantity)) &&
      Number(source.quantity) <= 2147483647;
    if (!cancelled && source.quantity && !validQuantity) {
      issues.push("invalid_quantity");
      diagnose("quantity", "DOCUMENT_ROW_INVALID");
    }
    if (
      !cancelled &&
      source.currency &&
      !["EUR", "GBP"].includes(source.currency)
    ) {
      issues.push("unsupported_currency");
      diagnose("currency", "DOCUMENT_ROW_INVALID");
    }
    for (const field of ["amazon-order-id", "order-item-id", "sku"] as const) {
      if (source[field].length > 255) {
        issues.push(`invalid_identifier:${field}`);
        diagnose(field, "DOCUMENT_IDENTIFIER_INVALID");
        source[field] = "";
      }
    }
    // Unusable dates must not identify an existing line for stale updates.
    if (unreliableDates) {
      source["amazon-order-id"] = "";
      source["order-item-id"] = "";
    }
    const quantity = validQuantity ? Number(source.quantity) : 0;
    let lineTotal = "0.00";
    try {
      if (source["item-price"])
        lineTotal = parseAmazonMoney(
          source["item-price"],
          source.currency === "GBP" ? "GBP" : "EUR"
        );
    } catch {
      issues.push("invalid_item_price");
      diagnose("item-price", "DOCUMENT_PRICE_INVALID");
    }
    try {
      if (source["item-tax"])
        source["item-tax"] = parseAmazonMoney(
          source["item-tax"],
          source.currency === "GBP" ? "GBP" : "EUR"
        );
    } catch {
      issues.push("invalid_item_tax");
      diagnose("item-tax", "DOCUMENT_PRICE_INVALID");
    }
    const cents = Number(lineTotal.replace(".", ""));
    const unitCents = quantity
      ? Math.floor((cents + Math.floor(quantity / 2)) / quantity)
      : 0;
    return {
      rowKey: String(rowNumber),
      source,
      orderId: source["amazon-order-id"],
      orderItemId: source["order-item-id"],
      sku: source.sku,
      quantity,
      purchaseDate,
      updatedAt,
      itemStatus: source["item-status"],
      orderStatus: source["order-status"],
      fulfillmentChannel: source["fulfillment-channel"],
      lineTotal,
      unitPrice: `${Math.floor(unitCents / 100)}.${String(unitCents % 100).padStart(2, "0")}`,
      quarantineReason: issues.length ? issues.join(";") : null,
      ...(rowDiagnostics ? { rowDiagnostics } : {}),
    };
  });
}

export function classifyAmazonRow(
  row: Pick<
    AmazonReportRow,
    "purchaseDate" | "itemStatus" | "orderStatus" | "fulfillmentChannel"
  >,
  cutoff: string
): { status: AmazonStockStatus; reason: string | null } {
  if (row.orderStatus === "Cancelled" || row.itemStatus === "Cancelled")
    return { status: "cancelled", reason: "amazon_cancelled" };
  if (amazonRomeDate(row.purchaseDate) < cutoff)
    return { status: "pre_cutoff", reason: "purchase_date_before_cutoff" };
  if (row.fulfillmentChannel !== "Merchant")
    return {
      status: "review_required",
      reason:
        row.fulfillmentChannel === "Amazon"
          ? "fba_no_stock"
          : "unknown_fulfillment_channel",
    };
  if (row.itemStatus !== "Shipped") {
    if (
      ["Unshipped", "Shipping", "Pending", "PendingAvailability"].includes(
        row.itemStatus
      )
    )
      return { status: "not_shipped", reason: "item_not_shipped" };
    return { status: "review_required", reason: "unknown_item_status" };
  }
  return { status: "pending", reason: null };
}

export interface AmazonProductRequirement {
  productId: string;
  pieces: number;
}
export interface AmazonFefoLot {
  productId: string;
  batchId: string;
  inventoryId: string;
  batchNumber: string;
  expirationDate: string;
  quantity: number;
}
export interface AmazonFefoAllocation extends Omit<AmazonFefoLot, "quantity"> {
  pieces: number;
  availableBefore: number;
}
export function planAmazonFefo(
  requirements: AmazonProductRequirement[],
  lots: AmazonFefoLot[],
  reservations: Map<string, number> = new Map()
): {
  allocations: AmazonFefoAllocation[];
  shortfalls: AmazonProductRequirement[];
} {
  const totals = new Map<string, number>();
  for (const r of requirements) {
    if (!Number.isInteger(r.pieces) || r.pieces <= 0 || r.pieces > 2147483647)
      throw new Error("Invalid Amazon pieces requirement");
    totals.set(r.productId, (totals.get(r.productId) ?? 0) + r.pieces);
  }
  const allocations: AmazonFefoAllocation[] = [],
    shortfalls: AmazonProductRequirement[] = [];
  const sorted = [...lots].sort(
    (a, b) =>
      a.expirationDate.localeCompare(b.expirationDate) ||
      a.batchId.localeCompare(b.batchId)
  );
  for (const [productId, required] of Array.from(totals).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (required > 2147483647)
      throw new Error("Amazon aggregate pieces overflow");
    let remaining = required;
    for (const lot of sorted.filter(l => l.productId === productId)) {
      const availableBefore = Math.max(
        0,
        lot.quantity - (reservations.get(lot.inventoryId) ?? 0)
      );
      const pieces = Math.min(remaining, availableBefore);
      if (pieces)
        allocations.push({
          productId,
          batchId: lot.batchId,
          inventoryId: lot.inventoryId,
          batchNumber: lot.batchNumber,
          expirationDate: lot.expirationDate,
          pieces,
          availableBefore,
        });
      remaining -= pieces;
      if (!remaining) break;
    }
    if (remaining) shortfalls.push({ productId, pieces: remaining });
  }
  // Atomic per line: failed bundles reserve/allocate nothing whatsoever.
  if (shortfalls.length) return { allocations: [], shortfalls };
  for (const a of allocations)
    reservations.set(
      a.inventoryId,
      (reservations.get(a.inventoryId) ?? 0) + a.pieces
    );
  return { allocations, shortfalls };
}
