import express from "express";
import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
const mocks = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("./services/amazonReportDocumentService", () => ({
  processAmazonReportBatch: mocks.process,
}));
import {
  amazonProcessingCron,
  validAmazonCronAuthorization,
} from "./amazon-processing-cron";
const key = "local-cron-key-not-production-0123456789";
const storeId = "11111111-1111-4111-8111-111111111111";
const originalSecret = process.env.CRON_SECRET;
const originalStore = process.env.AMAZON_IMPORT_STORE_ID;
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use("/api/cron", amazonProcessingCron);
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("Local server failed");
  base = `http://127.0.0.1:${a.port}/api/cron/amazon-processing`;
});
beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = key;
  process.env.AMAZON_IMPORT_STORE_ID = storeId;
  mocks.process.mockResolvedValue({ completed: true, hasMore: false });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(e => (e ? reject(e) : resolve()))
  );
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalStore === undefined) delete process.env.AMAZON_IMPORT_STORE_ID;
  else process.env.AMAZON_IMPORT_STORE_ID = originalStore;
});
describe("cron Amazon: recupero durevole e autenticato", () => {
  it("rifiuta secret assente, corto o confronto sbagliato", () => {
    expect(validAmazonCronAuthorization(`Bearer ${key}`, key)).toBe(true);
    expect(validAmazonCronAuthorization(`Bearer ${key} `, key)).toBe(false);
    expect(validAmazonCronAuthorization(undefined, key)).toBe(false);
    expect(validAmazonCronAuthorization("Bearer short", "short")).toBe(false);
  });
  it("senza autorizzazione non esegue lotti", async () => {
    expect((await fetch(base)).status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("senza UUID server valido non esegue lotti", async () => {
    process.env.AMAZON_IMPORT_STORE_ID = "invalid";
    expect(
      (await fetch(base, { headers: { Authorization: `Bearer ${key}` } }))
        .status
    ).toBe(503);
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("esegue una sequenza limitata e si ferma quando non resta lavoro", async () => {
    mocks.process.mockResolvedValueOnce({ completed: false, hasMore: true });
    const response = await fetch(base, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).batches).toBe(2);
    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.process).toHaveBeenCalledWith(storeId, {
      rowLimit: 5,
      timeBudgetMs: 12000,
    });
  });
  it("limita anche una coda che segnala sempre altro lavoro", async () => {
    mocks.process.mockResolvedValue({ completed: false, hasMore: true });
    const response = await fetch(base, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect((await response.json()).batches).toBe(30);
    expect(mocks.process).toHaveBeenCalledTimes(30);
  });
  it("un errore resta sicuro e lascia il retry al prossimo passaggio", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.process.mockRejectedValue(
        new Error("private-token private-buyer@example.invalid")
      );
      const response = await fetch(base, {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        errorCode: "INTERNAL_ERROR",
        phase: "processing",
      });
      expect(JSON.stringify(spy.mock.calls)).not.toContain("private-token");
    } finally {
      spy.mockRestore();
    }
  });
});
