import { describe, expect, it } from "vitest";
import {
  aggregateOrderBatchPieces,
  calculatePartialReversal,
  shouldReverseTransferredOrder,
} from "./orderTransferReversal";

describe("orderTransferReversal", () => {
  it("aggregates multiple order rows belonging to the same batch into one reverse movement", () => {
    const allocations = aggregateOrderBatchPieces([
      { batchId: "batch-a", productId: "product-a", quantity: 2, piecesPerUnit: 6 },
      { batchId: "batch-a", productId: "product-a", quantity: 1, piecesPerUnit: 6 },
      { batchId: "batch-b", productId: "product-b", quantity: 3, piecesPerUnit: 1 },
    ]);

    expect(allocations).toEqual([
      ["batch-a", { productId: "product-a", requestedPieces: 18 }],
      ["batch-b", { productId: "product-b", requestedPieces: 3 }],
    ]);
  });

  it("reverses the full quantity when retailer stock is intact", () => {
    expect(calculatePartialReversal(30, 30)).toEqual({ reversedPieces: 30, missingPieces: 0 });
  });

  it("reverses only available retailer stock and reports the discrepancy", () => {
    expect(calculatePartialReversal(30, 11)).toEqual({ reversedPieces: 11, missingPieces: 19 });
    expect(calculatePartialReversal(30, 0)).toEqual({ reversedPieces: 0, missingPieces: 30 });
  });

  it("does not reverse a second time after a recorded reversal", () => {
    expect(shouldReverseTransferredOrder("transferring", true)).toBe(false);
    expect(shouldReverseTransferredOrder("cancelled", true)).toBe(false);
  });

  it("allows exactly one reversal for a transferring order before a reversal is recorded", () => {
    expect(shouldReverseTransferredOrder("transferring", false)).toBe(true);
    expect(shouldReverseTransferredOrder("pending", false)).toBe(false);
  });
});
