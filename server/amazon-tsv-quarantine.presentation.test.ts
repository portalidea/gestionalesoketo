import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAmazonReport } from "./services/amazonOrderImportHelpers";

const ui = fs.readFileSync("client/src/pages/MarketplaceAmazon.tsx", "utf8");
const router = fs.readFileSync("server/amazon-router.ts", "utf8");
describe("Amazon TSV row review presentation", () => {
  it("shows physical row number, expected/found columns, safe field and no guessed identity", () => {
    expect(ui).toContain("Riga {entry.rowNumber} del file");
    expect(ui).toContain("Colonne attese:");
    expect(ui).toContain("trovate:");
    expect(ui).toContain("nessun ID o SKU viene dedotto");
    expect(router).toMatch(
      /safeAmazonRowDiagnostic\(\s*jsonObject\(row\.source\)\._diagnostic\s*,?\s*\)/
    );
    expect(router).toContain("ASC NULLS LAST");
  });
  it("an empty header name is a document error, unlike an invalid data line", () => {
    const columns = [
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
      "",
    ];
    expect(() =>
      parseAmazonReport(Buffer.from(columns.join("\t") + "\n"))
    ).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_HEADERS_INVALID" })
    );
  });
});
