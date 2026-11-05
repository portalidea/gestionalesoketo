import { gunzipSync } from "node:zlib";

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
}

/** Explicit ISO timezone only; validate calendar components before constructing. */
export function parseAmazonTimestamp(value: string): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match)
    throw new Error(`Amazon timestamp requires explicit timezone: ${value}`);
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
    throw new Error(`Invalid Amazon timestamp: ${value}`);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new Error(`Invalid Amazon timestamp: ${value}`);
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
    throw new Error(`Invalid EUR item-price: ${value}`);
  const [whole, fraction = ""] = clean.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 9999999999)
    throw new Error("Amazon item-price exceeds numeric(10,2)");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// Compatibilità dei test e dei chiamanti EUR: nessuna conversione valutaria.
export const parseAmazonEuro = (value: string) =>
  parseAmazonMoney(value, "EUR");

function cells(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const endField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    if (rows.length > AMAZON_REPORT_MAX_ROWS + 1)
      throw new Error("Amazon report exceeds 2000 rows");
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === delimiter) endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (c === '"') {
      if (field || closed) throw new Error("Malformed Amazon quote");
      quoted = true;
    } else {
      if (closed) throw new Error("Unexpected text after Amazon quoted field");
      field += c;
    }
  }
  if (quoted) throw new Error("Unterminated Amazon quoted field");
  if (field || row.length || closed) endRow();
  return rows;
}

export function parseAmazonReport(
  body: Buffer,
  compression?: string
): AmazonReportRow[] {
  if (body.length > AMAZON_REPORT_MAX_BYTES)
    throw new Error("Amazon report exceeds 8MB");
  if (compression && compression !== "GZIP" && compression !== "NONE")
    throw new Error("Unsupported Amazon compression");
  const decoded =
    compression === "GZIP"
      ? gunzipSync(body, { maxOutputLength: AMAZON_REPORT_MAX_BYTES })
      : body;
  if (decoded.length > AMAZON_REPORT_MAX_BYTES)
    throw new Error("Decoded Amazon report exceeds 8MB");
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(decoded)
    .replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw new Error("Amazon report contains NUL");
  const firstLine = text.split(/\r?\n/, 1)[0];
  const table = cells(text, firstLine.includes("\t") ? "\t" : ",");
  const headers = table.shift();
  if (!headers || new Set(headers).size !== headers.length)
    throw new Error("Missing or duplicate Amazon headers");
  for (const header of CORE_HEADERS)
    if (!headers.includes(header))
      throw new Error(`Missing Amazon header ${header}`);
  return table.map((values, index) => {
    if (values.length !== headers.length)
      throw new Error(`Malformed Amazon row ${index + 2}: column count`);
    const source: Record<string, string> = {};
    for (const header of SAFE_HEADERS)
      source[header] = (values[headers.indexOf(header)] ?? "").trim();
    const cancelled =
      source["order-status"] === "Cancelled" ||
      source["item-status"] === "Cancelled";
    const required = cancelled
      ? [
          "amazon-order-id",
          "order-item-id",
          "purchase-date",
          "last-updated-date",
        ]
      : SAFE_HEADERS.filter(h => h !== "item-tax");
    const missing = required.filter(header => !source[header]);
    // Missing mandatory values are quarantined, not converted into fake IDs or stock.
    // Dates/quantity below are placeholders confined to observations when missing.
    const purchaseDate = source["purchase-date"]
      ? parseAmazonTimestamp(source["purchase-date"])
      : new Date(0);
    const updatedAt = source["last-updated-date"]
      ? parseAmazonTimestamp(source["last-updated-date"])
      : new Date(0);
    const validQuantity =
      /^[1-9]\d*$/.test(source.quantity) &&
      Number.isSafeInteger(Number(source.quantity)) &&
      Number(source.quantity) <= 2147483647;
    const issues: string[] = missing.length
      ? [`missing_fields:${missing.join(",")}`]
      : [];
    if (!cancelled && source.quantity && !validQuantity)
      issues.push("invalid_quantity");
    if (
      !cancelled &&
      source.currency &&
      !["EUR", "GBP"].includes(source.currency)
    )
      issues.push("unsupported_currency");
    if (source.sku.length > 255 || source["amazon-order-id"].length > 255)
      throw new Error("Amazon identifier too long");
    const quantity = validQuantity ? Number(source.quantity) : 0;
    let lineTotal = "0.00";
    try {
      if (source["item-price"])
        lineTotal = parseAmazonMoney(
          source["item-price"],
          source.currency === "GBP" ? "GBP" : "EUR"
        );
    } catch {
      if (!cancelled) issues.push("invalid_item_price");
    }
    try {
      if (source["item-tax"])
        source["item-tax"] = parseAmazonMoney(
          source["item-tax"],
          source.currency === "GBP" ? "GBP" : "EUR"
        );
    } catch {
      if (!cancelled) issues.push("invalid_item_tax");
    }
    const cents = Number(lineTotal.replace(".", ""));
    const unitCents = quantity
      ? Math.floor((cents + Math.floor(quantity / 2)) / quantity)
      : 0;
    return {
      rowKey: String(index + 2),
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
