import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./db", () => ({ getDb: async () => ({ execute: mocks.execute }) }));
// Exercise real report procedures without authentication/company DB lookups.
vi.mock("./_core/trpc", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ activeCompanyId: string }>().create();
  return { router: t.router, staffProcedure: t.procedure, adminProcedure: t.procedure };
});
import { reportsRouter, summarizeMarketplaceCurrencies } from "./reports-router";

const companyId = "11111111-1111-4111-8111-111111111111";
const input = { dateFrom: "2026-11-01", dateTo: "2026-11-05", channel: "amazon" as const };
const dialect = new PgDialect();
const queryText = (index: number) => dialect.sqlToQuery(mocks.execute.mock.calls[index][0]).sql;
const caller = () => reportsRouter.createCaller({ activeCompanyId: companyId } as any);
const currencies = [
  { currency: "EUR", ordersCount: 2, totalGross: 100, avgOrderValue: 50, unitsSold: 6 },
  { currency: "GBP", ordersCount: 1, totalGross: 30, avgOrderValue: 30, unitsSold: 4 },
];

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue([]);
});

describe("Amazon marketplace native-currency reporting", () => {
  it("preserves EUR financial fields without summing GBP, but counts all orders and pieces", () => {
    expect(summarizeMarketplaceCurrencies(currencies)).toEqual({
      currency: "EUR", ordersCount: 3, unitsSold: 10, totalGross: 100, avgOrderValue: 50,
      totalsByCurrency: [
        { currency: "EUR", gross: 100, ordersCount: 2, avgOrderValue: 50 },
        { currency: "GBP", gross: 30, ordersCount: 1, avgOrderValue: 30 },
      ],
    });
    expect(summarizeMarketplaceCurrencies([currencies[1]])).toMatchObject({
      ordersCount: 1, unitsSold: 4, totalGross: 0, avgOrderValue: 0,
      totalsByCurrency: [{ currency: "GBP", gross: 30 }],
    });
    expect(summarizeMarketplaceCurrencies([])).toMatchObject({ totalGross: 0, ordersCount: 0, totalsByCurrency: [] });
  });

  it("groups gross once per order by source currency, retaining company/channel scope and previous-period shape", async () => {
    mocks.execute.mockResolvedValueOnce(currencies).mockResolvedValueOnce(currencies);
    const result = await caller().marketplace.getOverview(input);
    expect(result.summary).toMatchObject({ totalGross: 100, avgOrderValue: 50, ordersCount: 3, unitsSold: 10 });
    expect(result.totalsByCurrency).toEqual(result.summary.totalsByCurrency);
    expect(result.summary.previousPeriod.totalsByCurrency).toEqual(result.totalsByCurrency);
    for (const index of [0, 1]) {
      const query = queryText(index);
      expect(query).toContain(`GROUP BY COALESCE(NULLIF(UPPER(TRIM(mo."currency")), ''), 'EUR')`);
      expect(query).toContain(`ss."companyId" = '${companyId}'::uuid`);
      expect(query).toContain(`ss."channel" = 'amazon'`);
      expect(query).toContain('LEFT JOIN LATERAL');
      expect(query).toContain('SUM(gross_item."lineTotal"::float)');
      expect(query).not.toContain('SUM(DISTINCT');
      expect(query).not.toMatch(/exchange|fx_rate|conversion/i);
      expect(query).not.toContain('LIMIT 1');
      expect(query).not.toMatch(/WHERE[^]*mo\."currency"\s*=\s*'EUR'/);
    }
  });

  it("keeps all-currency quantitative scope while secondary finance and comparison use EUR only", async () => {
    await caller().marketplace.getOverview(input);
    for (const index of [2, 3, 4, 5, 6]) {
      const query = queryText(index);
      expect(query).toContain(`CASE WHEN COALESCE(NULLIF(UPPER(TRIM(mo."currency")), ''), 'EUR') = 'EUR' THEN`);
      expect(query).toContain(`ss."companyId" = '${companyId}'::uuid`);
      expect(query).toContain(`ss."channel" = 'amazon'`);
      expect(query).not.toMatch(/AND\s+(?:mo\."currency"|COALESCE\(NULLIF\(UPPER\(TRIM\(mo\."currency")/);
    }
    expect(queryText(2)).toContain('COUNT(DISTINCT mo."id")::int AS "orders"');
    expect(queryText(4)).toContain('SUM(moi."piecesQuantity")::int AS "units"');
  });

  it("returns and exports GBP order totals with actual currency, without conversion", async () => {
    mocks.execute.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([{ id: "uk-order", totalGross: 30, currency: "GBP" }]);
    const table = await caller().marketplace.getOrdersTable(input);
    expect(table.items[0]).toMatchObject({ totalGross: 30, currency: "GBP" });
    expect(queryText(1)).toContain(`COALESCE(NULLIF(UPPER(TRIM(mo."currency")), ''), 'EUR') AS "currency"`);
    mocks.execute.mockResolvedValueOnce([{ numero: "UK-1", data: "2026-11-02", cliente: "Test", totale: 30, valuta: "GBP", canale: "amazon", paese: "GB" }]);
    const csv = await caller().export.toCsv({ ...input, reportType: "marketplace", dataset: "orders" });
    expect(csv.csvContent).toContain("Totale;Valuta;Canale");
    expect(csv.csvContent).toContain(";30,00;GBP;amazon;GB");
    expect(queryText(2)).toContain(`COALESCE(NULLIF(UPPER(TRIM(mo."currency")), ''), 'EUR') AS "valuta"`);
  });

  it("UI separates currency lines, formats each order in its currency and discloses EUR-only comparison", () => {
    const page = readFileSync(resolve(process.cwd(), "client/src/pages/reports/MarketplaceReport.tsx"), "utf8");
    expect(page).toContain("Vendite per valuta");
    expect(page).toContain("data.totalsByCurrency");
    expect(page).toContain("formatCurrency(total.gross, total.currency)");
    expect(page).toContain("senza conversione valutaria");
    expect(page).toContain("UK in GBP sono esclusi dal confronto");
    expect(page).toContain("Ordini e pezzi includono tutti i marketplace e tutte le valute");
    expect(page).toContain("Vendite totali EUR");
    expect(page).toContain("AOV EUR");
    expect(page).toContain("formatCurrency(o.totalGross, o.currency)");
    expect(page).not.toContain("formatEur(o.totalGross)");
  });
});
