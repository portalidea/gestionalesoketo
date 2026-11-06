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
      await db
        .insert(salesStores)
        .values({
          id: storeId,
          channel: "amazon",
          name: "HTTP test Amazon",
          storeIdentifier: storeId,
          companyId: EKETO_COMPANY_ID,
        });
      await db
        .insert(amazonImportConfigs)
        .values({
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
  }
);
