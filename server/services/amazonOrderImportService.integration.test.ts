import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import { EKETO_COMPANY_ID, SOKETO_COMPANY_ID } from "../../shared/const";
import {
  amazonImportConfigs,
  amazonImportRuns,
  amazonImportRowObservations,
  amazonStockAllocations,
  channelVariantComponents,
  channelVariants,
  companies,
  inventoryByBatch,
  locations,
  marketplaceOrderItems,
  marketplaceOrders,
  productBatches,
  products,
  salesStores,
  stockMovements,
} from "../../drizzle/schema";
import {
  ingestAmazonReport,
  processPendingAmazonItems,
} from "./amazonOrderImportService";
import { getAmazonImportProductSummary } from "./amazonImportSummaryService";
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
vi.mock("../db", () => ({ getDb: async () => db }));
const enabled =
  process.env.INTEGRATION === "1" ||
  process.env.LOCAL_TEST === "1" ||
  Boolean(process.env.LOCAL_TEST_DATABASE_URL);
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
type Row = Partial<Record<(typeof headers)[number], string>>;
const report = (rows: Row[]) =>
  Buffer.from(
    `${headers.join("\t")}\n${rows.map((r, i) => headers.map(h => ({ "amazon-order-id": "order", "order-item-id": `item-${i}`, "purchase-date": "2026-09-01T10:00:00+02:00", "last-updated-date": "2026-09-02T10:00:00+02:00", "order-status": "PartiallyShipped", "item-status": "Shipped", "fulfillment-channel": "Merchant", sku: "PACK", quantity: "2", currency: "EUR", "item-price": "12.00", ...r })[h]).join("\t")).join("\n")}\n`
  );
interface Fixture {
  storeId: string;
  productId: string;
  variantId: string;
  warehouseId: string;
  sellerId: string;
  batchIds: string[];
}
async function fixture(
  dryRun = false,
  stocks = [3, 20],
  multiplier = 3
): Promise<Fixture> {
  const storeId = randomUUID(),
    productId = randomUUID(),
    variantId = randomUUID();
  const sellerId = `seller-${storeId}`;
  const [warehouse] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.companyId, EKETO_COMPANY_ID),
        eq(locations.type, "central_warehouse")
      )
    )
    .limit(1);
  await db.insert(salesStores).values({
    id: storeId,
    channel: "amazon",
    name: "Amazon integration",
    storeIdentifier: storeId,
    companyId: EKETO_COMPANY_ID,
  });
  await db
    .insert(amazonImportConfigs)
    .values({ storeId, sellerAccountId: sellerId, enabled: true, dryRun });
  await db.insert(products).values({
    id: productId,
    sku: `TEST-${productId}`,
    name: "Test product",
    unitPrice: "1.00",
    piecesPerUnit: 99,
  });
  await db.insert(channelVariants).values({
    id: variantId,
    storeId,
    channelSku: "PACK",
    productId,
    multiplier,
  });
  const batchIds: string[] = [];
  for (const [i, qty] of stocks.entries()) {
    const batchId = randomUUID();
    batchIds.push(batchId);
    await db.insert(productBatches).values({
      id: batchId,
      productId,
      companyId: EKETO_COMPANY_ID,
      batchNumber: `B${i}-${batchId}`,
      expirationDate: `2027-0${i + 1}-01`,
      initialQuantity: Math.max(1, qty),
    });
    await db.insert(inventoryByBatch).values({
      batchId,
      companyId: EKETO_COMPANY_ID,
      locationId: warehouse.id,
      quantity: qty,
    });
  }
  return {
    storeId,
    productId,
    variantId,
    warehouseId: warehouse.id,
    sellerId,
    batchIds,
  };
}
async function run(f: Fixture) {
  const id = randomUUID();
  await db.insert(amazonImportRuns).values({
    id,
    storeId: f.storeId,
    windowStart: new Date("2026-09-01T00:00:00Z"),
    windowEnd: new Date("2026-09-03T00:00:00Z"),
    dryRun: false,
  });
  return id;
}
async function ingest(f: Fixture, runId: string, rows: Row[]) {
  return ingestAmazonReport({
    storeId: f.storeId,
    runId,
    reportId: `r-${runId}`,
    reportDocumentId: `d-${runId}`,
    body: report(rows),
    compression: "NONE",
  });
}
async function items(f: Fixture) {
  return db
    .select()
    .from(marketplaceOrderItems)
    .where(eq(marketplaceOrderItems.amazonSellerAccountId, f.sellerId))
    .orderBy(marketplaceOrderItems.amazonOrderItemId);
}
async function stock(f: Fixture) {
  const rows = await db
    .select({ quantity: inventoryByBatch.quantity })
    .from(inventoryByBatch)
    .where(eq(inventoryByBatch.batchId, f.batchIds[0]));
  return rows[0].quantity;
}
async function ledger(f: Fixture) {
  return db
    .select()
    .from(amazonStockAllocations)
    .innerJoin(
      marketplaceOrderItems,
      eq(marketplaceOrderItems.id, amazonStockAllocations.itemId)
    )
    .where(eq(marketplaceOrderItems.amazonSellerAccountId, f.sellerId));
}

describe.skipIf(!enabled)(
  "Amazon core — isolated PostgreSQL (singleFork, no cleanup deletes)",
  () => {
    beforeAll(async () => {
      const raw = process.env.LOCAL_TEST_DATABASE_URL;
      if (!raw)
        throw new Error(
          "LOCAL_TEST_DATABASE_URL required; production DATABASE_URL is never used"
        );
      const url = new URL(raw);
      if (
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        url.port !== "55432" ||
        url.pathname !== "/gestionalesoketo_test" ||
        !["postgres:", "postgresql:"].includes(url.protocol)
      )
        throw new Error("Unsafe Amazon integration database target");
      client = postgres(raw, { prepare: false, max: 5, connect_timeout: 5 });
      db = drizzle(client);
      await db
        .insert(companies)
        .values([
          { id: EKETO_COMPANY_ID, name: "E-Keto Food Srls" },
          { id: SOKETO_COMPANY_ID, name: "SoKeto Srl" },
        ])
        .onConflictDoNothing();
      await db
        .insert(locations)
        .values({
          companyId: EKETO_COMPANY_ID,
          type: "central_warehouse",
          name: "E-Keto central test",
        })
        .onConflictDoNothing();
    });
    afterAll(async () => {
      if (client) await client.end();
    });

    it("durable ingest then multipack FEFO exactly once, item-Shipped partial order, actual immutable ledger IDs and timestamps", async () => {
      const f = await fixture(),
        runId = await run(f);
      expect(await ingest(f, runId, [{}])).toMatchObject({
        rows: 1,
        pending: 1,
        completed: false,
      });
      expect(await ledger(f)).toHaveLength(0);
      const [configBefore] = await db
        .select()
        .from(amazonImportConfigs)
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      expect(configBefore.checkpointAt).toBeNull();
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        processed: 1,
        errors: [],
      });
      const [item] = await items(f);
      expect(item).toMatchObject({
        amazonStockStatus: "processed",
        piecesQuantity: 6,
        amazonPiecesProcessed: 6,
        channelQuantity: 2,
        lineTotal: "12.00",
        unitPrice: "6.00",
      });
      const allocations = await ledger(f);
      expect(allocations).toHaveLength(2);
      expect(
        allocations.map(a => a.amazon_stock_allocations.pieces).sort()
      ).toEqual([3, 3]);
      for (const a of allocations) {
        const [movement] = await db
          .select()
          .from(stockMovements)
          .where(
            eq(stockMovements.id, a.amazon_stock_allocations.stockMovementId)
          );
        expect(movement).toMatchObject({
          companyId: EKETO_COMPANY_ID,
          type: "AMAZON_EXIT",
          sourceDocument: "order",
        });
        expect(movement.timestamp.toISOString()).toBe(
          "2026-09-02T08:00:00.000Z"
        );
        expect(movement.notes).toContain("data aggiornamento Amazon");
      }
      expect(await ingest(f, runId, [{}])).toMatchObject({ completed: true });
      await processPendingAmazonItems(f.storeId);
      expect(await ledger(f)).toHaveLength(2);
      const [configAfter] = await db
        .select()
        .from(amazonImportConfigs)
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      expect(configAfter.checkpointAt?.toISOString()).toBe(
        "2026-09-03T00:00:00.000Z"
      );
      await expect(
        db
          .update(amazonStockAllocations)
          .set({ pieces: 99 })
          .where(
            eq(
              amazonStockAllocations.id,
              allocations[0].amazon_stock_allocations.id
            )
          )
      ).rejects.toThrow();
    });
    it("concurrent receipt replay and concurrent queue consumers never double decrement", async () => {
      const f = await fixture(false, [12]),
        runId = await run(f);
      await Promise.all([ingest(f, runId, [{}]), ingest(f, runId, [{}])]);
      await Promise.all([
        processPendingAmazonItems(f.storeId),
        processPendingAmazonItems(f.storeId),
      ]);
      expect(await ledger(f)).toHaveLength(1);
      expect(await stock(f)).toBe(6);
      expect(await items(f)).toHaveLength(1);
    });
    it("FBA/unknown review, unshipped/cancelled/pre-cutoff audited with zero ledger", async () => {
      const f = await fixture(),
        runId = await run(f);
      await ingest(f, runId, [
        { "fulfillment-channel": "Amazon" },
        { "fulfillment-channel": "Unknown" },
        { "item-status": "Unshipped" },
        { "order-status": "Cancelled" },
        { "purchase-date": "2026-08-31T21:59:59Z" },
      ]);
      expect((await items(f)).map(i => i.amazonStockStatus)).toEqual([
        "review_required",
        "review_required",
        "not_shipped",
        "cancelled",
      ]);
      const [ignored] = await db
        .select({
          itemId: amazonImportRowObservations.itemId,
          reason: amazonImportRowObservations.reason,
        })
        .from(amazonImportRowObservations)
        .where(
          and(
            eq(amazonImportRowObservations.runId, runId),
            eq(amazonImportRowObservations.outcome, "pre_cutoff")
          )
        )
        .limit(1);
      expect(ignored).toEqual({
        itemId: null,
        reason: "pre-cutoff, già gestite a mano",
      });
      await processPendingAmazonItems(f.storeId);
      expect(await ledger(f)).toHaveLength(0);
      expect(await stock(f)).toBe(3);
    });
    it("dry-run per-product preview reserves only memory across bounded workers, no stock/ledger, then manually live processes eligible dry-run", async () => {
      const f = await fixture(true, [9]),
        runId = await run(f);
      await ingest(f, runId, [{}, {}]);
      await processPendingAmazonItems(f.storeId, 1);
      await processPendingAmazonItems(f.storeId, 1);
      const rows = await items(f);
      expect(rows.map(i => i.amazonStockStatus).sort()).toEqual([
        "dry_run",
        "review_required",
      ]);
      expect(
        rows.find(i => i.amazonStockStatus === "dry_run")?.amazonFefoPreview
      ).toMatchObject([
        { productId: f.productId, pieces: 6, expirationDate: "2027-01-01" },
      ]);
      expect(await ledger(f)).toHaveLength(0);
      expect(await stock(f)).toBe(9);
      await db
        .update(amazonImportConfigs)
        .set({ dryRun: false })
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        processed: 1,
      });
      expect(await stock(f)).toBe(3);
      expect(
        (await items(f)).filter(i => i.amazonStockStatus === "review_required")
      ).toHaveLength(1);
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
    });
    it("missing identity exists only in quarantined observation and PII is discarded", async () => {
      const f = await fixture(),
        runId = await run(f);
      expect(await ingest(f, runId, [{ "order-item-id": "" }])).toMatchObject({
        rows: 1,
        reviewRequired: 1,
        completed: true,
      });
      expect(await items(f)).toHaveLength(0);
      const [observation] = await db
        .select()
        .from(amazonImportRowObservations)
        .where(eq(amazonImportRowObservations.runId, runId));
      expect(observation).toMatchObject({
        itemId: null,
        outcome: "review_required",
      });
      expect(observation.reason).toContain("order-item-id");
    });
    it("queued Shipped then observed cancellation before processing prevents stock; stale snapshot never restores shipped", async () => {
      const f = await fixture(),
        runId = await run(f);
      await ingest(f, runId, [
        { "order-item-id": "same" },
        {
          "order-item-id": "same",
          "last-updated-date": "2026-09-02T11:00:00+02:00",
          "order-status": "Cancelled",
        },
        { "order-item-id": "same" },
      ]);
      expect((await items(f))[0]).toMatchObject({
        amazonOrderStatus: "Cancelled",
        amazonStockStatus: "cancelled",
      });
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      expect(await ledger(f)).toHaveLength(0);
      const outcomes = await db
        .select({ outcome: amazonImportRowObservations.outcome })
        .from(amazonImportRowObservations)
        .where(eq(amazonImportRowObservations.runId, runId));
      expect(outcomes.map(o => o.outcome)).toEqual([
        "cancelled",
        "cancelled",
        "stale_snapshot",
      ]);
    });
    it.each([false, true])(
      "equal timestamp status conflict fails closed, cancellation never lost (cancelFirst=%s)",
      async cancelFirst => {
        const f = await fixture(),
          runId = await run(f);
        const shipped = { "order-item-id": "same" },
          cancelled = { ...shipped, "order-status": "Cancelled" };
        await ingest(
          f,
          runId,
          cancelFirst ? [cancelled, shipped] : [shipped, cancelled]
        );
        expect((await items(f))[0]).toMatchObject({
          amazonOrderStatus: "Cancelled",
          amazonStockStatus: "review_required",
          amazonStockReason: "equal_timestamp_conflict",
        });
        await processPendingAmazonItems(f.storeId);
        expect(await ledger(f)).toHaveLength(0);
      }
    );
    it("after stock cancellation/return creates post_stock_alert and preserves frozen mapping/all allocations", async () => {
      const f = await fixture(false, [20]),
        runId = await run(f);
      await ingest(f, runId, [{}]);
      await processPendingAmazonItems(f.storeId);
      const original = (await items(f))[0];
      await db
        .update(channelVariants)
        .set({ multiplier: 99 })
        .where(eq(channelVariants.id, f.variantId));
      const next = await run(f);
      await ingest(f, next, [
        {
          "order-status": "Cancelled",
          "last-updated-date": "2026-09-03T10:00:00+02:00",
          quantity: "8",
        },
      ]);
      const changed = (await items(f))[0];
      expect(changed).toMatchObject({
        amazonStockStatus: "post_stock_alert",
        piecesQuantity: 6,
        channelQuantity: 2,
        amazonPiecesProcessed: 6,
      });
      expect(
        (changed.amazonSourceSnapshot as { frozenMapping: unknown })
          .frozenMapping
      ).toEqual(
        (original.amazonSourceSnapshot as { frozenMapping: unknown })
          .frozenMapping
      );
      expect(await stock(f)).toBe(14);
      expect(await ledger(f)).toHaveLength(1);
      const last = await run(f);
      await ingest(f, last, [
        {
          "item-status": "Returned",
          "last-updated-date": "2026-09-04T10:00:00+02:00",
        },
      ]);
      await processPendingAmazonItems(f.storeId);
      expect((await items(f))[0].amazonStockStatus).toBe("post_stock_alert");
      expect(await stock(f)).toBe(14);
    });
    it("insufficient line and all bundle components are atomic, multiplier applied once, no foreign-company stock", async () => {
      const f = await fixture(false, [2]),
        runId = await run(f);
      await ingest(f, runId, [{}]);
      await processPendingAmazonItems(f.storeId);
      expect((await items(f))[0].amazonStockStatus).toBe("review_required");
      expect(await stock(f)).toBe(2);
      expect(await ledger(f)).toHaveLength(0);
      const b = await fixture(false, [20], 77),
        p2 = randomUUID();
      await db
        .insert(products)
        .values({ id: p2, sku: p2, name: "Atom 2", unitPrice: "1.00" });
      await db
        .update(channelVariants)
        .set({ isBundle: true, productId: null })
        .where(eq(channelVariants.id, b.variantId));
      await db.insert(channelVariantComponents).values([
        { channelVariantId: b.variantId, productId: b.productId, quantity: 2 },
        { channelVariantId: b.variantId, productId: p2, quantity: 3 },
      ]);
      const bRun = await run(b);
      await ingest(b, bRun, [{}]);
      await processPendingAmazonItems(b.storeId);
      expect(await stock(b)).toBe(20);
      expect(await ledger(b)).toHaveLength(0);
      const secondBatch = randomUUID();
      await db.insert(productBatches).values({
        id: secondBatch,
        productId: p2,
        companyId: EKETO_COMPANY_ID,
        batchNumber: secondBatch,
        expirationDate: "2027-01-01",
        initialQuantity: 6,
      });
      await db.insert(inventoryByBatch).values({
        batchId: secondBatch,
        companyId: EKETO_COMPANY_ID,
        locationId: b.warehouseId,
        quantity: 6,
      });
      // Explicit administrative retry, not automatic stock review reprocessing.
      const [bundleItem] = await items(b);
      await db
        .update(marketplaceOrderItems)
        .set({ amazonStockStatus: "pending" })
        .where(eq(marketplaceOrderItems.id, bundleItem.id));
      await processPendingAmazonItems(b.storeId);
      expect((await items(b))[0]).toMatchObject({
        amazonStockStatus: "processed",
        amazonPiecesProcessed: 10,
        piecesQuantity: 10,
      });
      expect(await stock(b)).toBe(16);
      expect(
        (await ledger(b)).map(a => a.amazon_stock_allocations.pieces).sort()
      ).toEqual([4, 6]);
    });
    it("concurrent different stores sharing stock: insufficiency never makes stock negative", async () => {
      const f = await fixture(false, [9]),
        g = await fixture(false, [1]);
      await db
        .update(channelVariants)
        .set({ productId: f.productId })
        .where(eq(channelVariants.id, g.variantId));
      const fr = await run(f),
        gr = await run(g);
      await ingest(f, fr, [{}]);
      await ingest(g, gr, [{}]);
      await Promise.all([
        processPendingAmazonItems(f.storeId),
        processPendingAmazonItems(g.storeId),
      ]);
      const states = [
        (await items(f))[0].amazonStockStatus,
        (await items(g))[0].amazonStockStatus,
      ];
      expect(states.sort()).toEqual(["processed", "review_required"]);
      expect(await stock(f)).toBe(3);
    });
    it("parse errors change nothing, disabled/default config remains off, wrong company fail closed", async () => {
      const f = await fixture(),
        runId = await run(f);
      await expect(
        ingest(f, runId, [{ "last-updated-date": "2026-09-02T10:00:00" }])
      ).rejects.toThrow();
      const [r] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, runId));
      expect(r.documentSha256).toBeNull();
      expect(r.status).toBe("requested");
      expect(await items(f)).toHaveLength(0);
      await db
        .update(amazonImportConfigs)
        .set({ enabled: false })
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      await expect(ingest(f, runId, [{}])).rejects.toThrow("disabled");
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      await db
        .update(salesStores)
        .set({ companyId: SOKETO_COMPANY_ID })
        .where(eq(salesStores.id, f.storeId));
      await expect(processPendingAmazonItems(f.storeId)).rejects.toThrow(
        "E-Keto"
      );
      const emptyStore = randomUUID();
      await db.insert(salesStores).values({
        id: emptyStore,
        channel: "amazon",
        name: "defaults",
        storeIdentifier: emptyStore,
        companyId: EKETO_COMPANY_ID,
      });
      const [defaults] = await db
        .insert(amazonImportConfigs)
        .values({ storeId: emptyStore, sellerAccountId: emptyStore })
        .returning();
      expect(defaults).toMatchObject({
        enabled: false,
        dryRun: true,
        purchaseCutoff: "2026-09-01",
      });
    });
    it("bare cancellation quantity zero and empty financial fields prevents queued stock", async () => {
      const f = await fixture(),
        runId = await run(f);
      await ingest(f, runId, [
        { "order-item-id": "same" },
        {
          "order-item-id": "same",
          "last-updated-date": "2026-09-02T11:00:00+02:00",
          "order-status": "Cancelled",
          quantity: "0",
          currency: "",
          "item-price": "",
          sku: "",
        },
      ]);
      expect((await items(f))[0]).toMatchObject({
        amazonStockStatus: "cancelled",
        amazonOrderStatus: "Cancelled",
        channelQuantity: 2,
        lineTotal: "12.00",
      });
      await processPendingAmazonItems(f.storeId);
      expect(await ledger(f)).toHaveLength(0);
    });
    it("invalid eligible row value quarantines identity before queue, without blocking another valid item", async () => {
      const f = await fixture(),
        runId = await run(f);
      await ingest(f, runId, [
        { "order-item-id": "same" },
        {
          "order-item-id": "same",
          "last-updated-date": "2026-09-02T11:00:00+02:00",
          quantity: "bad",
        },
        { "order-item-id": "other" },
      ]);
      await processPendingAmazonItems(f.storeId);
      expect((await items(f)).map(i => i.amazonStockStatus)).toEqual([
        "processed",
        "review_required",
      ]);
      expect(await ledger(f)).toHaveLength(2);
    });
    it("preview reservations span completed report windows and insufficient mappings remain visible", async () => {
      const f = await fixture(true, [9]),
        first = await run(f);
      await ingest(f, first, [{ "order-item-id": "first" }]);
      await processPendingAmazonItems(f.storeId);
      const second = await run(f);
      await ingest(f, second, [{ "order-item-id": "second" }]);
      await processPendingAmazonItems(f.storeId);
      const rows = await items(f);
      expect(rows[0].amazonStockStatus).toBe("dry_run");
      expect(rows[1]).toMatchObject({
        amazonStockStatus: "review_required",
        productId: f.productId,
        channelVariantId: f.variantId,
        piecesQuantity: 6,
      });
      expect(rows[1].amazonStockReason).toContain("shortfalls");
      expect(await stock(f)).toBe(9);
      expect(await ledger(f)).toHaveLength(0);
    });
    it("FEFO ignores currently expired lots, not historical Amazon report time; header totals and item-tax reconcile", async () => {
      const f = await fixture(false, [10, 10]),
        runId = await run(f);
      await db
        .update(productBatches)
        .set({ expirationDate: "2026-01-01" })
        .where(eq(productBatches.id, f.batchIds[0]));
      const taxed = Buffer.from(
        `${[...headers, "item-tax"].join("\t")}\n${report([{}]).toString().split("\n")[1]}\t1.20\n`
      );
      await ingestAmazonReport({
        storeId: f.storeId,
        runId,
        reportId: `r-${runId}`,
        reportDocumentId: `d-${runId}`,
        body: taxed,
      });
      await processPendingAmazonItems(f.storeId);
      expect(await stock(f)).toBe(10);
      const [allocation] = await ledger(f);
      expect(allocation.amazon_stock_allocations.batchId).toBe(f.batchIds[1]);
      const [item] = await items(f);
      const [order] = await db
        .select()
        .from(marketplaceOrders)
        .where(eq(marketplaceOrders.id, item.marketplaceOrderId));
      expect(order).toMatchObject({
        totalGross: "13.20",
        stockProcessingStatus: "processed",
      });
      expect(item.lineTotal).toBe("12.00");
    });
    it("large foreign-company inventory never covers E-Keto shortage", async () => {
      const f = await fixture(false, [1]),
        runId = await run(f);
      const [foreign] = await db
        .insert(locations)
        .values({
          companyId: SOKETO_COMPANY_ID,
          type: "central_warehouse",
          name: "SoKeto foreign test",
        })
        .onConflictDoNothing()
        .returning({ id: locations.id });
      const [existing] = foreign
        ? []
        : await db
            .select({ id: locations.id })
            .from(locations)
            .where(
              and(
                eq(locations.companyId, SOKETO_COMPANY_ID),
                eq(locations.type, "central_warehouse")
              )
            )
            .limit(1);
      const foreignBatch = randomUUID();
      await db.insert(productBatches).values({
        id: foreignBatch,
        productId: f.productId,
        companyId: SOKETO_COMPANY_ID,
        batchNumber: foreignBatch,
        expirationDate: "2027-01-01",
        initialQuantity: 1000,
      });
      await db.insert(inventoryByBatch).values({
        batchId: foreignBatch,
        companyId: SOKETO_COMPANY_ID,
        locationId: foreign?.id ?? existing.id,
        quantity: 1000,
      });
      await ingest(f, runId, [{}]);
      await processPendingAmazonItems(f.storeId);
      expect((await items(f))[0].amazonStockStatus).toBe("review_required");
      expect(await stock(f)).toBe(1);
      expect(await ledger(f)).toHaveLength(0);
    });
    it("sequential report overlap never duplicates stock and pending item can ship in a later report", async () => {
      const f = await fixture(false, [20]),
        first = await run(f);
      await ingest(f, first, [
        { "order-item-id": "same", "item-status": "Unshipped" },
      ]);
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      const second = await run(f);
      await ingest(f, second, [
        {
          "order-item-id": "same",
          "last-updated-date": "2026-09-03T10:00:00+02:00",
        },
      ]);
      await processPendingAmazonItems(f.storeId);
      const third = await run(f);
      await ingest(f, third, [
        {
          "order-item-id": "same",
          "last-updated-date": "2026-09-03T10:00:00+02:00",
        },
      ]);
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      expect(await ledger(f)).toHaveLength(1);
      expect(await stock(f)).toBe(14);
      const fourth = await run(f);
      await ingest(f, fourth, [
        {
          "order-item-id": "same",
          "item-status": "Unshipped",
          "last-updated-date": "2026-09-02T10:00:00+02:00",
        },
      ]);
      expect((await items(f))[0]).toMatchObject({
        amazonStockStatus: "processed",
        amazonItemStatus: "Shipped",
      });
      expect(await ledger(f)).toHaveLength(1);
    });
    it("UK Merchant/Shipped in GBP scarica i pezzi senza conversione valutaria", async () => {
      const f = await fixture(false, [20]);
      const id = await run(f);
      await ingest(f, id, [{ currency: "GBP", "item-price": "£12.00" }]);
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        processed: 1,
        errors: [],
      });
      const [item] = await items(f);
      const [order] = await db
        .select({
          currency: marketplaceOrders.currency,
          gross: marketplaceOrders.totalGross,
        })
        .from(marketplaceOrders)
        .where(eq(marketplaceOrders.id, item.marketplaceOrderId))
        .limit(1);
      expect(order).toEqual({ currency: "GBP", gross: "12.00" });
      expect(await stock(f)).toBe(14);
      expect(await ledger(f)).toHaveLength(1);
    });
    it("una valuta diversa sullo stesso articolo è segnalata senza nuovi scarichi o rietichettare gli importi", async () => {
      const f = await fixture(false, [20]);
      const first = await run(f);
      await ingest(f, first, [{ currency: "GBP" }]);
      await processPendingAmazonItems(f.storeId);
      const second = await run(f);
      await ingest(f, second, [
        { currency: "EUR", "last-updated-date": "2026-09-03T10:00:00+02:00" },
      ]);
      const [item] = await items(f);
      expect(item.amazonStockStatus).toBe("post_stock_alert");
      expect(item.amazonStockReason).toBe("order_currency_mismatch");
      await processPendingAmazonItems(f.storeId);
      const [order] = await db
        .select({ currency: marketplaceOrders.currency })
        .from(marketplaceOrders)
        .where(eq(marketplaceOrders.id, item.marketplaceOrderId))
        .limit(1);
      expect(order.currency).toBe("GBP");
      expect(await stock(f)).toBe(14);
      expect(await ledger(f)).toHaveLength(1);
    });
    it("riepilogo per prodotto non moltiplica piani ripetuti e conta un ordine distinto", async () => {
      const f = await fixture(true, [20]);
      const id = await run(f);
      await ingest(f, id, [
        { "order-item-id": "same" },
        { "order-item-id": "same" },
        { "order-item-id": "same" },
      ]);
      await processPendingAmazonItems(f.storeId);
      const input = {
        storeId: f.storeId,
        dateFrom: "2026-01-01",
        dateTo: "2027-12-31",
      };
      const preview = await getAmazonImportProductSummary(db, input);
      expect(preview.importedOrders).toBe(1);
      expect(preview.products).toMatchObject([
        { productId: f.productId, actualPieces: 0, plannedPieces: 6 },
      ]);
      expect(preview.dailyOrders).toHaveLength(1);
      await db
        .update(amazonImportConfigs)
        .set({ dryRun: false })
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      await processPendingAmazonItems(f.storeId);
      const actual = await getAmazonImportProductSummary(db, input);
      expect(actual.importedOrders).toBe(1);
      expect(actual.products).toMatchObject([
        { productId: f.productId, actualPieces: 6, plannedPieces: 0 },
      ]);
      expect(await stock(f)).toBe(14);
    });
  }
);
