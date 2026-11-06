import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, sql } from "drizzle-orm";
import { EKETO_COMPANY_ID } from "../../shared/const";
import {
  amazonImportConfigs,
  amazonImportDocuments,
  amazonImportRowObservations,
  amazonImportRuns,
  amazonStockAllocations,
  channelVariants,
  companies,
  inventoryByBatch,
  locations,
  marketplaceOrderItems,
  productBatches,
  products,
  salesStores,
  stockMovements,
} from "../../drizzle/schema";
import {
  acquireAmazonReportDocument,
  processAmazonReportBatch,
} from "./amazonReportDocumentService";
import {
  ingestAmazonReport,
  processPendingAmazonItems,
} from "./amazonOrderImportService";
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
vi.mock("../db", () => ({ getDb: async () => db }));
const enabled = Boolean(process.env.LOCAL_TEST_DATABASE_URL);
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
type Row = Partial<Record<string, string>>;
const report = (rows: Row[]) =>
  Buffer.from(
    [
      headers.join("\t"),
      ...rows.map((row, i) =>
        headers
          .map(
            header =>
              ({
                "amazon-order-id": "durable-order",
                "order-item-id": `item-${i}`,
                "purchase-date": "2026-09-01T10:00:00+02:00",
                "last-updated-date": "2026-09-02T10:00:00+02:00",
                "order-status": "PartiallyShipped",
                "item-status": "Shipped",
                "fulfillment-channel": "Merchant",
                sku: "DURABLE-PACK",
                quantity: "2",
                currency: "EUR",
                "item-price": "12.00",
                ...row,
              })[header]
          )
          .join("\t")
      ),
    ].join("\n") + "\n"
  );
async function fixture(dryRun = false, quantity = 100) {
  const storeId = randomUUID(),
    productId = randomUUID(),
    batchId = randomUUID(),
    runId = randomUUID();
  const sellerId = `durable-${storeId}`;
  const [warehouse] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.companyId, EKETO_COMPANY_ID),
        eq(locations.type, "central_warehouse"),
        eq(locations.isActive, true)
      )
    )
    .limit(1);
  await db.insert(salesStores).values({
    id: storeId,
    channel: "amazon",
    name: "Amazon durable test",
    storeIdentifier: storeId,
    companyId: EKETO_COMPANY_ID,
  });
  await db
    .insert(amazonImportConfigs)
    .values({ storeId, sellerAccountId: sellerId, enabled: true, dryRun });
  await db.insert(products).values({
    id: productId,
    sku: `DURABLE-${productId}`,
    name: "Durable test product",
    unitPrice: "1.00",
  });
  await db
    .insert(channelVariants)
    .values({ storeId, channelSku: "DURABLE-PACK", productId, multiplier: 3 });
  await db.insert(productBatches).values({
    id: batchId,
    productId,
    companyId: EKETO_COMPANY_ID,
    batchNumber: `D-${batchId}`,
    expirationDate: "2028-01-01",
    initialQuantity: quantity,
  });
  await db.insert(inventoryByBatch).values({
    batchId,
    companyId: EKETO_COMPANY_ID,
    locationId: warehouse.id,
    quantity,
  });
  await db.insert(amazonImportRuns).values({
    id: runId,
    storeId,
    windowStart: new Date("2026-09-01T00:00:00Z"),
    windowEnd: new Date("2026-09-03T00:00:00Z"),
  });
  return { storeId, productId, batchId, runId, sellerId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = (f: Fixture, rows: Row[] = [{}]) => ({
  storeId: f.storeId,
  runId: f.runId,
  reportId: `report-${f.runId}`,
  reportDocumentId: `document-${f.runId}`,
  body: report(rows),
  compression: "NONE",
});
async function observations(f: Fixture) {
  return db
    .select()
    .from(amazonImportRowObservations)
    .where(eq(amazonImportRowObservations.runId, f.runId))
    .orderBy(asc(amazonImportRowObservations.rowKey));
}
async function items(f: Fixture) {
  return db
    .select()
    .from(marketplaceOrderItems)
    .where(eq(marketplaceOrderItems.amazonSellerAccountId, f.sellerId))
    .orderBy(asc(marketplaceOrderItems.amazonOrderItemId));
}
async function stock(f: Fixture) {
  const [row] = await db
    .select({ quantity: inventoryByBatch.quantity })
    .from(inventoryByBatch)
    .where(eq(inventoryByBatch.batchId, f.batchId))
    .limit(1);
  return row.quantity;
}
async function document(f: Fixture) {
  const [row] = await db
    .select()
    .from(amazonImportDocuments)
    .where(eq(amazonImportDocuments.runId, f.runId))
    .limit(1);
  return row;
}
async function run(f: Fixture) {
  const [row] = await db
    .select()
    .from(amazonImportRuns)
    .where(eq(amazonImportRuns.id, f.runId))
    .limit(1);
  return row;
}
async function checkpoint(f: Fixture) {
  const [row] = await db
    .select({ at: amazonImportConfigs.checkpointAt })
    .from(amazonImportConfigs)
    .where(eq(amazonImportConfigs.storeId, f.storeId))
    .limit(1);
  return row.at;
}
async function ledger(f: Fixture) {
  return db
    .select()
    .from(amazonStockAllocations)
    .where(eq(amazonStockAllocations.runId, f.runId));
}

describe.skipIf(!enabled)(
  "Amazon durable report processing — safe local PostgreSQL only",
  () => {
    beforeAll(async () => {
      const raw = process.env.LOCAL_TEST_DATABASE_URL!;
      const url = new URL(raw);
      if (
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        url.port !== "55432" ||
        url.pathname !== "/gestionalesoketo_test" ||
        !["postgres:", "postgresql:"].includes(url.protocol)
      )
        throw new Error("Unsafe durable Amazon integration database target");
      client = postgres(raw, { prepare: false, max: 5, connect_timeout: 5 });
      db = drizzle(client);
      await db
        .insert(companies)
        .values({ id: EKETO_COMPANY_ID, name: "E-Keto Food Srls" })
        .onConflictDoNothing();
      await db
        .insert(locations)
        .values({
          companyId: EKETO_COMPANY_ID,
          type: "central_warehouse",
          name: "Durable Amazon central test",
        })
        .onConflictDoNothing();
    });
    afterAll(async () => {
      if (client) await client.end();
    });

    it("aggregate overflow rolls back only the offending row savepoint and advances cursor with safe quarantine", async () => {
      const f = await fixture();
      await acquireAmazonReportDocument(
        input(f, [
          { "item-price": "60000000.00", "fulfillment-channel": "Amazon" },
          { "item-price": "60000000.00", "fulfillment-channel": "Amazon" },
          { "item-price": "12.00", "fulfillment-channel": "Amazon" },
        ])
      );
      const result = await processAmazonReportBatch(f.storeId, { rowLimit: 3 });
      expect(result).toMatchObject({
        completed: true,
        hasMore: false,
        ingestedRows: 3,
        worker: { attempted: 0 },
      });
      const observed = await observations(f);
      expect(observed).toHaveLength(3);
      expect(observed[1]).toMatchObject({
        itemId: null,
        outcome: "review_required",
        reason: "document_row_transaction_failed",
      });
      expect(await items(f)).toHaveLength(2);
      expect(await stock(f)).toBe(100);
      expect(await ledger(f)).toHaveLength(0);
    });

    it("a non-pending partial chunk cannot complete its run or checkpoint before the remaining rows", async () => {
      const f = await fixture();
      await acquireAmazonReportDocument(
        input(f, [
          { "item-status": "Unshipped" },
          { "item-status": "Unshipped" },
        ])
      );
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 1 })
      ).toMatchObject({ ingestedRows: 1, completed: false, hasMore: true });
      expect((await run(f)).status).toBe("processing");
      expect(await checkpoint(f)).toBeNull();
      expect((await document(f)).processingCompletedAt).toBeNull();
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 1 })
      ).toMatchObject({ completed: true, hasMore: false });
      expect(await stock(f)).toBe(100);
    });

    it("upload persists only immutable original bytes and run identity; no observations/items/stock/checkpoint", async () => {
      const f = await fixture();
      const receipt = input(f, [{}, {}, {}]);
      expect(await acquireAmazonReportDocument(receipt)).toEqual({
        alreadyAcquired: false,
        completed: false,
        runId: f.runId,
        totalRows: 3,
        ingestedRows: 0,
      });
      expect(await observations(f)).toEqual([]);
      expect(await items(f)).toEqual([]);
      expect(await ledger(f)).toEqual([]);
      expect(await stock(f)).toBe(100);
      expect(await checkpoint(f)).toBeNull();
      const saved = await document(f);
      expect(Buffer.from(saved.bodyBase64, "base64")).toEqual(receipt.body);
      expect(saved).toMatchObject({
        compression: "NONE",
        totalRows: 3,
        ingestedRows: 0,
        ingestStartedAt: null,
        ingestCompletedAt: null,
        processingCompletedAt: null,
        processingMs: 0,
      });
      await expect(
        db
          .update(amazonImportDocuments)
          .set({ bodyBase64: report([]).toString("base64") })
          .where(eq(amazonImportDocuments.runId, f.runId))
      ).rejects.toThrow();
      const [rls] = await db.execute(
        sql`select relrowsecurity from pg_class where oid = 'public.amazon_import_documents'::regclass`
      );
      expect(rls.relrowsecurity).toBe(true);
      expect(await acquireAmazonReportDocument(receipt)).toMatchObject({
        alreadyAcquired: true,
        completed: false,
        ingestedRows: 0,
      });
    });

    it("restart resumes committed cursor across batches; no worker stock until entire ingestion completes", async () => {
      const f = await fixture();
      const receipt = input(f, [{}, {}, {}, {}]);
      await acquireAmazonReportDocument(receipt);
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 1 })
      ).toMatchObject({
        ingestedThisBatch: 1,
        ingestedRows: 1,
        hasMore: true,
        completed: false,
        worker: { attempted: 0 },
      });
      expect(await observations(f)).toHaveLength(1);
      expect(await checkpoint(f)).toBeNull();
      expect((await run(f)).status).toBe("processing");
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      // Connection restart simulates a new process: no in-memory cursor is used.
      await client.end();
      client = postgres(process.env.LOCAL_TEST_DATABASE_URL!, {
        prepare: false,
        max: 5,
      });
      db = drizzle(client);
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 2 })
      ).toMatchObject({
        ingestedThisBatch: 2,
        ingestedRows: 3,
        completed: false,
        worker: { attempted: 0 },
      });
      expect(await stock(f)).toBe(100);
      expect(await acquireAmazonReportDocument(receipt)).toMatchObject({
        alreadyAcquired: true,
        totalRows: 4,
        ingestedRows: 3,
        completed: false,
      });
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 1, itemLimit: 1 })
      ).toMatchObject({
        ingestedThisBatch: 1,
        ingestedRows: 4,
        hasMore: true,
        worker: { processed: 1 },
      });
      expect(await observations(f)).toHaveLength(4);
      expect(await checkpoint(f)).toBeNull();
      expect(
        await processAmazonReportBatch(f.storeId, { itemLimit: 3 })
      ).toMatchObject({
        completed: true,
        hasMore: false,
        worker: { processed: 3 },
      });
      expect(await stock(f)).toBe(76);
      expect(await ledger(f)).toHaveLength(4);
      expect(await checkpoint(f)).toEqual(new Date("2026-09-03T00:00:00Z"));
      const saved = await document(f);
      expect(saved.ingestCompletedAt).toBeInstanceOf(Date);
      expect(saved.processingCompletedAt).toBeInstanceOf(Date);
      expect(saved.processingMs).toBeGreaterThanOrEqual(0);
      expect(await acquireAmazonReportDocument(receipt)).toMatchObject({
        alreadyAcquired: true,
        completed: true,
        ingestedRows: 4,
      });
    });

    it("concurrent exact acquisition and bounded consumers produce one receipt/observation/stock ledger per item", async () => {
      const f = await fixture();
      const receipt = input(f, [{}, {}, {}]);
      const acquired = await Promise.all([
        acquireAmazonReportDocument(receipt),
        acquireAmazonReportDocument(receipt),
      ]);
      expect(acquired.map(r => r.alreadyAcquired).sort()).toEqual([
        false,
        true,
      ]);
      await Promise.all([
        processAmazonReportBatch(f.storeId, { rowLimit: 1 }),
        processAmazonReportBatch(f.storeId, { rowLimit: 1 }),
      ]);
      expect((await document(f)).ingestedRows).toBe(2);
      expect(await stock(f)).toBe(100);
      await Promise.all([
        processAmazonReportBatch(f.storeId, { rowLimit: 1 }),
        processAmazonReportBatch(f.storeId, { rowLimit: 1 }),
      ]);
      await processAmazonReportBatch(f.storeId);
      expect(await observations(f)).toHaveLength(3);
      expect(await items(f)).toHaveLength(3);
      expect(await ledger(f)).toHaveLength(3);
      expect(await stock(f)).toBe(82);
    });

    it("same run with conflicting body/report/document/compression rejects without re-ingestion", async () => {
      const f = await fixture();
      const receipt = input(f);
      await acquireAmazonReportDocument(receipt);
      await expect(
        acquireAmazonReportDocument({
          ...receipt,
          body: report([{ quantity: "3" }]),
        })
      ).rejects.toMatchObject({ code: "DOCUMENT_REPLAY_MISMATCH" });
      await expect(
        acquireAmazonReportDocument({ ...receipt, reportId: "different" })
      ).rejects.toMatchObject({ code: "REPORT_ID_MISMATCH" });
      await expect(
        acquireAmazonReportDocument({
          ...receipt,
          reportDocumentId: "different",
        })
      ).rejects.toMatchObject({ code: "DOCUMENT_REPLAY_MISMATCH" });
      await expect(
        acquireAmazonReportDocument({ ...receipt, compression: "GZIP" })
      ).rejects.toMatchObject({ code: "COMPRESSION_MISMATCH" });
      expect(await items(f)).toHaveLength(0);
      expect((await document(f)).ingestedRows).toBe(0);
    });

    it("later-batch bare cancellation changes earlier pending observations before stock", async () => {
      const f = await fixture();
      await acquireAmazonReportDocument(
        input(f, [
          { "order-item-id": "same" },
          { "order-item-id": "unshipped", "item-status": "Unshipped" },
          {
            "order-item-id": "same",
            "last-updated-date": "2026-09-02T11:00:00+02:00",
            "order-status": "Cancelled",
            quantity: "0",
            currency: "",
            "item-price": "",
            sku: "",
          },
        ])
      );
      await processAmazonReportBatch(f.storeId, { rowLimit: 1 });
      await processAmazonReportBatch(f.storeId, { rowLimit: 1 });
      expect((await observations(f))[0].outcome).toBe("pending");
      expect(await stock(f)).toBe(100);
      const result = await processAmazonReportBatch(f.storeId, { rowLimit: 1 });
      expect(result).toMatchObject({
        completed: true,
        hasMore: false,
        worker: { attempted: 0 },
      });
      expect((await observations(f)).map(o => o.outcome)).toEqual([
        "cancelled",
        "not_shipped",
        "cancelled",
      ]);
      expect(
        (await items(f)).find(i => i.amazonOrderItemId === "same")
      ).toMatchObject({ amazonStockStatus: "cancelled", channelQuantity: 2 });
      expect(await ledger(f)).toHaveLength(0);
      expect(await stock(f)).toBe(100);
    });

    it("header errors reject acquisition before persistence; structural malformed rows quarantine and do not poison cursor", async () => {
      const f = await fixture();
      const receipt = input(f);
      await expect(
        acquireAmazonReportDocument({
          ...receipt,
          body: Buffer.from(
            receipt.body.toString().replace("last-updated-date", "unused")
          ),
        })
      ).rejects.toMatchObject({ code: "DOCUMENT_HEADER_MISSING" });
      expect(await document(f)).toBeUndefined();
      expect((await run(f)).documentSha256).toBeNull();
      const lines = report([
        { "order-item-id": "first" },
        { "order-item-id": "last" },
      ])
        .toString()
        .trimEnd()
        .split("\n");
      const body = Buffer.from(
        [lines[0], lines[1], "broken\tPRIVATE_VALUE", lines[2]].join("\n") +
          "\n"
      );
      await acquireAmazonReportDocument({ ...receipt, body });
      await processAmazonReportBatch(f.storeId, { rowLimit: 1 });
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 1 })
      ).toMatchObject({ ingestedRows: 2, worker: { attempted: 0 } });
      expect((await observations(f))[1]).toMatchObject({
        itemId: null,
        outcome: "review_required",
        sourceRow: { _diagnostic: { rowNumber: 3, field: "column-count" } },
      });
      expect(JSON.stringify(await observations(f))).not.toContain(
        "PRIVATE_VALUE"
      );
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 1, itemLimit: 2 })
      ).toMatchObject({
        completed: true,
        hasMore: false,
        worker: { processed: 2 },
      });
      expect(await observations(f)).toHaveLength(3);
      expect(await stock(f)).toBe(88);
    });

    it("zero-row document is acquired fast then finalized by worker with checkpoint and no stock", async () => {
      const f = await fixture();
      expect(await acquireAmazonReportDocument(input(f, []))).toMatchObject({
        completed: false,
        totalRows: 0,
        ingestedRows: 0,
      });
      expect(await checkpoint(f)).toBeNull();
      expect(await processAmazonReportBatch(f.storeId)).toMatchObject({
        completed: true,
        hasMore: false,
        ingestedThisBatch: 0,
        totalRows: 0,
        worker: { attempted: 0 },
      });
      expect((await document(f)).processingCompletedAt).toBeInstanceOf(Date);
      expect(await checkpoint(f)).toEqual(new Date("2026-09-03T00:00:00Z"));
      expect(await ledger(f)).toHaveLength(0);
      expect(await stock(f)).toBe(100);
    });

    it("disabled config blocks new acquisitions, ingestion, and stock without changing durable cursor", async () => {
      const f = await fixture();
      const receipt = input(f, [{}, {}]);
      await acquireAmazonReportDocument(receipt);
      await processAmazonReportBatch(f.storeId, { rowLimit: 1 });
      await db
        .update(amazonImportConfigs)
        .set({ enabled: false })
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      expect(await processAmazonReportBatch(f.storeId)).toMatchObject({
        disabled: true,
        completed: false,
        hasMore: false,
        worker: { attempted: 0 },
      });
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      await expect(acquireAmazonReportDocument(receipt)).rejects.toMatchObject({
        code: "STORE_DISABLED",
      });
      expect((await document(f)).ingestedRows).toBe(1);
      expect(await observations(f)).toHaveLength(1);
      expect(await checkpoint(f)).toBeNull();
      expect(await stock(f)).toBe(100);
      await db
        .update(amazonImportConfigs)
        .set({ enabled: true })
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      expect(await processAmazonReportBatch(f.storeId)).toMatchObject({
        completed: true,
        worker: { processed: 2 },
      });
    });

    it("dry-run reservations remain cumulative across bounded batches; FBA/unknown never stock", async () => {
      const f = await fixture(true, 9);
      await acquireAmazonReportDocument(
        input(f, [
          {},
          {},
          { "fulfillment-channel": "Amazon" },
          { "fulfillment-channel": "Unknown" },
        ])
      );
      await processAmazonReportBatch(f.storeId, { rowLimit: 2 });
      expect(await stock(f)).toBe(9);
      expect(
        await processAmazonReportBatch(f.storeId, { rowLimit: 2, itemLimit: 1 })
      ).toMatchObject({ worker: { dryRun: 1 } });
      expect(
        await processAmazonReportBatch(f.storeId, { itemLimit: 1 })
      ).toMatchObject({
        completed: true,
        hasMore: false,
        worker: { reviewRequired: 1 },
      });
      const observed = await observations(f);
      expect(
        observed
          .slice(0, 2)
          .map(o => o.outcome)
          .sort()
      ).toEqual(["dry_run", "review_required"]);
      expect(observed[2].reason).toBe("fba_no_stock");
      expect(observed[3].reason).toBe("unknown_fulfillment_channel");
      expect(await stock(f)).toBe(9);
      expect(await ledger(f)).toHaveLength(0);
      await db
        .update(amazonImportConfigs)
        .set({ dryRun: false })
        .where(eq(amazonImportConfigs.storeId, f.storeId));
      expect(await processAmazonReportBatch(f.storeId)).toMatchObject({
        worker: { processed: 1 },
      });
      expect(await stock(f)).toBe(3);
    });

    it("legacy synchronous receipt with digest but no document is never re-ingested", async () => {
      const f = await fixture();
      const receipt = input(f);
      await ingestAmazonReport(receipt);
      expect(await document(f)).toBeUndefined();
      expect(await acquireAmazonReportDocument(receipt)).toMatchObject({
        alreadyAcquired: true,
        completed: false,
        totalRows: 1,
        ingestedRows: 1,
      });
      expect(await document(f)).toBeUndefined();
      expect(await observations(f)).toHaveLength(1);
      await processAmazonReportBatch(f.storeId);
      expect(await stock(f)).toBe(94);
      expect(await acquireAmazonReportDocument(receipt)).toMatchObject({
        alreadyAcquired: true,
        completed: true,
      });
      expect(await document(f)).toBeUndefined();
    });

    it("compressed original bytes remain exact and budget/limits reject safely", async () => {
      const f = await fixture();
      const receipt = {
        ...input(f),
        body: gzipSync(report([{}])),
        compression: "GZIP",
      };
      await acquireAmazonReportDocument(receipt);
      expect(Buffer.from((await document(f)).bodyBase64, "base64")).toEqual(
        receipt.body
      );
      expect(
        await processAmazonReportBatch(f.storeId, { timeBudgetMs: 1000 })
      ).toMatchObject({ completed: true, worker: { processed: 1 } });
      for (const options of [
        { timeBudgetMs: 999 },
        { timeBudgetMs: 12001 },
        { rowLimit: 0 },
        { rowLimit: 201 },
        { itemLimit: 0 },
      ])
        await expect(
          processAmazonReportBatch(f.storeId, options)
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await ledger(f)).toHaveLength(1);
    });

    it("stock gate is global for store even when a queued item comes from an earlier receipt", async () => {
      const f = await fixture();
      await ingestAmazonReport(input(f));
      // Simulate a pre-existing closed legacy run whose item is still awaiting review/retry.
      await db
        .update(amazonImportRuns)
        .set({ status: "review_required" })
        .where(eq(amazonImportRuns.id, f.runId));
      const nextRunId = randomUUID();
      await db.insert(amazonImportRuns).values({
        id: nextRunId,
        storeId: f.storeId,
        windowStart: new Date("2026-09-03T00:00:00Z"),
        windowEnd: new Date("2026-09-04T00:00:00Z"),
      });
      const next = { ...f, runId: nextRunId };
      await acquireAmazonReportDocument(
        input(next, [
          { "order-item-id": "other", "item-status": "Unshipped" },
          {
            "order-item-id": "item-0",
            "order-status": "Cancelled",
            "last-updated-date": "2026-09-03T10:00:00+02:00",
          },
        ])
      );
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      await processAmazonReportBatch(f.storeId, { rowLimit: 1 });
      expect(await processPendingAmazonItems(f.storeId)).toMatchObject({
        attempted: 0,
      });
      expect(await stock(f)).toBe(100);
      await processAmazonReportBatch(f.storeId, { rowLimit: 1 });
      expect((await observations(f))[0].outcome).toBe("cancelled");
      expect(await stock(f)).toBe(100);
      expect(await ledger(f)).toHaveLength(0);
    });

    it("config lock timeout fails acquisition quickly and safely, leaves no partial document", async () => {
      const f = await fixture();
      let release!: () => void;
      let held!: () => void;
      const acquiredLock = new Promise<void>(resolve => {
        held = resolve;
      });
      const unblock = new Promise<void>(resolve => {
        release = resolve;
      });
      const blocker = db.transaction(async tx => {
        await tx
          .select({ id: amazonImportConfigs.storeId })
          .from(amazonImportConfigs)
          .where(eq(amazonImportConfigs.storeId, f.storeId))
          .limit(1)
          .for("update");
        held();
        await unblock;
      });
      await acquiredLock;
      const start = Date.now();
      try {
        await expect(
          acquireAmazonReportDocument(input(f))
        ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
        expect(Date.now() - start).toBeLessThan(2500);
      } finally {
        release();
        await blocker;
      }
      expect(await document(f)).toBeUndefined();
      expect((await run(f)).documentSha256).toBeNull();
      expect(await observations(f)).toHaveLength(0);
    });
  }
);
