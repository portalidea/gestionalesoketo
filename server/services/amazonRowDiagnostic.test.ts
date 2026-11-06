import { describe, expect, it } from "vitest";
import { safeAmazonRowDiagnostic } from "./amazonRowDiagnostic";
import { safeAmazonDetails } from "./amazonImportErrors";

describe("Amazon row diagnostics — safe metadata only", () => {
  it("retains physical line number and column counts without any raw values", () => {
    const result = safeAmazonRowDiagnostic({
      code: "DOCUMENT_ROW_INVALID",
      rowNumber: 29,
      expectedColumns: 33,
      actualColumns: 32,
      field: "column-count",
      rawCells: ["PRIVATE_VALUE"],
      message: "PRIVATE_VALUE",
      buyer: "PRIVATE_VALUE",
      requestHeaders: { token: "PRIVATE_VALUE" },
    });
    expect(result).toEqual({
      code: "DOCUMENT_ROW_INVALID",
      rowNumber: 29,
      expectedColumns: 33,
      actualColumns: 32,
      field: "column-count",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_VALUE");
  });
  it("only schema fields and valid integer counts are retained", () => {
    expect(
      safeAmazonDetails({
        field: "PRIVATE_VALUE",
        expectedColumns: -1,
        actualColumns: 2.5,
        rowNumber: 29,
      })
    ).toEqual({ rowNumber: 29 });
    expect(
      safeAmazonDetails({
        field: "item-tax",
        expectedColumns: 12,
        actualColumns: 13,
      })
    ).toEqual({ field: "item-tax", expectedColumns: 12, actualColumns: 13 });
  });
  it("malicious data and non-row diagnostic codes cannot appear in admin metadata", () => {
    for (const value of [
      null,
      [],
      "PRIVATE_VALUE",
      { code: "PRIVATE_VALUE", rowNumber: 29 },
      { code: "UNAUTHORIZED", rowNumber: 29 },
      { code: "DOCUMENT_ROW_INVALID", rowNumber: "29" },
      { code: "DOCUMENT_ROW_INVALID", rowNumber: 1 },
    ]) {
      expect(safeAmazonRowDiagnostic(value)).toBeNull();
    }
    expect(
      safeAmazonRowDiagnostic({
        code: "DOCUMENT_TIMESTAMP_INVALID",
        rowNumber: 30,
        field: "purchase-date",
        expectedColumns: NaN,
      })
    ).toEqual({
      code: "DOCUMENT_TIMESTAMP_INVALID",
      rowNumber: 30,
      field: "purchase-date",
    });
  });
});
