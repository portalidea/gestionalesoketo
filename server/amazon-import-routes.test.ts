import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Server } from "node:http";
import { EKETO_COMPANY_ID } from "../shared/const";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  ingest: vi.fn(),
  process: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: mocks.db }));
vi.mock("./services/amazonOrderImportService", () => ({
  ingestAmazonReport: mocks.ingest,
  processPendingAmazonItems: mocks.process,
}));
import amazonRoutes, { validAmazonWebhookKey } from "./amazon-import-routes";

const storeId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const secret = "amazon-local-only-secret-01234567890123456789";
const originalKey = process.env.AMAZON_IMPORT_WEBHOOK_KEY;
const originalStore = process.env.AMAZON_IMPORT_STORE_ID;
let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/marketplace/amazon", amazonRoutes);
  app.use(express.json());
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server test non avviato");
  url = `http://127.0.0.1:${address.port}/api/marketplace/amazon`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
  if (originalKey === undefined) delete process.env.AMAZON_IMPORT_WEBHOOK_KEY;
  else process.env.AMAZON_IMPORT_WEBHOOK_KEY = originalKey;
  if (originalStore === undefined) delete process.env.AMAZON_IMPORT_STORE_ID;
  else process.env.AMAZON_IMPORT_STORE_ID = originalStore;
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.AMAZON_IMPORT_WEBHOOK_KEY = secret;
  process.env.AMAZON_IMPORT_STORE_ID = storeId;
  mocks.ingest.mockResolvedValue({ accepted: 1 });
  mocks.process.mockResolvedValue({ processed: 0 });
  mocks.db.mockResolvedValue({
    select: () => ({
      from: () => ({
        innerJoin() {
          return this;
        },
        where() {
          return this;
        },
        limit: async () => [
          {
            config: { storeId, enabled: true },
            companyId: EKETO_COMPANY_ID,
            companyName: "E-Keto Food Srls",
            companyActive: true,
            storeActive: true,
            channel: "amazon",
          },
        ],
      }),
    }),
  });
});

describe("webhook Amazon fail-closed", () => {
  it("rifiuta configurazione assente o chiave corta", () => {
    expect(validAmazonWebhookKey(secret, "")).toBe(false);
    expect(validAmazonWebhookKey("short", "short")).toBe(false);
    expect(validAmazonWebhookKey(secret, secret)).toBe(true);
    expect(validAmazonWebhookKey("wrong", secret)).toBe(false);
  });
  it.each([undefined, "wrong"])(
    "senza chiave valida non legge DB e non importa",
    async key => {
      const response = await fetch(`${url}/report-file`, {
        method: "POST",
        headers: key ? { "X-SoKeto-Amazon-Key": key } : {},
        body: "not parsed",
      });
      expect(response.status).toBe(401);
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.ingest).not.toHaveBeenCalled();
    }
  );
  it("senza store server-side non importa", async () => {
    delete process.env.AMAZON_IMPORT_STORE_ID;
    const response = await fetch(`${url}/report-file`, {
      method: "POST",
      headers: { "X-SoKeto-Amazon-Key": secret },
      body: "test",
    });
    expect(response.status).toBe(503);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("il nome della company non sostituisce il suo identificativo E-Keto", async () => {
    mocks.db.mockResolvedValue({
      select: () => ({
        from: () => ({
          innerJoin() {
            return this;
          },
          where() {
            return this;
          },
          limit: async () => [
            {
              config: { storeId, enabled: true },
              companyId: "44444444-4444-4444-8444-444444444444",
              companyName: "E-Keto altra company",
              companyActive: true,
              storeActive: true,
              channel: "amazon",
            },
          ],
        }),
      }),
    });
    const response = await fetch(`${url}/import-window`, {
      headers: { "X-SoKeto-Amazon-Key": secret },
    });
    expect(response.status).toBe(409);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("preserva byte raw e non accetta store/company dal browser", async () => {
    const body = Buffer.from("amazon-order-id\torder-item-id\nORDER\tITEM\n");
    const response = await fetch(`${url}/report-file`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "text/plain",
        "X-SoKeto-Amazon-Key": secret,
        "X-Amazon-Import-Run-Id": runId,
        "X-Amazon-Report-Id": "report-1",
        "X-Amazon-Report-Type":
          "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL",
        "X-Amazon-Report-Document-Id": "document-1",
        "X-Amazon-Processing-Status": "DONE",
        "X-Company-Id": "untrusted-company",
        "X-Store-Id": "untrusted-store",
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ storeId, runId, body, compression: "NONE" })
    );
    expect(Buffer.isBuffer(mocks.ingest.mock.calls[0][0].body)).toBe(true);
  });
  it("non importa un report non DONE", async () => {
    const response = await fetch(`${url}/report-file`, {
      method: "POST",
      body: "test",
      headers: {
        "X-SoKeto-Amazon-Key": secret,
        "X-Amazon-Import-Run-Id": runId,
        "X-Amazon-Report-Id": "report-1",
        "X-Amazon-Report-Type":
          "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL",
        "X-Amazon-Report-Document-Id": "document-1",
        "X-Amazon-Processing-Status": "IN_PROGRESS",
      },
    });
    expect(response.status).toBe(409);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
