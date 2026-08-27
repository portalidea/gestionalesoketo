import { describe, expect, it } from "vitest";
import {
  deduplicateShopifyVariantRows,
  getVariantSyncErrorDetail,
  upsertVariantChunkWithFallback,
  type ShopifyVariantUpsertRow,
} from "./channelVariantService";

const baseRow: ShopifyVariantUpsertRow = {
  storeId: "store-1",
  channelSku: "10254",
  channelProductId: "product-old",
  channelVariantId: "variant-old",
  displayName: "Brioche precedente",
  multiplier: 1,
  isActive: true,
};

describe("channelVariantService bulk upsert guards", () => {
  it("deduplica una SKU nel chunk, conserva l’ultima occorrenza e mantiene le altre varianti", () => {
    const result = deduplicateShopifyVariantRows([
      baseRow,
      {
        ...baseRow,
        channelSku: "10255",
        channelProductId: "product-other",
        channelVariantId: "variant-other",
      },
      {
        ...baseRow,
        channelProductId: "product-new",
        channelVariantId: "variant-new",
        displayName: "Brioche aggiornata",
      },
    ]);

    expect(result.rows).toHaveLength(2);
    expect(result.duplicateSkus).toEqual(["10254"]);
    expect(result.rows.find((row) => row.channelSku === "10254")).toMatchObject({
      channelProductId: "product-new",
      channelVariantId: "variant-new",
      displayName: "Brioche aggiornata",
    });
    expect(result.rows.find((row) => row.channelSku === "10255")).toBeDefined();
  });

  it("conserva message, code, detail e constraint dall’errore PostgreSQL causale", () => {
    const error = Object.assign(new Error("Failed query"), {
      cause: {
        message: "ON CONFLICT DO UPDATE command cannot affect row a second time",
        code: "21000",
        detail: "Ensure that no rows proposed for insertion within the same command have duplicate constrained values.",
        constraint: "channel_variants_store_sku_unique",
      },
    });

    expect(
      getVariantSyncErrorDetail(error, {
        scope: "chunk",
        chunk: 1,
        recoveredByRowRetry: true,
      }),
    ).toMatchObject({
      scope: "chunk",
      chunk: 1,
      recoveredByRowRetry: true,
      message: "ON CONFLICT DO UPDATE command cannot affect row a second time",
      code: "21000",
      constraint: "channel_variants_store_sku_unique",
    });
  });

  it("ritenta per-riga un chunk bulk fallito e non perde le varianti sane", async () => {
    const healthyRow = { ...baseRow, channelSku: "BRIOCHE10X50" };
    const failingRow = { ...baseRow, channelSku: "BROKEN-SKU" };
    const attemptedRows: string[][] = [];

    const result = await upsertVariantChunkWithFallback(
      [healthyRow, failingRow],
      1,
      1,
      async (rows) => {
        attemptedRows.push(rows.map((row) => row.channelSku));
        if (rows.length > 1) {
          throw Object.assign(new Error("Failed query"), {
            cause: { message: "bulk constraint failure", code: "21000" },
          });
        }
        if (rows[0].channelSku === "BROKEN-SKU") {
          throw Object.assign(new Error("invalid SKU"), {
            cause: { message: "invalid SKU", code: "23514", constraint: "channel_sku_check" },
          });
        }
      },
    );

    expect(attemptedRows).toEqual([
      ["BRIOCHE10X50", "BROKEN-SKU"],
      ["BRIOCHE10X50"],
      ["BROKEN-SKU"],
    ]);
    expect(result.upsertedCount).toBe(1);
    expect(result.recoveredByRowRetry).toBe(true);
    expect(result.failedSkus).toEqual(["BROKEN-SKU"]);
    expect(result.errorDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "chunk", code: "21000" }),
      expect.objectContaining({ scope: "row", sku: "BROKEN-SKU", code: "23514", constraint: "channel_sku_check" }),
    ]));
  });
});
