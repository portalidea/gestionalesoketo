import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { amazonRouter } from "./amazon-router";
import type { TrpcContext } from "./_core/context";

const STORE = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const ITEM = "33333333-3333-3333-3333-333333333333";
const scope = { storeId: STORE, dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const page = readFileSync(
  resolve(process.cwd(), "client/src/pages/MarketplaceAmazon.tsx"),
  "utf8"
);
const router = readFileSync(
  resolve(process.cwd(), "server/amazon-router.ts"),
  "utf8"
);
const shopify = readFileSync(
  resolve(process.cwd(), "server/shopify-router.ts"),
  "utf8"
);
const reports = readFileSync(
  resolve(process.cwd(), "server/reports-router.ts"),
  "utf8"
);

const compactPage = page.replace(/\s+/g, " ");
const compactRouter = router.replace(/\s+/g, " ");

function context(role: string | null): TrpcContext {
  return {
    req: { headers: { "x-active-company-id": STORE } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: role ? ({ id: ITEM, role } as TrpcContext["user"]) : null,
  };
}
describe("Amazon admin RBAC before any company/database lookup", () => {
  it.each([
    null,
    "operator",
    "viewer",
    "retailer_admin",
    "retailer_user",
    "affiliate_admin",
  ])("rejects %s on every procedure", async role => {
    const caller = amazonRouter.createCaller(context(role));
    const denied = { code: role ? "FORBIDDEN" : "UNAUTHORIZED" };
    await expect(caller.store.get()).rejects.toMatchObject(denied);
    await expect(
      caller.store.configure({
        name: "SoKeto Amazon",
        sellerAccountId: "SELLER",
      })
    ).rejects.toMatchObject(denied);
    await expect(caller.summary(scope)).rejects.toMatchObject(denied);
    await expect(caller.runs.list(scope)).rejects.toMatchObject(denied);
    await expect(
      caller.runs.observations({ storeId: STORE, runId: RUN })
    ).rejects.toMatchObject(denied);
    await expect(caller.orders.list(scope)).rejects.toMatchObject(denied);
    await expect(
      caller.orders.requeueReview({
        storeId: STORE,
        itemId: ITEM,
        confirm: true,
      })
    ).rejects.toMatchObject(denied);
    await expect(caller.processQueue({ storeId: STORE })).rejects.toMatchObject(
      denied
    );
  });
});
describe("Amazon configuration and bounded input contracts", () => {
  const config = amazonRouter.store.configure._def.inputs[0] as z.ZodType;
  const runs = amazonRouter.runs.list._def.inputs[0] as z.ZodType;
  const queue = amazonRouter.processQueue._def.inputs[0] as z.ZodType;
  it("defaults to September cutoff, disabled imports and indefinite dry-run", () => {
    expect(
      config.parse({ name: " SoKeto Amazon ", sellerAccountId: " SELLER " })
    ).toEqual({
      name: "SoKeto Amazon",
      sellerAccountId: "SELLER",
      purchaseCutoff: "2026-09-01",
      enabled: false,
      dryRun: true,
      confirmRealStock: false,
    });
  });
  it("rejects invalid dates and blank seller identifiers", () => {
    expect(
      config.safeParse({
        name: "SoKeto Amazon",
        sellerAccountId: " ",
        purchaseCutoff: "2026-09-01",
      }).success
    ).toBe(false);
    expect(
      config.safeParse({
        name: "SoKeto Amazon",
        sellerAccountId: "SELLER",
        purchaseCutoff: "2026-02-30",
      }).success
    ).toBe(false);
  });
  it("bounds list windows/pages and manual queue size", () => {
    expect(runs.safeParse({ ...scope, limit: 101 }).success).toBe(false);
    expect(runs.safeParse({ ...scope, offset: -1 }).success).toBe(false);
    expect(runs.safeParse({ ...scope, dateTo: "2027-01-01" }).success).toBe(
      false
    );
    expect(runs.safeParse({ ...scope, dateTo: "2026-08-31" }).success).toBe(
      false
    );
    expect(queue.safeParse({ storeId: STORE, limit: 51 }).success).toBe(false);
  });
});
describe("Amazon admin presentation and query-source safeguards", () => {
  it("has an admin-only route and navigation without a secret input or credential response", () => {
    const app = readFileSync(
      resolve(process.cwd(), "client/src/App.tsx"),
      "utf8"
    );
    const layout = readFileSync(
      resolve(process.cwd(), "client/src/components/DashboardLayout.tsx"),
      "utf8"
    );
    expect(app).toContain(
      '<RequireRole allowedRoles={["admin"]}><MarketplaceAmazon /></RequireRole>'
    );
    expect(layout.slice(layout.indexOf("const adminMenuItems"))).toContain(
      'path: "/marketplace/amazon"'
    );
    expect(page).toContain("AMAZON_IMPORT_STORE_ID");
    expect(page).toContain("AMAZON_IMPORT_WEBHOOK_KEY");
    expect(page).not.toContain('type="password"');
    expect(router).not.toContain("process.env");
    expect(router).not.toContain("apiCredentials: salesStores.apiCredentials");
  });
  it("distinguishes real stock, planned stock, FEFO dates and post-stock alerts", () => {
    for (const text of [
      "Pezzi realmente scaricati",
      "Pezzi che sarebbero scaricati",
      "Produzione:",
      "Scadenza:",
      "SKU mancante",
      "FBA",
      "Canale ignoto",
      "prima del cutoff",
      "non stornati automaticamente",
      "dry-run storici idonei",
      "nessuna scadenza automatica",
    ])
      expect(compactPage.toLowerCase()).toContain(text.toLowerCase());
    expect(router).toContain("amazonStockAllocations.pieces");
    expect(compactRouter).toContain("plannedAllocations: previewAllocations");
  });
  it("deduplicates planned quantities across report overlaps and excludes already processed items", () => {
    expect(router).toContain("SELECT DISTINCT ON (ro.item_id)");
    expect(router).toContain(
      "ORDER BY ro.item_id, ro.created_at DESC, ro.id DESC"
    );
    expect(router).toContain("i.\"amazonStockStatus\" = 'dry_run'");
    expect(compactPage).toContain("Ultimo piano per articolo distinto");
    expect(compactPage).toContain("Esiti osservazioni raw (non ordini distinti)");
  });
  it("freezes cutoff after a durable receipt and displays original source dates first", () => {
    expect(router).toContain(
      "existing.purchaseCutoff !== input.purchaseCutoff"
    );
    expect(router).toContain("isNotNull(amazonImportRuns.documentSha256)");
    expect(router).toContain(
      "Cutoff non modificabile dopo il primo report ricevuto"
    );
    expect(compactRouter).toContain(
      'purchaseDate: sourceText(row.source, "purchase-date", "purchaseDate") ??'
    );
    expect(compactRouter).toContain(
      'updatedAt: sourceText(row.source, "last-updated-date", "updatedAt") ??'
    );
  });
  it("never trusts a client company and scopes every chosen store", () => {
    expect(router).toContain("companyId !== EKETO_COMPANY_ID");
    expect(router).toContain('eq(salesStores.channel, "amazon")');
    expect(router).toContain("eq(salesStores.companyId, companyId)");
    expect(router).toContain("updatedBy: operatorId");
    expect(router).toContain(
      "eq(marketplaceOrderItems.amazonPiecesProcessed, 0)"
    );
    expect(router).toContain(
      "NOT EXISTS (SELECT 1 FROM amazon_stock_allocations"
    );
  });
  it("Shopify list/detail/retries explicitly scope store channel and active company", () => {
    const orders = shopify.slice(shopify.indexOf("orders: router"));
    expect(
      orders.match(
        /ss.channel = 'shopify' AND ss\."companyId" = \$\{ctx\.activeCompanyId\}::uuid/g
      )?.length
    ).toBe(4);
    expect(orders).not.toContain("return await retryFailedOrders()");
  });
  it("aggregates item quantities before joining marketplace gross totals and scopes report/export stores", () => {
    const marketplace = reports.slice(
      reports.indexOf("const marketplaceRouter"),
      reports.indexOf("// ============= EXPORT")
    );
    expect(marketplace.match(/\) item_totals ON true/g)?.length).toBe(3);
    expect(marketplace).not.toContain(
      'LEFT JOIN "marketplace_order_items" moi ON moi."marketplaceOrderId" = mo."id"'
    );
    expect(marketplace).toContain('ss."companyId"');
    expect(marketplace).toContain("ss.\"channel\" IN ('shopify', 'amazon')");
    const exportSource = reports.slice(
      reports.indexOf('input.reportType === "marketplace"')
    );
    expect(exportSource).toContain('AND ss."companyId"');
    expect(reports).toContain(
      'SELECT SUM(gross_item."lineTotal"::float) FROM marketplace_order_items gross_item'
    );
    expect(marketplace).toContain("SUM(${marketplaceOrderGrossSql})");
  });
});
