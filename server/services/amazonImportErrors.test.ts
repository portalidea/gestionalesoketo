import { describe, expect, it } from "vitest";
import {
  AMAZON_IMPORT_ERRORS,
  AmazonImportError,
  amazonImportError,
  safeAmazonDetails,
} from "./amazonImportErrors";

describe("Amazon diagnostic closed catalog", () => {
  it("rebuilds typed error messages from the catalog even if message/cause were mutated", () => {
    const error = new AmazonImportError("REPORT_ID_MISMATCH");
    error.message =
      "secret-token buyer@example.test https://signed.invalid/?token=secret";
    (error as Error & { cause: unknown }).cause = { token: "secret" };
    const safe = amazonImportError(error);
    expect(safe).not.toBe(error);
    expect(safe.message).toBe(AMAZON_IMPORT_ERRORS.REPORT_ID_MISMATCH);
    expect(safe).not.toHaveProperty("cause");
    expect(JSON.stringify(safe)).not.toContain("secret");
  });
  it("unknown text and nested PostgreSQL details cannot leave the normalizer", () => {
    const error = {
      message: "secret",
      query: "SQL secret",
      cause: {
        code: "23505",
        detail: "customer@example.test",
        message: "secret",
      },
    };
    expect(amazonImportError(error)).toMatchObject({
      code: "DATABASE_CONSTRAINT",
      details: { sqlState: "23505" },
    });
    expect(amazonImportError(new Error("secret"))).toMatchObject({
      code: "INTERNAL_ERROR",
      message: AMAZON_IMPORT_ERRORS.INTERNAL_ERROR,
    });
  });
  it("only allowlisted numeric fields, compression labels and schema header names are retained", () => {
    expect(
      safeAmazonDetails({
        missingHeader: "secret",
        rowNumber: -1,
        bytes: NaN,
        sqlState: "customer@example.test",
        wireFormat: "gzip",
        compression: "GZIP",
      })
    ).toEqual({ wireFormat: "gzip", compression: "GZIP" });
    expect(
      safeAmazonDetails({ missingHeader: "sku", bytes: 17, rowNumber: 3 })
    ).toEqual({ missingHeader: "sku", bytes: 17, rowNumber: 3 });
  });
  it("body-parser JSON syntax errors use a safe explicit input error", () => {
    expect(
      amazonImportError({
        type: "entity.parse.failed",
        body: "secret",
        message: "secret",
      })
    ).toMatchObject({ code: "INVALID_INPUT" });
  });
});
