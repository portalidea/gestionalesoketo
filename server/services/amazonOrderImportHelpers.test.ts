import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { AmazonImportError } from "./amazonImportErrors";
import type {
  AmazonDiagnosticDetails,
  AmazonImportErrorCode,
} from "./amazonImportErrors";
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
describe("Amazon safe parser diagnostics", () => {
  const secret = "known-secret-do-not-expose";
  const email = "private-buyer@example.test";
  const rawBadValue = `raw-bad-value:${secret}:${email}`;
  const expectSafeError = (
    parse: () => unknown,
    code: AmazonImportErrorCode,
    details: AmazonDiagnosticDetails = {}
  ) => {
    let thrown: unknown;
    try {
      parse();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AmazonImportError);
    const error = thrown as AmazonImportError;
    expect(error.code).toBe(code);
    expect(error.details).toEqual(details);
    const exposed = JSON.stringify({
      ...error,
      message: error.message,
      stack: error.stack,
    });
    for (const sensitive of [secret, email, rawBadValue])
      expect(exposed).not.toContain(sensitive);
    expect(error).not.toHaveProperty("cause");
  };

  it("accepts both declared gzip and ordinary uncompressed report bytes", () => {
    const plain = parseAmazonReport(body(), "NONE");
    expect(parseAmazonReport(body())).toEqual(plain);
    expect(parseAmazonReport(gzipSync(body()), "GZIP")).toEqual(plain);
  });

  it("distinguishes compression mismatch, unsupported format, and corrupt gzip", () => {
    expectSafeError(
      () => parseAmazonReport(gzipSync(body()), "NONE"),
      "COMPRESSION_MISMATCH"
    );
    expectSafeError(
      () => parseAmazonReport(body(), "GZIP"),
      "COMPRESSION_MISMATCH"
    );
    expectSafeError(
      () => parseAmazonReport(body(), rawBadValue),
      "COMPRESSION_UNSUPPORTED"
    );
    expectSafeError(
      () =>
        parseAmazonReport(
          Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from(rawBadValue)]),
          "GZIP"
        ),
      "DOCUMENT_GZIP_INVALID"
    );
    expectSafeError(
      () => parseAmazonReport(gzipSync(body()).subarray(0, -4), "GZIP"),
      "DOCUMENT_GZIP_INVALID"
    );
  });

  it("classifies wire and decoded size limits without serializing decompression errors", () => {
    expectSafeError(
      () => parseAmazonReport(Buffer.alloc(AMAZON_REPORT_MAX_BYTES + 1)),
      "DOCUMENT_TOO_LARGE"
    );
    expectSafeError(
      () =>
        parseAmazonReport(
          gzipSync(Buffer.alloc(AMAZON_REPORT_MAX_BYTES + 1, 65)),
          "GZIP"
        ),
      "DOCUMENT_TOO_LARGE"
    );
  });

  it("classifies invalid UTF-8, NUL, and empty plain or decoded content", () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from(rawBadValue),
      Buffer.from([0xff]),
    ]);
    expectSafeError(() => parseAmazonReport(invalidUtf8), "DOCUMENT_ENCODING");
    expectSafeError(
      () => parseAmazonReport(gzipSync(invalidUtf8), "GZIP"),
      "DOCUMENT_ENCODING"
    );
    expectSafeError(
      () => parseAmazonReport(Buffer.from(`${rawBadValue}\0`)),
      "DOCUMENT_NUL"
    );
    for (const empty of [Buffer.alloc(0), Buffer.from("\uFEFF \r\n\t")]) {
      expectSafeError(() => parseAmazonReport(empty), "DOCUMENT_EMPTY");
      expectSafeError(
        () => parseAmazonReport(gzipSync(empty), "GZIP"),
        "DOCUMENT_EMPTY"
      );
    }
  });

  it("reports only the whitelisted missing header, not received header contents", () => {
    expectSafeError(
      () =>
        parseAmazonReport(
          body(
            values,
            headers.map(h => (h === "sku" ? rawBadValue : h))
          )
        ),
      "DOCUMENT_HEADER_MISSING",
      { missingHeader: "sku" }
    );
    expectSafeError(
      () =>
        parseAmazonReport(
          body(
            values,
            headers.map(h => (h === "sku" ? "quantity" : h))
          )
        ),
      "DOCUMENT_HEADERS_INVALID"
    );
  });

  it.each([
    `"${rawBadValue}`,
    `${rawBadValue}"`,
    `"${rawBadValue}"unexpected`,
    `${rawBadValue}\textra`,
  ])(
    "reports safe row number for malformed cells or column counts (%#)",
    row => {
      expectSafeError(
        () =>
          parseAmazonReport(
            Buffer.from(`${headers.join("\t")}\n${values.join("\t")}\n${row}`)
          ),
        "DOCUMENT_ROW_INVALID",
        { rowNumber: 3 }
      );
    }
  );

  it("reports the typed 2000-row limit", () => {
    expectSafeError(
      () =>
        parseAmazonReport(
          Buffer.from(
            `${headers.join("\t")}\n${Array(2001).fill(values.join("\t")).join("\n")}`
          )
        ),
      "DOCUMENT_ROWS_LIMIT"
    );
  });

  it.each([
    rawBadValue,
    "2026-09-01T10:00:00",
    "2026-02-30T10:00:00Z",
    "2026-09-01T10:00:00+24:00",
  ])("does not expose invalid timestamps (%#)", timestamp => {
    expectSafeError(
      () => parseAmazonTimestamp(timestamp),
      "DOCUMENT_TIMESTAMP_INVALID"
    );
    for (const column of [2, 3]) {
      const invalid = [...values];
      invalid[column] = timestamp;
      expectSafeError(
        () => parseAmazonReport(body(invalid)),
        "DOCUMENT_TIMESTAMP_INVALID"
      );
    }
  });

  it.each([rawBadValue, "99999999.99foo", "100000000.00", "NaN", "-1"])(
    "does not expose invalid prices or numeric overflow (%#)",
    price => {
      expectSafeError(() => parseAmazonEuro(price), "DOCUMENT_PRICE_INVALID");
    }
  );

  it.each([0, 7])("does not expose oversized identifiers (%#)", column => {
    const invalid = [...values];
    invalid[column] = `${rawBadValue}${"x".repeat(256)}`;
    expectSafeError(
      () => parseAmazonReport(body(invalid)),
      "DOCUMENT_IDENTIFIER_INVALID"
    );
  });

  it("preserves malformed price, tax, quantity, and currency quarantine behavior", () => {
    const invalid = [...values];
    invalid[8] = rawBadValue;
    invalid[9] = "USD";
    invalid[10] = rawBadValue;
    const [row] = parseAmazonReport(
      body([...invalid, rawBadValue], [...headers, "item-tax"])
    );
    expect(row).toMatchObject({
      quantity: 0,
      lineTotal: "0.00",
      unitPrice: "0.00",
      quarantineReason:
        "invalid_quantity;unsupported_currency;invalid_item_price;invalid_item_tax",
    });
    invalid[4] = "Cancelled";
    const [cancelled] = parseAmazonReport(
      body([...invalid, rawBadValue], [...headers, "item-tax"])
    );
    expect(cancelled.quarantineReason).toBeNull();
    expect(classifyAmazonRow(cancelled, "2026-09-01").status).toBe("cancelled");
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
