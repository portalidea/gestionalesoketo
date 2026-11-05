import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  AMAZON_REPORT_MAX_BYTES,
  amazonRomeDate,
  classifyAmazonRow,
  parseAmazonEuro,
  parseAmazonReport,
  parseAmazonTimestamp,
  planAmazonFefo,
} from "./amazonOrderImportHelpers";
const headers = [
  "amazon-order-id",
  "order-item-id",
  "purchase-date",
  "last-updated-date",
  "order-status",
  "item-status",
  "fulfillment-channel",
  "sku",
  "quantity",
  "currency",
  "item-price",
];
const values = [
  "order-1",
  "item-1",
  "2026-08-31T23:30:00Z",
  "2026-09-02T12:00:00+02:00",
  "PartiallyShipped",
  "Shipped",
  "Merchant",
  "PACK",
  "2",
  "EUR",
  "12.00",
];
const body = (v = values, h = headers) =>
  Buffer.from(`${h.join("\t")}\n${v.join("\t")}\n`);

describe("Amazon strict parser", () => {
  it("BOM, gzip, headers by name and minimal no-PII snapshot; item-price is line total", () => {
    const report = Buffer.from(
      `\uFEFF${[...headers, "buyer-email"].join("\t")}\n${[...values, "never-store@example.test"].join("\t")}\n`
    );
    const [row] = parseAmazonReport(gzipSync(report), "GZIP");
    expect(row).toMatchObject({
      orderItemId: "item-1",
      quantity: 2,
      lineTotal: "12.00",
      unitPrice: "6.00",
      quarantineReason: null,
    });
    expect(row.source).not.toHaveProperty("buyer-email");
    const reversed = parseAmazonReport(
      body([...values].reverse(), [...headers].reverse()),
      "NONE"
    );
    expect(reversed[0].orderId).toBe("order-1");
  });
  it("supports RFC-style quoted CSV and TSV including escaped quotes", () => {
    const csv = `${headers.join(",")}\r\n${values.map((v, i) => `"${i === 7 ? 'P,"ACK' : v}"`.replace('P,"ACK', 'P,""ACK')).join(",")}\r\n`;
    expect(parseAmazonReport(Buffer.from(csv))[0].sku).toBe('P,"ACK');
    const tsvValues = [...values];
    tsvValues[7] = '"P\tACK"';
    expect(parseAmazonReport(body(tsvValues))[0].sku).toBe("P\tACK");
  });
  it("missing identity is quarantined without fabricated IDs", () => {
    const missing = [...values];
    missing[1] = "";
    expect(parseAmazonReport(body(missing))[0]).toMatchObject({
      orderItemId: "",
      quarantineReason: "missing_fields:order-item-id",
    });
    expect(
      parseAmazonReport(
        body(
          values.filter((_, i) => i !== 1),
          headers.filter((_, i) => i !== 1)
        )
      )[0].quarantineReason
    ).toContain("order-item-id");
  });
  it.each(["0", "-1", "1.2", "2xyz", "2147483648"])(
    "rejects invalid quantity %s",
    value => {
      const v = [...values];
      v[8] = value;
      expect(parseAmazonReport(body(v))[0].quarantineReason).toContain(
        "invalid_quantity"
      );
    }
  );
  it("rejects malformed documents and duplicate/missing headers atomically", () => {
    expect(() =>
      parseAmazonReport(Buffer.from(`${headers.join("\t")}\n"unterminated`))
    ).toThrow();
    expect(() => parseAmazonReport(body(values.slice(0, -1)))).toThrow();
    expect(() =>
      parseAmazonReport(
        body(
          values,
          headers.map(h => (h === "sku" ? "quantity" : h))
        )
      )
    ).toThrow();
    expect(() =>
      parseAmazonReport(
        body(
          values,
          headers.map(h => (h === "sku" ? "SKU" : h))
        )
      )
    ).toThrow("sku");
    expect(() => parseAmazonReport(Buffer.from([0xff]))).toThrow();
    expect(() => parseAmazonReport(body(), "ZIP")).toThrow();
  });
  it("rejects oversized decoded gzip and >2000 data rows", () => {
    expect(() =>
      parseAmazonReport(
        gzipSync(Buffer.alloc(AMAZON_REPORT_MAX_BYTES + 1, 65)),
        "GZIP"
      )
    ).toThrow();
    expect(() =>
      parseAmazonReport(
        Buffer.from(
          `${headers.join("\t")}\n${Array(2001).fill(values.join("\t")).join("\n")}`
        )
      )
    ).toThrow("2000");
  });
  it("requires explicit timezone and valid calendar timestamps", () => {
    for (const v of [
      "2026-09-01T10:00:00",
      "2026-02-30T10:00:00Z",
      "2026-09-01T24:00:00Z",
      "2026-09-01",
    ])
      expect(() => parseAmazonTimestamp(v)).toThrow();
    expect(amazonRomeDate(parseAmazonTimestamp("2026-08-31T22:00:00Z"))).toBe(
      "2026-09-01"
    );
  });
  it("parses EUR decimals cleanly and rejects ambiguous/malformed prices", () => {
    expect(parseAmazonEuro("€ 1.234,50")).toBe("1234.50");
    expect(parseAmazonEuro("1,234.50 EUR")).toBe("1234.50");
    expect(parseAmazonEuro("12,5")).toBe("12.50");
    for (const v of ["12foo", "-1", "1.234", "", "NaN"])
      expect(() => parseAmazonEuro(v)).toThrow();
  });
});
describe("Amazon eligibility and all-or-nothing FEFO", () => {
  const eligible = {
    purchaseDate: parseAmazonTimestamp(values[2]),
    itemStatus: "Shipped",
    orderStatus: "PartiallyShipped",
    fulfillmentChannel: "Merchant",
  };
  it("uses item Shipped+Merchant even for partially shipped order, cancellation overrides", () => {
    expect(classifyAmazonRow(eligible, "2026-09-01").status).toBe("pending");
    expect(
      classifyAmazonRow({ ...eligible, orderStatus: "Cancelled" }, "2026-09-01")
        .status
    ).toBe("cancelled");
    expect(
      classifyAmazonRow(
        {
          ...eligible,
          purchaseDate: parseAmazonTimestamp("2026-08-31T21:59:59Z"),
        },
        "2026-09-01"
      ).status
    ).toBe("pre_cutoff");
    expect(
      classifyAmazonRow(
        { ...eligible, fulfillmentChannel: "Amazon" },
        "2026-09-01"
      ).status
    ).toBe("review_required");
    expect(
      classifyAmazonRow(
        { ...eligible, fulfillmentChannel: "???" },
        "2026-09-01"
      ).status
    ).toBe("review_required");
    expect(
      classifyAmazonRow({ ...eligible, itemStatus: "Returned" }, "2026-09-01")
        .status
    ).toBe("review_required");
  });
  const lots = [
    {
      productId: "p1",
      batchId: "later",
      inventoryId: "i2",
      batchNumber: "L",
      expirationDate: "2027-02-01",
      quantity: 10,
    },
    {
      productId: "p1",
      batchId: "first",
      inventoryId: "i1",
      batchNumber: "F",
      expirationDate: "2027-01-01",
      quantity: 3,
    },
  ];
  it("FEFO and in-memory reservation across rows prevent preview overpromise", () => {
    const reservations = new Map<string, number>();
    const first = planAmazonFefo(
      [{ productId: "p1", pieces: 6 }],
      lots,
      reservations
    );
    expect(first.allocations.map(a => [a.batchId, a.pieces])).toEqual([
      ["first", 3],
      ["later", 3],
    ]);
    expect(
      planAmazonFefo([{ productId: "p1", pieces: 8 }], lots, reservations)
    ).toEqual({
      allocations: [],
      shortfalls: [{ productId: "p1", pieces: 1 }],
    });
    expect(reservations.get("i2")).toBe(3);
    expect(lots[1].quantity).toBe(3);
  });
  it("bundle all or nothing, aggregates repeated product atoms", () => {
    const r = new Map<string, number>();
    expect(
      planAmazonFefo(
        [
          { productId: "p1", pieces: 2 },
          { productId: "p2", pieces: 1 },
        ],
        lots,
        r
      ).allocations
    ).toEqual([]);
    expect(r.size).toBe(0);
    expect(
      planAmazonFefo(
        [
          { productId: "p1", pieces: 1 },
          { productId: "p1", pieces: 2 },
        ],
        lots
      ).allocations[0].pieces
    ).toBe(3);
  });
});
