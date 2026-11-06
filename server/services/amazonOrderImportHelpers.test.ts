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
  it("does not autodetect CSV or accept quoted TSV header names", () => {
    for (const report of [
      `${headers.join(",")}\r\n${values.map(v => `"${v}"`).join(",")}\r\n`,
      `${headers.map(h => `"${h}"`).join("\t")}\n${values.join("\t")}\n`,
    ]) {
      expect(() => parseAmazonReport(Buffer.from(report))).toThrow(
        "Intestazione obbligatoria Amazon mancante"
      );
    }
  });
  it.each([
    'Snack "Keto" al cioccolato',
    '"Snack ""Keto"""',
    'Snack """"" ripetuti',
    '"Snack senza chiusura',
    'Snack senza apertura"',
    '",comma,""literal',
  ])("treats product-name quotes as ordinary TSV characters (%#)", title => {
    const report = Buffer.from(
      `${[...headers, "product-name"].join("\t")}\n${[...values, title].join("\t")}\n${[...values, '"following title'].join("\t")}\n`
    );
    const rows = parseAmazonReport(report);
    expect(rows).toHaveLength(2);
    for (const [index, row] of Array.from(rows.entries())) {
      expect(row).toMatchObject({
        rowKey: String(index + 2),
        orderId: "order-1",
        sku: "PACK",
        quarantineReason: null,
      });
      expect(row.source).not.toHaveProperty("product-name");
      expect(row).not.toHaveProperty("rowDiagnostics");
    }
  });
  it("preserves repeated and unmatched quotes in safe fields without unescaping", () => {
    for (const sku of ['P,""ACK', '"PACK', 'PACK"', '"""PACK""']) {
      const v = [...values];
      v[7] = sku;
      expect(parseAmazonReport(body(v))[0]).toMatchObject({
        sku,
        source: { sku },
        quarantineReason: null,
      });
    }
  });
  it("tabs and newlines are delimiters even inside apparent quotes", () => {
    const tabbed = [...values];
    tabbed[7] = '"P\tACK"';
    expect(parseAmazonReport(body(tabbed))[0]).toMatchObject({
      source: {},
      quarantineReason: "column_count_mismatch:expected=11;actual=12",
    });
    const h = [...headers, "product-name"];
    const rows = parseAmazonReport(
      Buffer.from(
        `${h.join("\t")}\n${[...values, '"line one\nline two"'].join("\t")}\n${[...values, "normal"].join("\t")}\n`
      )
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].quarantineReason).toBeNull();
    expect(rows[1]).toMatchObject({ rowKey: "3", source: {} });
    expect(rows[2]).toMatchObject({ rowKey: "4", quarantineReason: null });
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
  it("rejects duplicate/missing headers and invalid transport atomically", () => {
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
    expect(() => parseAmazonReport(Buffer.from(values.join("\t")))).toThrow();
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

  const expectSafeQuarantine = (
    row: ReturnType<typeof parseAmazonReport>[number]
  ) => {
    expect(row.quarantineReason).not.toBeNull();
    expect(row.rowDiagnostics).toBeDefined();
    const exposed = JSON.stringify({
      quarantineReason: row.quarantineReason,
      rowDiagnostics: row.rowDiagnostics,
    });
    for (const sensitive of [secret, email, rawBadValue])
      expect(exposed).not.toContain(sensitive);
    for (const key of Object.keys(row.rowDiagnostics!))
      expect([
        "rowNumber",
        "expectedColumns",
        "actualColumns",
        "field",
        "code",
      ]).toContain(key);
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
    "quarantines short physical rows without quote parsing or raw diagnostics (%#)",
    row => {
      const rows = parseAmazonReport(
        Buffer.from(`${headers.join("\t")}\n${values.join("\t")}\n${row}`)
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].quarantineReason).toBeNull();
      expect(rows[1]).toMatchObject({
        rowKey: "3",
        source: {},
        orderId: "",
        orderItemId: "",
        sku: "",
        quarantineReason: `column_count_mismatch:expected=11;actual=${row.split("\t").length}`,
        rowDiagnostics: {
          rowNumber: 3,
          expectedColumns: 11,
          actualColumns: row.split("\t").length,
          field: "column-count",
          code: "DOCUMENT_ROW_INVALID",
        },
      });
      expectSafeQuarantine(rows[1]);
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
      const [row] = parseAmazonReport(body(invalid));
      expect(row).toMatchObject({
        orderId: "",
        orderItemId: "",
        source: { "amazon-order-id": "", "order-item-id": "" },
        quarantineReason: `invalid_timestamp:${headers[column]}`,
        rowDiagnostics: {
          rowNumber: 2,
          field: headers[column],
          code: "DOCUMENT_TIMESTAMP_INVALID",
        },
      });
      expect(row[column === 2 ? "purchaseDate" : "updatedAt"].getTime()).toBe(
        0
      );
      expectSafeQuarantine(row);
      expect(row.source).not.toHaveProperty("buyer-email");
    }
  });

  it.each([rawBadValue, "99999999.99foo", "100000000.00", "NaN", "-1"])(
    "does not expose invalid prices or numeric overflow (%#)",
    price => {
      expectSafeError(() => parseAmazonEuro(price), "DOCUMENT_PRICE_INVALID");
    }
  );

  it.each([0, 1, 7])(
    "quarantines and clears oversized identifiers (%#)",
    column => {
      const invalid = [...values];
      invalid[column] = `${rawBadValue}${"x".repeat(256)}`;
      const [row] = parseAmazonReport(body(invalid));
      expect(row).toMatchObject({
        quarantineReason: `invalid_identifier:${headers[column]}`,
        rowDiagnostics: {
          rowNumber: 2,
          field: headers[column],
          code: "DOCUMENT_IDENTIFIER_INVALID",
        },
      });
      expect(row.source[headers[column]]).toBe("");
      expect(
        row[column === 0 ? "orderId" : column === 1 ? "orderItemId" : "sku"]
      ).toBe("");
      expectSafeQuarantine(row);
    }
  );

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
    expect(row.rowDiagnostics).toEqual({
      rowNumber: 2,
      field: "quantity",
      code: "DOCUMENT_ROW_INVALID",
    });
    expectSafeQuarantine(row);
    invalid[4] = "Cancelled";
    const [cancelled] = parseAmazonReport(
      body([...invalid, rawBadValue], [...headers, "item-tax"])
    );
    // Cancellation does not excuse malformed amounts that are actually present.
    expect(cancelled.quarantineReason).toBe(
      "invalid_item_price;invalid_item_tax"
    );
    expect(cancelled.rowDiagnostics).toEqual({
      rowNumber: 2,
      field: "item-price",
      code: "DOCUMENT_PRICE_INVALID",
    });
    expectSafeQuarantine(cancelled);
    expect(classifyAmazonRow(cancelled, "2026-09-01").status).toBe("cancelled");
  });
});

describe("Amazon physical TSV row quarantine", () => {
  it.each([
    { invalid: values.slice(0, -1) },
    { invalid: [...values, "private-buyer@example.test"] },
  ])(
    "returns an empty observation for fewer/more columns and keeps valid neighbors (%#)",
    ({ invalid }) => {
      const report = Buffer.from(
        `${headers.join("\t")}\n${values.join("\t")}\n${invalid.join("\t")}\n${values.join("\t")}\n`
      );
      const rows = parseAmazonReport(report);
      expect(rows).toHaveLength(3);
      expect(rows.map(row => row.rowKey)).toEqual(["2", "3", "4"]);
      expect(rows[0].quarantineReason).toBeNull();
      expect(rows[2].quarantineReason).toBeNull();
      expect(rows[1]).toEqual({
        rowKey: "3",
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
        quarantineReason: `column_count_mismatch:expected=11;actual=${invalid.length}`,
        rowDiagnostics: {
          rowNumber: 3,
          expectedColumns: 11,
          actualColumns: invalid.length,
          field: "column-count",
          code: "DOCUMENT_ROW_INVALID",
        },
      });
      expect(JSON.stringify(rows[1])).not.toContain("private-buyer");
    }
  );

  it("reports physical row 29 with BOM/CRLF and no shifting after an empty physical line", () => {
    const lines = [headers.join("\t"), ...Array(27).fill(values.join("\t"))];
    // Row 10 is empty but still counts physically; it must not renumber row 29.
    lines[9] = "";
    lines.push([...values, "never-store@example.test"].join("\t"));
    lines.push(values.join("\t"));
    const rows = parseAmazonReport(
      Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`)
    );
    expect(rows).toHaveLength(29);
    expect(rows[8]).toMatchObject({
      rowKey: "10",
      source: {},
      rowDiagnostics: { rowNumber: 10, actualColumns: 1 },
    });
    expect(rows[26]).toMatchObject({ rowKey: "28", quarantineReason: null });
    expect(rows[27]).toMatchObject({
      rowKey: "29",
      source: {},
      quarantineReason: "column_count_mismatch:expected=11;actual=12",
      rowDiagnostics: {
        rowNumber: 29,
        expectedColumns: 11,
        actualColumns: 12,
        field: "column-count",
        code: "DOCUMENT_ROW_INVALID",
      },
    });
    expect(rows[28]).toMatchObject({ rowKey: "30", quarantineReason: null });
  });

  it.each(["\n", "\r\n", "\r"])(
    "supports physical line terminator %# with BOM and trailing empty cells",
    newline => {
      const report = `\uFEFF${[...headers, "product-name"].join("\t")}${newline}${[...values, ""].join("\t")}${newline}`;
      const rows = parseAmazonReport(Buffer.from(report));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rowKey: "2", quarantineReason: null });
    }
  );

  it.each([2, 3])(
    "quarantines semantic timestamp errors between valid rows (%#)",
    column => {
      const invalid = [...values];
      invalid[column] = "2026-02-30T12:00:00Z";
      const rows = parseAmazonReport(
        Buffer.from(
          `${headers.join("\t")}\n${values.join("\t")}\n${invalid.join("\t")}\n${values.join("\t")}\n`
        )
      );
      expect(rows).toHaveLength(3);
      expect(rows[0].quarantineReason).toBeNull();
      expect(rows[1]).toMatchObject({
        rowKey: "3",
        orderId: "",
        orderItemId: "",
        quarantineReason: `invalid_timestamp:${headers[column]}`,
        rowDiagnostics: {
          rowNumber: 3,
          field: headers[column],
          code: "DOCUMENT_TIMESTAMP_INVALID",
        },
      });
      expect(rows[2].quarantineReason).toBeNull();
    }
  );

  it.each(["item-price", "item-tax"])(
    "quarantines malformed money in %s without leaking values",
    field => {
      const h = [...headers, "item-tax", "buyer-email", "product-name"];
      const v = [
        ...values,
        "1.00",
        "private-buyer@example.test",
        '"quoted title',
      ];
      v[h.indexOf(field)] = "customer-secret-malformed-money";
      const rows = parseAmazonReport(
        Buffer.from(
          `${h.join("\t")}\n${[...values, "1.00", "a@example.test", "before"].join("\t")}\n${v.join("\t")}\n${[...values, "1.00", "b@example.test", "after"].join("\t")}\n`
        )
      );
      expect(rows.map(row => row.quarantineReason)).toEqual([
        null,
        field === "item-price" ? "invalid_item_price" : "invalid_item_tax",
        null,
      ]);
      expect(rows[1].rowDiagnostics).toEqual({
        rowNumber: 3,
        field,
        code: "DOCUMENT_PRICE_INVALID",
      });
      expect(rows[1].source).not.toHaveProperty("buyer-email");
      expect(rows[1].source).not.toHaveProperty("product-name");
      expect(JSON.stringify(rows[1].rowDiagnostics)).not.toContain(
        "customer-secret"
      );
      expect(rows[1].quarantineReason).not.toContain("customer-secret");
    }
  );

  it("preserves missing ID header quarantine rather than making those headers fatal", () => {
    const rows = parseAmazonReport(body(values.slice(2), headers.slice(2)));
    expect(rows[0]).toMatchObject({
      orderId: "",
      orderItemId: "",
      purchaseDate: parseAmazonTimestamp(values[2]),
      quarantineReason: "missing_fields:amazon-order-id,order-item-id",
      rowDiagnostics: {
        rowNumber: 2,
        field: "amazon-order-id",
        code: "DOCUMENT_ROW_INVALID",
      },
    });
  });

  it("clears IDs for missing dates too while keeping the legacy missing-fields reason", () => {
    const v = [...values];
    v[2] = "";
    expect(parseAmazonReport(body(v))[0]).toMatchObject({
      orderId: "",
      orderItemId: "",
      purchaseDate: new Date(0),
      quarantineReason: "missing_fields:purchase-date",
      rowDiagnostics: {
        rowNumber: 2,
        field: "purchase-date",
        code: "DOCUMENT_ROW_INVALID",
      },
    });
  });

  it("keeps missing optional amounts and quantity exempt for valid cancellation rows", () => {
    const cancelled = [...values];
    cancelled[4] = "Cancelled";
    for (const index of [5, 6, 7, 8, 9, 10]) cancelled[index] = "";
    const [row] = parseAmazonReport(body(cancelled));
    expect(row.quarantineReason).toBeNull();
    expect(row).not.toHaveProperty("rowDiagnostics");
  });

  it("accepts 255-character IDs/SKU and exactly 2000 physical data rows", () => {
    const v = [...values];
    for (const index of [0, 1, 7]) v[index] = "x".repeat(255);
    expect(parseAmazonReport(body(v))[0].quarantineReason).toBeNull();
    const report = `${headers.join("\t")}\r\n${Array(2000).fill(values.join("\t")).join("\r\n")}\r\n`;
    const rows = parseAmazonReport(Buffer.from(report));
    expect(rows).toHaveLength(2000);
    expect(rows[1999].rowKey).toBe("2001");
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
