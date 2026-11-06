import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EKETO_COMPANY_ID } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import type { ZodTypeAny } from "zod";

const fixture = vi.hoisted(() => ({
  getDb: vi.fn(),
  resolveCompany: vi.fn(),
  batch: vi.fn(),
  invalidate: vi.fn(),
  stateCalls: 0,
  storeId: "11111111-1111-1111-1111-111111111111",
  runs: [] as unknown[],
}));
vi.mock("./db", () => ({ getDb: fixture.getDb }));
vi.mock("./_core/companyContext", () => ({
  resolveActiveCompanyId: fixture.resolveCompany,
}));
vi.mock("./services/amazonReportDocumentService", () => ({
  processAmazonReportBatch: fixture.batch,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(fixture.stateCalls++ === 0 ? fixture.storeId : initial),
  };
});
vi.mock("@/components/DashboardLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/trpc", () => {
  const query = (data: unknown) => ({ data, error: null, isLoading: false });
  const mutation = () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  });
  return {
    trpc: {
      useUtils: () => ({ amazon: { invalidate: fixture.invalidate } }),
      amazon: {
        store: {
          get: {
            useQuery: () =>
              query({
                companyName: "E-Keto",
                stores: [
                  {
                    id: fixture.storeId,
                    name: "Amazon test",
                    sellerAccountId: "TEST",
                    purchaseCutoff: "2026-09-01",
                    dryRun: true,
                    enabled: true,
                  },
                ],
              }),
          },
          configure: { useMutation: mutation },
        },
        summary: {
          useQuery: () =>
            query({
              products: [],
              dailyOrders: [],
              daily: [],
              outcomes: [],
              importedOrders: 0,
              actualPieces: 0,
              plannedPieces: 0,
            }),
        },
        runs: {
          list: {
            useQuery: () =>
              query({ items: fixture.runs, total: fixture.runs.length }),
          },
          observations: { useQuery: () => query({ items: [], total: 0 }) },
        },
        orders: {
          list: { useQuery: () => query({ items: [], total: 0 }) },
          requeueReview: { useMutation: mutation },
        },
        processBatch: { useMutation: mutation },
      },
    },
  };
});
import MarketplaceAmazon, {
  amazonDocumentStage,
  amazonProcessingDuration,
  isAmazonRunActive,
} from "../client/src/pages/MarketplaceAmazon";
import {
  amazonRouter,
  safeAmazonRunError,
  safeAmazonRunSummary,
} from "./amazon-router";

const STORE = fixture.storeId;
const RUN = "22222222-2222-2222-2222-222222222222";
const AT = new Date("2026-11-06T14:00:00.000Z");
const document = {
  totalRows: 12,
  ingestedRows: 0,
  acquiredAt: AT,
  ingestStartedAt: null as Date | null,
  ingestCompletedAt: null as Date | null,
  processingCompletedAt: null as Date | null,
  processingMs: 0,
  lastError: null as string | null,
};
const run = {
  id: RUN,
  createdAt: AT,
  windowStart: AT,
  windowEnd: AT,
  status: "processing",
  dryRun: true,
  summary: {},
  error: null,
  document,
};
const source = readFileSync("client/src/pages/MarketplaceAmazon.tsx", "utf8");
const routerSource = readFileSync("server/amazon-router.ts", "utf8");

function context(role: string | null): TrpcContext {
  return {
    req: {
      headers: { "x-active-company-id": EKETO_COMPANY_ID },
    } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: role ? ({ id: RUN, role } as TrpcContext["user"]) : null,
  };
}
function mockDb(results: unknown[][]) {
  const selections: unknown[] = [];
  const select = vi.fn((fields: unknown) => {
    selections.push(fields);
    const result = results.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of [
      "from",
      "innerJoin",
      "leftJoin",
      "where",
      "orderBy",
      "limit",
      "offset",
    ])
      chain[method] = vi.fn(() => chain);
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(result).then(resolve);
    return chain;
  });
  fixture.getDb.mockResolvedValue({ select });
  return { select, selections };
}
function batchResult(overrides = {}) {
  return {
    runId: RUN,
    totalRows: 12,
    ingestedRows: 5,
    ingestedThisBatch: 5,
    completed: false,
    hasMore: true,
    disabled: false,
    acquiredAt: AT,
    ingestStartedAt: AT,
    ingestCompletedAt: null,
    processingCompletedAt: null,
    processingMs: 1234,
    lastError: null,
    worker: {
      attempted: 0,
      processed: 0,
      dryRun: 0,
      reviewRequired: 0,
      skipped: 0,
      errors: [],
    },
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.resolveCompany.mockResolvedValue(EKETO_COMPANY_ID);
  fixture.stateCalls = 0;
  fixture.runs = [];
  // Vitest's TSX transform may use the classic runtime for this existing project.
  vi.stubGlobal("React", React);
});

describe("durable Amazon report progress presentation", () => {
  it("distinguishes queued202 receipt from completed ingestion and stock processing", () => {
    expect(amazonDocumentStage(run)).toBe("Documento ricevuto / in coda");
    expect(
      amazonDocumentStage({
        ...run,
        document: { ...document, ingestStartedAt: AT, ingestedRows: 5 },
      })
    ).toBe("Ingestione 5/12");
    expect(
      amazonDocumentStage({
        ...run,
        document: { ...document, ingestedRows: 12, ingestCompletedAt: AT },
      })
    ).toContain("dry-run");
    expect(
      amazonDocumentStage({
        ...run,
        dryRun: false,
        document: { ...document, ingestCompletedAt: AT },
      })
    ).toBe("Elaborazione stock reale");
    expect(
      amazonDocumentStage({
        ...run,
        status: "completed",
        document: { ...document, processingCompletedAt: AT },
      })
    ).toBe("Elaborazione completata");
  });
  it("distinguishes an empty durable report, no document yet and a legacy run", () => {
    expect(
      amazonDocumentStage({ ...run, document: null, status: "pending" })
    ).toContain("In attesa");
    expect(amazonDocumentStage({ ...run, document: null })).toContain("legacy");
    expect(
      amazonDocumentStage({
        ...run,
        status: "completed",
        document: { ...document, totalRows: 0, processingCompletedAt: AT },
      })
    ).toContain("documento senza righe");
    expect(
      amazonDocumentStage({
        ...run,
        document: { ...document, lastError: "Errore sicuro" },
      })
    ).toContain("interrotta");
  });
  it("formats accumulated committed worker time, including zero and missing legacy duration", () => {
    expect(amazonProcessingDuration(1234)).toBe("1,23 s");
    expect(amazonProcessingDuration(0)).toBe("0 s");
    expect(amazonProcessingDuration(null)).toBe("—");
    expect(amazonProcessingDuration(Number.NaN)).toBe("—");
  });
  it("renders the real page with cursor, completed duration, explicit starter and pause explanation", () => {
    fixture.runs = [
      {
        ...run,
        document: { ...document, ingestedRows: 5, ingestStartedAt: AT },
      },
      {
        ...run,
        id: STORE,
        status: "completed",
        document: {
          ...document,
          ingestedRows: 12,
          ingestCompletedAt: AT,
          processingCompletedAt: AT,
          processingMs: 1234,
        },
      },
    ];
    const html = renderToStaticMarkup(React.createElement(MarketplaceAmazon));
    for (const text of [
      "Ingestione 5/12",
      "Elaborazione completata",
      "1,23 s",
      "Elabora prossimo lotto",
      "Avvia elaborazione a lotti",
      "Upload HTTP 202",
      "non import completato",
      "Pausa o cambio store",
    ])
      expect(html).toContain(text);
    expect(fixture.batch).not.toHaveBeenCalled();
  });
  it("polls only read queries; explicit confirmation is the only worker entry and cancellation blocks later lots", () => {
    expect(isAmazonRunActive({ status: "processing" })).toBe(true);
    expect(isAmazonRunActive({ status: "completed" })).toBe(false);
    expect(source.match(/refetchInterval: query/g)).toHaveLength(2);
    expect(source).toContain("5_000 : false");
    expect(source).toContain(
      'confirmation === "processLoop") startBatch(true)'
    );
    expect(source).toContain('confirmation === "process") startBatch(false)');
    expect(source).toContain("generation !== batchGeneration.current");
    expect(source).toContain("batchInFlight.current");
    expect(source).toContain("return cancelScheduledBatch");
    expect(source).toContain("onClick={pauseBatchLoop}");
    expect(source).not.toContain("processQueue");
    expect(source).not.toContain("bodyBase64");
    expect(source).not.toContain("sourceRow");
    expect(source).not.toContain("window.setInterval");
    expect(source).toContain("data.result.worker.errors.length");
  });
});

describe("durable Amazon batch API scope, bounds and secret safety", () => {
  it.each([
    null,
    "viewer",
    "retailer_admin",
    "retailer_user",
    "affiliate_admin",
  ])(
    "rejects non-writer role %s without dispatching the worker",
    async role => {
      await expect(
        amazonRouter
          .createCaller(context(role))
          .processBatch({ storeId: STORE, confirmRealStock: true })
      ).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
      expect(fixture.batch).not.toHaveBeenCalled();
      expect(fixture.getDb).not.toHaveBeenCalled();
    }
  );
  it.each(["admin", "operator"])(
    "dispatches %s requests with fixed 5-row/12-second limits and unchanged dry-run config",
    async role => {
      const db = mockDb([
        [{ id: EKETO_COMPANY_ID, name: "E-Keto" }],
        [{ id: STORE, enabled: true, dryRun: true }],
      ]);
      fixture.batch.mockResolvedValue(batchResult());
      const result = await amazonRouter
        .createCaller(context(role))
        .processBatch({ storeId: STORE, confirmRealStock: true });
      expect(fixture.batch).toHaveBeenCalledTimes(1);
      expect(fixture.batch).toHaveBeenCalledWith(STORE, {
        rowLimit: 5,
        timeBudgetMs: 12000,
      });
      expect(result.result).toMatchObject({
        hasMore: true,
        completed: false,
        ingestedRows: 5,
      });
      expect(db.select).toHaveBeenCalledTimes(2);
    }
  );
  it("rejects unknown client company/limit/mode inputs, disabled stores and absent stock consent", async () => {
    const schema = amazonRouter.processBatch._def.inputs[0] as ZodTypeAny;
    expect(schema.parse({ storeId: STORE })).toEqual({
      storeId: STORE,
      confirmRealStock: false,
    });
    for (const key of ["companyId", "rowLimit", "timeBudgetMs", "dryRun"])
      expect(schema.safeParse({ storeId: STORE, [key]: 5 }).success).toBe(
        false
      );
    mockDb([[{ id: EKETO_COMPANY_ID }], [{ id: STORE, enabled: false }]]);
    await expect(
      amazonRouter
        .createCaller(context("admin"))
        .processBatch({ storeId: STORE, confirmRealStock: true })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    mockDb([[{ id: EKETO_COMPANY_ID }], [{ id: STORE, enabled: true }]]);
    await expect(
      amazonRouter
        .createCaller(context("admin"))
        .processBatch({ storeId: STORE })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.batch).not.toHaveBeenCalled();
  });
  it("rejects foreign stores and foreign active companies before invoking the core", async () => {
    mockDb([[{ id: EKETO_COMPANY_ID }], []]);
    await expect(
      amazonRouter
        .createCaller(context("admin"))
        .processBatch({ storeId: STORE, confirmRealStock: true })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.resolveCompany.mockResolvedValue(STORE);
    await expect(
      amazonRouter
        .createCaller(context("admin"))
        .processBatch({ storeId: STORE, confirmRealStock: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.batch).not.toHaveBeenCalled();
  });
  it("selects only durable document metadata and sanitizes historical summary/error fields", async () => {
    const secret = "https://signed.invalid/?token=secret buyer@example.test";
    const db = mockDb([
      [{ id: EKETO_COMPANY_ID }],
      [{ id: STORE, enabled: true }],
      [{ total: 1 }],
      [
        {
          ...run,
          document: undefined,
          documentRunId: RUN,
          ...document,
          summary: {
            rows: 12,
            source: secret,
            lastDiagnostic: {
              code: "INVALID_INPUT",
              details: { missingHeader: secret },
              requestId: secret,
            },
          },
          error: secret,
          lastError: secret,
        },
      ],
    ]);
    const response = await amazonRouter
      .createCaller(context("admin"))
      .runs.list({
        storeId: STORE,
        dateFrom: "2026-11-01",
        dateTo: "2026-11-30",
      });
    const fields = db.selections[3] as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining([
        "documentRunId",
        "totalRows",
        "ingestedRows",
        "processingMs",
        "processingCompletedAt",
      ])
    );
    expect(fields).not.toHaveProperty("bodyBase64");
    expect(routerSource).not.toContain("amazonImportDocuments.bodyBase64");
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(JSON.stringify(response)).not.toContain("buyer@");
    expect(response.items[0].document).toMatchObject({
      totalRows: 12,
      processingMs: 0,
    });
  });
  it("does not forward unknown exceptions or worker provider text to the frontend", async () => {
    mockDb([[{ id: EKETO_COMPANY_ID }], [{ id: STORE, enabled: true }]]);
    fixture.batch.mockRejectedValue(new Error("secret buyer@example.test"));
    await expect(
      amazonRouter
        .createCaller(context("admin"))
        .processBatch({ storeId: STORE, confirmRealStock: true })
    ).rejects.toThrow("INTERNAL_ERROR");
    mockDb([[{ id: EKETO_COMPANY_ID }], [{ id: STORE, enabled: true }]]);
    fixture.batch.mockResolvedValue(
      batchResult({
        bodyBase64: "secret",
        lastError: "secret",
        worker: {
          attempted: 1,
          processed: 0,
          dryRun: 0,
          reviewRequired: 0,
          skipped: 0,
          errors: [{ itemId: RUN, message: "secret buyer@example.test" }],
        },
      })
    );
    const result = await amazonRouter
      .createCaller(context("admin"))
      .processBatch({ storeId: STORE, confirmRealStock: true });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.result.worker.errors).toHaveLength(1);
    expect(
      safeAmazonRunSummary({
        bodyBase64: "secret",
        outcomes: { secret: 12, pending: 2 },
        rows: 3,
      })
    ).toEqual({ rows: 3, outcomes: { pending: 2 } });
    expect(safeAmazonRunError("secret")).not.toContain("secret");
  });
});
