import { describe, expect, it, vi } from "vitest";

const { calculateOrderPricingMock } = vi.hoisted(() => ({
  calculateOrderPricingMock: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pricing")>();
  return { ...actual, calculateOrderPricing: calculateOrderPricingMock };
});

import {
  calculateOrderPricingWithAllowance,
  getRetailerAllowanceSummary,
  persistAllowanceConsumptions,
  type AllowancePricingResult,
} from "./retailerAllowanceService";

const product = {
  productId: "product-1",
  productSku: "SKU-1",
  productName: "Prodotto test",
  piecesPerUnit: 1,
  quantity: 4,
  unitPriceBase: "10.00",
  discountPercent: "20.00",
  unitPriceFinal: "8.00",
  vatRate: "22.00",
  lineTotalNet: "32.00",
  lineTotalGross: "39.04",
  stockAvailableConfezioni: 100,
  stockWarning: false,
  pricingModel: "tier_discount" as const,
};

function pricingFor(packageId: string) {
  return {
    discountPercent: packageId === "base-package" ? "20.00" : "10.00",
    packageName: packageId,
    items: [{
      ...product,
      unitPriceFinal: packageId === "base-package" ? "8.00" : "9.00",
      discountPercent: packageId === "base-package" ? "20.00" : "10.00",
      lineTotalNet: packageId === "base-package" ? "32.00" : "36.00",
      lineTotalGross: packageId === "base-package" ? "39.04" : "43.92",
    }],
    subtotalNet: packageId === "base-package" ? "32.00" : "36.00",
    vatAmount: packageId === "base-package" ? "7.04" : "7.92",
    totalGross: packageId === "base-package" ? "39.04" : "43.92",
    warnings: [],
    pricingModel: "tier_discount" as const,
  };
}

const activeAllowances = [
  {
    id: "promo-first",
    initialAmount: "10.00",
    valuationDiscountPercent: "0.00",
    postExhaustionPricingPackageId: "promo-first-package",
    postExhaustionPackageName: "Promo First",
    allowanceType: "promo_bonus",
    sourceAmount: "10.00",
    sourceReference: "Bonus 1",
    sourceReceivedAt: new Date("2026-01-01T10:00:00.000Z"),
    activatedAt: new Date("2026-01-01T10:00:00.000Z"),
    status: "active",
  },
  {
    id: "promo-second",
    initialAmount: "10.00",
    valuationDiscountPercent: "0.00",
    postExhaustionPricingPackageId: "promo-second-package",
    postExhaustionPackageName: "Promo Second",
    allowanceType: "promo_bonus",
    sourceAmount: "10.00",
    sourceReference: "Bonus 2",
    sourceReceivedAt: new Date("2026-02-01T10:00:00.000Z"),
    activatedAt: new Date("2026-02-01T10:00:00.000Z"),
    status: "active",
  },
  {
    id: "base",
    initialAmount: "10.00",
    valuationDiscountPercent: "20.00",
    postExhaustionPricingPackageId: "base-package",
    postExhaustionPackageName: "Base",
    allowanceType: "restaurant_package",
    sourceAmount: "1000.00",
    sourceReference: "Pacchetto",
    sourceReceivedAt: new Date("2025-01-01T10:00:00.000Z"),
    activatedAt: new Date("2025-01-01T10:00:00.000Z"),
    status: "active",
  },
];

/** Builder thenable sufficiente ai read path Drizzle esercitati dal servizio. */
function queryResult<T>(result: T) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    leftJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    for: () => query,
    then: <TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(result).then(onfulfilled, onrejected),
  };
  return query;
}

function allowanceReadDatabase(allowances = activeAllowances) {
  const results = [allowances, ...allowances.map(() => [{ amount: "0" }])];
  return {
    select: vi.fn(() => queryResult(results.shift() ?? [])),
  };
}

describe("retailerAllowanceService — migration 0048", () => {
  it("consuma i promo_bonus attivi in activatedAt crescente, poi il plafond base, e paga con il package finale", async () => {
    const database = allowanceReadDatabase();
    calculateOrderPricingMock.mockImplementation(async (input: { pricingPackageIdOverride: string }) => (
      pricingFor(input.pricingPackageIdOverride)
    ));

    const result = await calculateOrderPricingWithAllowance({
      database: database as never,
      retailerId: "retailer-1",
      companyId: "company-1",
      items: [{ productId: product.productId, quantity: 4 }],
    });

    expect(calculateOrderPricingMock).toHaveBeenCalledWith(expect.objectContaining({
      pricingPackageIdOverride: "base-package",
    }));
    expect(result.items.filter((item) => item.allowanceCovered).map((item) => item.allowanceId))
      .toEqual(["promo-first", "promo-second", "base"]);
    expect(result.items.find((item) => !item.allowanceCovered)).toMatchObject({
      quantity: 1,
      unitPriceFinal: "8.00",
      lineTotalNet: "8.00",
    });
    expect(result.allowanceConsumptionPlan).toEqual([
      expect.objectContaining({ allowanceId: "promo-first", quantity: 1, consumptionAmount: "10.00" }),
      expect.objectContaining({ allowanceId: "promo-second", quantity: 1, consumptionAmount: "10.00" }),
      expect.objectContaining({ allowanceId: "base", quantity: 1, consumptionAmount: "8.00" }),
    ]);
    expect(result.allowances.map((allowance) => allowance.id)).toEqual(["promo-first", "promo-second", "base"]);
    expect(result.allowance?.remainingBefore).toBe("10.00");
    expect(result.allowance?.remainingAfter).toBe("0.00");
  });

  it("espone tutti i plafond nei summaries e conserva i totali aggregati", async () => {
    const database = allowanceReadDatabase();

    const summary = await getRetailerAllowanceSummary(
      database as never,
      "retailer-1",
      "company-1",
    );

    expect(summary?.primaryAllowanceId).toBe("promo-first");
    expect(summary?.allowances.map((allowance) => allowance.id))
      .toEqual(["promo-first", "promo-second", "base"]);
    expect(summary).toMatchObject({
      totalInitialAmount: "30.00",
      totalConsumedAmount: "0.00",
      totalRemainingAmount: "30.00",
    });
  });

  it("scrive allowanceId dal piano deterministico senza cercare righe per prodotto o quantità", async () => {
    const inserted: unknown[][] = [];
    const database = {
      select: vi.fn(() => {
        throw new Error("Il ledger non deve rileggere orderItems per un matching fragile.");
      }),
      insert: vi.fn(() => ({
        values: vi.fn((rows: unknown[]) => {
          inserted.push(rows);
          return Promise.resolve();
        }),
      })),
    };
    const pricing = {
      allowanceConsumptionPlan: [
        {
          allowanceId: "promo-first",
          pricingLineIndex: 0,
          productId: product.productId,
          quantity: 1,
          listUnitPrice: "10.00",
          valuationDiscountPercent: "0.00",
          consumptionAmount: "10.00",
        },
        {
          allowanceId: "promo-second",
          pricingLineIndex: 1,
          productId: product.productId,
          quantity: 1,
          listUnitPrice: "10.00",
          valuationDiscountPercent: "0.00",
          consumptionAmount: "10.00",
        },
      ],
    } as AllowancePricingResult;

    await persistAllowanceConsumptions(database as never, {
      orderId: "order-1",
      createdBy: "user-1",
      pricing,
      orderItemIdsByPricingLine: ["order-item-1", "order-item-2"],
    });

    expect(database.select).not.toHaveBeenCalled();
    expect(inserted).toEqual([[
      expect.objectContaining({ allowanceId: "promo-first", orderItemId: "order-item-1", consumptionAmount: "10.00" }),
      expect.objectContaining({ allowanceId: "promo-second", orderItemId: "order-item-2", consumptionAmount: "10.00" }),
    ]]);
  });
});
