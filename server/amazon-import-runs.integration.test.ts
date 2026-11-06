import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { EKETO_COMPANY_ID } from "../shared/const";
import {
  amazonImportConfigs,
  amazonImportRuns,
  companies,
  salesStores,
} from "../drizzle/schema";
let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof postgres>;
vi.mock("./db", () => ({ getDb: async () => db }));
import amazonRoutes from "./amazon-import-routes";

const enabled = Boolean(process.env.LOCAL_TEST_DATABASE_URL);
const oldKey = process.env.AMAZON_IMPORT_WEBHOOK_KEY;
const oldStore = process.env.AMAZON_IMPORT_STORE_ID;
const secret = "amazon-run-local-only-secret-0123456789012345";
const storeId = randomUUID();
let server: Server;
let base: string;
const auth = { "X-SoKeto-Amazon-Key": secret };
const reportType = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL";
const reportHeaders = (id: string, reportId: string) => ({
  ...auth,
  "X-Amazon-Import-Run-Id": id,
  "X-Amazon-Report-Id": reportId,
  "X-Amazon-Report-Type": reportType,
  "Content-Type": "application/json",
});

describe.skipIf(!enabled)(
  "checkpoint Make Amazon — HTTP e PostgreSQL isolato",
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!);
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.port !== "55432" ||
        url.pathname !== "/gestionalesoketo_test"
      )
        throw new Error("Unsafe test database");
      client = postgres(url.toString(), { prepare: false, max: 5 });
      db = drizzle(client);
      await db
        .insert(companies)
        .values({ id: EKETO_COMPANY_ID, name: "E-Keto Food Srls" })
        .onConflictDoNothing();
      await db.insert(salesStores).values({
        id: storeId,
        channel: "amazon",
        name: "HTTP test Amazon",
        storeIdentifier: storeId,
        companyId: EKETO_COMPANY_ID,
      });
      await db.insert(amazonImportConfigs).values({
        storeId,
        sellerAccountId: `http-test-${storeId}`,
        enabled: true,
      });
      process.env.AMAZON_IMPORT_WEBHOOK_KEY = secret;
      process.env.AMAZON_IMPORT_STORE_ID = storeId;
      const app = express();
      app.use("/api/marketplace/amazon", amazonRoutes);
      server = await new Promise<Server>(resolve => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Test server failed");
      base = `http://127.0.0.1:${address.port}/api/marketplace/amazon`;
    });
    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
      if (client) await client.end();
      if (oldKey === undefined) delete process.env.AMAZON_IMPORT_WEBHOOK_KEY;
      else process.env.AMAZON_IMPORT_WEBHOOK_KEY = oldKey;
      if (oldStore === undefined) delete process.env.AMAZON_IMPORT_STORE_ID;
      else process.env.AMAZON_IMPORT_STORE_ID = oldStore;
    });
    it("GET concorrenti creano un solo run; pending recupera lo stesso report; acquisizione vuota avanza il checkpoint una volta", async () => {
      const responses = await Promise.all([
        fetch(`${base}/import-window`, { headers: auth }),
        fetch(`${base}/import-window`, { headers: auth }),
      ]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const windows = await Promise.all(
        responses.map(response => response.json())
      );
      expect(windows[0].run_id).toBe(windows[1].run_id);
      expect(windows[0].window_start).toBe("2026-08-31T22:00:00.000Z");
      const id = windows[0].run_id as string;
      const reportId = `report-${id}`;
      const created = await fetch(`${base}/report-created`, {
        method: "POST",
        headers: reportHeaders(id, reportId),
        body: JSON.stringify({ schema_version: 1, outcome: "REPORT_CREATED" }),
      });
      expect(created.status).toBe(200);
      const pending = await fetch(`${base}/report-status`, {
        method: "POST",
        headers: reportHeaders(id, reportId),
        body: JSON.stringify({
          schema_version: 1,
          outcome: "POLLING_EXHAUSTED",
        }),
      });
      expect(pending.status).toBe(200);
      const recovered = await (
        await fetch(`${base}/import-window`, { headers: auth })
      ).json();
      expect(recovered).toMatchObject({ run_id: id, report_id: reportId });
      let [config] = await db
        .select()
        .from(amazonImportConfigs)
        .where(eq(amazonImportConfigs.storeId, storeId))
        .limit(1);
      expect(config.checkpointAt).toBeNull();
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
      ];
      const fileHeaders = {
        ...reportHeaders(id, reportId),
        "Content-Type": "text/plain",
        "X-Amazon-Report-Document-Id": `doc-${id}`,
        "X-Amazon-Processing-Status": "DONE",
      };
      const upload = () =>
        fetch(`${base}/report-file`, {
          method: "POST",
          headers: fileHeaders,
          body: `${columns.join("\t")}\n`,
        });
      expect((await upload()).status).toBe(200);
      expect((await upload()).status).toBe(200);
      [config] = await db
        .select()
        .from(amazonImportConfigs)
        .where(eq(amazonImportConfigs.storeId, storeId))
        .limit(1);
      expect(config.checkpointAt?.toISOString()).toBe(windows[0].window_end);
      const [run] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, id))
        .limit(1);
      expect(run.status).toBe("completed");
      const late = await fetch(`${base}/report-status`, {
        method: "POST",
        headers: reportHeaders(id, reportId),
        body: JSON.stringify({ schema_version: 1, outcome: "FATAL" }),
      });
      expect(late.status).toBe(200);
      const [unchanged] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, id))
        .limit(1);
      expect(unchanged.status).toBe("completed");
    });
    it("un run estraneo non può essere associato al report o avanzare il checkpoint", async () => {
      const response = await fetch(`${base}/report-created`, {
        method: "POST",
        headers: reportHeaders(randomUUID(), "wrong-report"),
        body: JSON.stringify({ schema_version: 1, outcome: "REPORT_CREATED" }),
      });
      expect(response.status).toBe(409);
    });
    it("persiste i motivi 409 dopo rollback e recupera il report pending senza chiusure manuali", async () => {
      const window = await (
        await fetch(`${base}/import-window`, { headers: auth })
      ).json();
      const id = window.run_id as string;
      const reportId = "213175020763";
      expect(
        (
          await fetch(`${base}/report-created`, {
            method: "POST",
            headers: reportHeaders(id, reportId),
            body: JSON.stringify({
              schema_version: 1,
              outcome: "REPORT_CREATED",
            }),
          })
        ).status
      ).toBe(200);
      const upload = (
        body: Buffer | string,
        extra: Record<string, string> = {}
      ) =>
        fetch(`${base}/report-file`, {
          method: "POST",
          body: Buffer.isBuffer(body) ? Uint8Array.from(body).buffer : body,
          headers: {
            ...reportHeaders(id, reportId),
            "Content-Type": "text/plain",
            "X-Amazon-Report-Document-Id": "doc-local",
            "X-Amazon-Processing-Status": "DONE",
            ...extra,
          },
        });
      const mismatch = await upload("invalid bytes", {
        "X-Amazon-Report-Id": "different-report",
      });
      expect(mismatch.status).toBe(409);
      const mismatchBody = await mismatch.json();
      expect(mismatchBody).toMatchObject({
        errorCode: "REPORT_ID_MISMATCH",
        phase: "execution",
        diagnosticPersisted: true,
        checks: { reportIdMatches: false },
      });
      let [run] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, id))
        .limit(1);
      expect(run).toMatchObject({
        status: "pending",
        reportId,
        reportDocumentId: null,
        documentSha256: null,
        error: "REPORT_ID_MISMATCH",
      });
      expect(run.summary).toMatchObject({
        lastDiagnostic: {
          code: "REPORT_ID_MISMATCH",
          requestId: mismatchBody.requestId,
        },
      });
      const marker =
        "private-buyer@example.test https://private.invalid/?token=never-persist-this";
      const malformed = await upload(marker);
      expect(malformed.status).toBe(409);
      const malformedBody = await malformed.json();
      expect(malformedBody).toMatchObject({
        errorCode: "DOCUMENT_HEADER_MISSING",
        phase: "document",
        diagnosticPersisted: true,
        details: { missingHeader: "purchase-date" },
        checks: { reportIdMatches: true },
      });
      [run] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, id))
        .limit(1);
      expect(run.status).toBe("pending");
      expect(run.documentSha256).toBeNull();
      expect(JSON.stringify(run.summary)).not.toContain(marker);
      expect(JSON.stringify(malformedBody)).not.toContain(marker);
      await db
        .update(amazonImportConfigs)
        .set({ enabled: false })
        .where(eq(amazonImportConfigs.storeId, storeId));
      const disabled = await upload("test");
      expect((await disabled.json()).errorCode).toBe("STORE_DISABLED");
      [run] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, id))
        .limit(1);
      expect(run.error).toBe("STORE_DISABLED");
      expect(run.status).toBe("pending");
      await db
        .update(amazonImportConfigs)
        .set({ enabled: true })
        .where(eq(amazonImportConfigs.storeId, storeId));
      const recovered = await (
        await fetch(`${base}/import-window`, { headers: auth })
      ).json();
      expect(recovered).toMatchObject({ run_id: id, report_id: reportId });
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
      ];
      const correct = `${columns.join("\t")}\n`;
      const uploads = await Promise.all([upload(correct), upload(correct)]);
      expect(uploads.map(result => result.status)).toEqual([200, 200]);
      [run] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, id))
        .limit(1);
      expect(run.status).toBe("completed");
      expect(run.error).toBeNull();
      expect(run.summary).toMatchObject({
        completed: true,
        lastDiagnostic: { code: "STORE_DISABLED" },
      });
      const config = (
        await db
          .select()
          .from(amazonImportConfigs)
          .where(eq(amazonImportConfigs.storeId, storeId))
          .limit(1)
      )[0];
      expect(config.checkpointAt?.toISOString()).toBe(window.window_end);
      const replay = await upload(correct.replace("\n", "\r\n"));
      expect((await replay.json()).errorCode).toBe("DOCUMENT_REPLAY_MISMATCH");
      [run] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, id))
        .limit(1);
      expect(run.status).toBe("completed");
      expect(run.error).toBeNull();
      expect(run.summary).toMatchObject({
        lastDiagnostic: { code: "DOCUMENT_REPLAY_MISMATCH" },
      });
    });
    it("rifiuta lo stato terminale e non scrive diagnostica sul run di un altro store", async () => {
      const [terminal] = await db
        .insert(amazonImportRuns)
        .values({
          storeId,
          reportId: "terminal-local",
          windowStart: new Date("2026-10-01T00:00:00Z"),
          windowEnd: new Date("2026-10-02T00:00:00Z"),
          status: "fatal",
        })
        .returning();
      const headers = {
        ...reportHeaders(terminal.id, "terminal-local"),
        "Content-Type": "text/plain",
        "X-Amazon-Report-Document-Id": "doc-local",
        "X-Amazon-Processing-Status": "DONE",
      };
      const response = await fetch(`${base}/report-file`, {
        method: "POST",
        headers,
        body: "test",
      });
      expect((await response.json()).errorCode).toBe("EXECUTION_STATE");
      const [unchanged] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, terminal.id))
        .limit(1);
      expect(unchanged.status).toBe("fatal");
      expect(unchanged.documentSha256).toBeNull();
      const otherStore = randomUUID();
      await db.insert(salesStores).values({
        id: otherStore,
        channel: "amazon",
        name: "Other local store",
        storeIdentifier: otherStore,
        companyId: EKETO_COMPANY_ID,
      });
      await db.insert(amazonImportConfigs).values({
        storeId: otherStore,
        sellerAccountId: `other-local-${otherStore}`,
      });
      const [foreign] = await db
        .insert(amazonImportRuns)
        .values({
          storeId: otherStore,
          windowStart: new Date("2026-10-01T00:00:00Z"),
          windowEnd: new Date("2026-10-02T00:00:00Z"),
        })
        .returning();
      const wrongStore = await fetch(`${base}/report-file`, {
        method: "POST",
        headers: { ...headers, "X-Amazon-Import-Run-Id": foreign.id },
        body: "test",
      });
      expect(await wrongStore.json()).toMatchObject({
        errorCode: "RUN_NOT_FOUND",
        diagnosticPersisted: false,
      });
      const [notTouched] = await db
        .select()
        .from(amazonImportRuns)
        .where(eq(amazonImportRuns.id, foreign.id))
        .limit(1);
      expect(notTouched.error).toBeNull();
      expect(notTouched.summary).toEqual({});
    });
  }
);
