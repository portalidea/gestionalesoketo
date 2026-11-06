import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Server } from "node:http";
import { EKETO_COMPANY_ID } from "../shared/const";
import {
  AMAZON_IMPORT_ERRORS,
  AmazonImportError,
  type AmazonImportErrorCode,
  type AmazonImportPhase,
} from "./services/amazonImportErrors";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  select: vi.fn(),
  ingest: vi.fn(),
  process: vi.fn(),
  persist: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: mocks.db }));
vi.mock("./services/amazonReportDocumentService", () => ({
  acquireAmazonReportDocument: mocks.ingest,
  processAmazonReportBatch: mocks.process,
}));
vi.mock("./services/amazonImportDiagnosticService", () => ({
  persistAmazonImportDiagnostic: mocks.persist,
}));
import amazonRoutes, { validAmazonWebhookKey } from "./amazon-import-routes";

const storeId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const secret = "amazon-local-only-secret-01234567890123456789";
const reportType = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL";
const sensitiveValues = [
  secret,
  "TEST-ACCESS-TOKEN-DO-NOT-LOG",
  "https://sensitive.invalid/report?signature=DO-NOT-LOG",
  "private-buyer@example.invalid",
];
const maliciousPayload = `token=${sensitiveValues[1]} url=${sensitiveValues[2]} buyerEmail=${sensitiveValues[3]} key=${secret}`;
const originalKey = process.env.AMAZON_IMPORT_WEBHOOK_KEY;
const originalStore = process.env.AMAZON_IMPORT_STORE_ID;
let server: Server;
let url: string;
let consoleError: ReturnType<typeof vi.spyOn>;
let configRecord: {
  config: { storeId: string; enabled: boolean };
  companyId: string;
  companyName: string;
  companyActive: boolean;
  storeActive: boolean;
  channel: string;
};
let runRecord:
  | {
      reportId: string | null;
      reportDocumentId: string | null;
      status: string;
      digest: string | null;
    }
  | undefined;

function reportHeaders(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    "Content-Type": "text/plain",
    "X-SoKeto-Amazon-Key": secret,
    "X-Amazon-Import-Run-Id": runId,
    "X-Amazon-Report-Id": "report-1",
    "X-Amazon-Report-Type": reportType,
    "X-Amazon-Report-Document-Id": "document-1",
    "X-Amazon-Processing-Status": "DONE",
    ...overrides,
  };
}
function postReport(
  body:
    | string
    | Buffer
    | undefined = "amazon-order-id\torder-item-id\nORDER\tITEM\n",
  headers: Record<string, string> = {}
) {
  return fetch(`${url}/report-file`, {
    method: "POST",
    body: Buffer.isBuffer(body) ? Uint8Array.from(body).buffer : body,
    headers: reportHeaders(headers),
  });
}
function expectNoSensitiveData(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const sensitive of sensitiveValues)
    expect(serialized).not.toContain(sensitive);
  for (const field of ["buyerEmail", "token=", "url=", "key="])
    expect(serialized).not.toContain(field);
}
async function expectSafeFailure(
  response: Response,
  code: AmazonImportErrorCode,
  phase: AmazonImportPhase,
  status = 409,
  diagnosticPersisted = true
) {
  expect(response.status).toBe(status);
  const data = await response.json();
  expect(data).toMatchObject({
    error: AMAZON_IMPORT_ERRORS[code],
    errorCode: code,
    phase,
    diagnosticPersisted,
  });
  expect(data.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  expect(consoleError).toHaveBeenCalledWith(
    "[AMAZON_IMPORT]",
    expect.objectContaining({
      errorCode: code,
      phase,
      requestId: data.requestId,
      details: data.details,
      checks: data.checks,
      diagnosticPersisted,
    })
  );
  expectNoSensitiveData(data);
  expectNoSensitiveData(consoleError.mock.calls);
  expectNoSensitiveData(mocks.persist.mock.calls);
  if (diagnosticPersisted) {
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledWith({
      storeId,
      runId,
      diagnostic: {
        requestId: data.requestId,
        code,
        phase,
        at: expect.any(String),
        details: data.details,
        checks: data.checks,
      },
    });
    expect(
      Number.isNaN(Date.parse(mocks.persist.mock.calls[0][0].diagnostic.at))
    ).toBe(false);
  }
  return data;
}

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
  vi.resetAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.AMAZON_IMPORT_WEBHOOK_KEY = secret;
  process.env.AMAZON_IMPORT_STORE_ID = storeId;
  mocks.ingest.mockResolvedValue({
    completed: false,
    alreadyAcquired: false,
    totalRows: 1,
    ingestedRows: 0,
  });
  mocks.process.mockResolvedValue({
    completed: false,
    hasMore: true,
    ingestedRows: 5,
  });
  mocks.persist.mockResolvedValue(true);
  configRecord = {
    config: { storeId, enabled: true },
    companyId: EKETO_COMPANY_ID,
    companyName: "E-Keto Food Srls",
    companyActive: true,
    storeActive: true,
    channel: "amazon",
  };
  runRecord = {
    reportId: "report-1",
    reportDocumentId: "document-1",
    status: "pending",
    digest: null,
  };
  mocks.select.mockImplementation((projection: Record<string, unknown>) => {
    // The scope projection and the pre-parse run projection have different rows.
    const isRun = "reportId" in projection;
    const query = {
      innerJoin() {
        return this;
      },
      where() {
        return this;
      },
      limit: vi.fn(async () =>
        isRun ? (runRecord ? [runRecord] : []) : [configRecord]
      ),
    };
    return { from: vi.fn(() => query) };
  });
  mocks.db.mockResolvedValue({ select: mocks.select });
});
afterEach(() => {
  consoleError.mockRestore();
});

describe("webhook Amazon fail-closed", () => {
  it("rifiuta configurazione assente o chiave corta", () => {
    expect(validAmazonWebhookKey(secret, "")).toBe(false);
    expect(validAmazonWebhookKey("short", "short")).toBe(false);
    expect(validAmazonWebhookKey(secret, secret)).toBe(true);
    expect(validAmazonWebhookKey("wrong", secret)).toBe(false);
  });
  it.each([undefined, "wrong"])(
    "senza chiave valida non legge DB e non registra diagnostica",
    async key => {
      const headers = reportHeaders();
      if (key === undefined) delete headers["X-SoKeto-Amazon-Key"];
      else headers["X-SoKeto-Amazon-Key"] = key;
      const response = await fetch(`${url}/report-file`, {
        method: "POST",
        headers,
        body: maliciousPayload,
      });
      const data = await expectSafeFailure(
        response,
        "UNAUTHORIZED",
        "authorization",
        401,
        false
      );
      expect(data.checks).toEqual({
        reportIdPresent: true,
        documentIdPresent: true,
      });
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.ingest).not.toHaveBeenCalled();
      expect(mocks.process).not.toHaveBeenCalled();
    }
  );
  it("senza store server-side non importa e non registra diagnostica", async () => {
    delete process.env.AMAZON_IMPORT_STORE_ID;
    await expectSafeFailure(
      await postReport(),
      "SERVER_STORE_UNCONFIGURED",
      "authorization",
      503,
      false
    );
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("il nome della company non sostituisce il suo identificativo E-Keto", async () => {
    configRecord.companyId = "44444444-4444-4444-8444-444444444444";
    configRecord.companyName = "E-Keto altra company";
    const response = await fetch(`${url}/import-window`, {
      headers: { "X-SoKeto-Amazon-Key": secret },
    });
    await expectSafeFailure(response, "STORE_SCOPE", "store", 409, false);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("preserva byte raw e non accetta store/company dal browser", async () => {
    const body = Buffer.from("amazon-order-id\torder-item-id\nORDER\tITEM\n");
    const response = await postReport(body, {
      "X-Company-Id": "untrusted-company",
      "X-Store-Id": "untrusted-store",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      durable: true,
      result: {
        completed: false,
        alreadyAcquired: false,
        totalRows: 1,
        ingestedRows: 0,
      },
      processing_pending: true,
    });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith({
      storeId,
      runId,
      reportId: "report-1",
      reportDocumentId: "document-1",
      body,
      compression: "NONE",
    });
    expect(Buffer.isBuffer(mocks.ingest.mock.calls[0][0].body)).toBe(true);
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(mocks.select.mock.calls[1][0]).toEqual({
      reportId: expect.anything(),
      reportDocumentId: expect.anything(),
      status: expect.anything(),
      digest: expect.anything(),
    });
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
  it("un documento completo già acquisito risponde 200 senza worker", async () => {
    mocks.ingest.mockResolvedValueOnce({
      completed: true,
      alreadyAcquired: true,
    });
    const response = await postReport();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processing_pending: false });
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("solo process-batch chiama il worker con quantità e budget server-side", async () => {
    const response = await fetch(`${url}/process-batch`, {
      method: "POST",
      headers: {
        "X-SoKeto-Amazon-Key": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schema_version: 1 }),
    });
    expect(response.status).toBe(200);
    expect(mocks.process).toHaveBeenCalledWith(storeId, {
      rowLimit: 5,
      timeBudgetMs: 12000,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("process-batch non accetta store, budget o quantità arbitrari", async () => {
    const response = await fetch(`${url}/process-batch`, {
      method: "POST",
      headers: {
        "X-SoKeto-Amazon-Key": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schema_version: 1, storeId, rowLimit: 100000 }),
    });
    expect((await response.json()).errorCode).toBe("INVALID_INPUT");
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("non importa un report non DONE", async () => {
    const data = await expectSafeFailure(
      await postReport(maliciousPayload, {
        "X-Amazon-Processing-Status": "IN_PROGRESS",
      }),
      "REPORT_NOT_DONE",
      "metadata"
    );
    expect(data.checks).toEqual({
      reportIdPresent: true,
      documentIdPresent: true,
    });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("uno status arbitrario non viene riflesso nella risposta o nei log", async () => {
    await expectSafeFailure(
      await postReport(maliciousPayload, {
        "X-Amazon-Processing-Status": maliciousPayload,
      }),
      "REPORT_NOT_DONE",
      "metadata"
    );
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("rifiuta REPORT_ID_MISMATCH prima del parsing e dell'ingest", async () => {
    runRecord!.reportId = "expected-report-1";
    const data = await expectSafeFailure(
      await postReport(maliciousPayload),
      "REPORT_ID_MISMATCH",
      "execution"
    );
    expect(data.checks).toEqual({
      reportIdPresent: true,
      documentIdPresent: true,
      runFound: true,
      reportIdMatches: false,
      documentIdMatches: true,
    });
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
    expect(
      JSON.stringify([data, consoleError.mock.calls, mocks.persist.mock.calls])
    ).not.toContain("expected-report-1");
  });
  it("rifiuta uno stato terminale senza digest prima dell'ingest", async () => {
    runRecord!.status = "completed";
    runRecord!.digest = null;
    const data = await expectSafeFailure(
      await postReport(maliciousPayload),
      "EXECUTION_STATE",
      "execution"
    );
    expect(data.checks).toMatchObject({
      runFound: true,
      reportIdMatches: true,
      documentIdMatches: true,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("rifiuta lo store disabilitato prima di leggere il run", async () => {
    configRecord.config.enabled = false;
    await expectSafeFailure(await postReport(), "STORE_DISABLED", "store");
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("un run inesistente restituisce solo il check runFound false", async () => {
    runRecord = undefined;
    const data = await expectSafeFailure(
      await postReport(),
      "RUN_NOT_FOUND",
      "execution"
    );
    expect(data.checks).toEqual({
      reportIdPresent: true,
      documentIdPresent: true,
      runFound: false,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("un documento diverso non può ripetere un run già associato", async () => {
    runRecord!.reportDocumentId = "expected-document-1";
    const data = await expectSafeFailure(
      await postReport(),
      "DOCUMENT_REPLAY_MISMATCH",
      "execution"
    );
    expect(data.checks).toMatchObject({
      runFound: true,
      reportIdMatches: true,
      documentIdMatches: false,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("un corpo vuoto raggiunge il parser come Buffer e restituisce DOCUMENT_EMPTY", async () => {
    mocks.ingest.mockRejectedValueOnce(new AmazonImportError("DOCUMENT_EMPTY"));
    const response = await fetch(`${url}/report-file`, {
      method: "POST",
      headers: reportHeaders(),
    });
    const data = await expectSafeFailure(
      response,
      "DOCUMENT_EMPTY",
      "document"
    );
    expect(data.checks).toMatchObject({
      runFound: true,
      reportIdMatches: true,
      documentIdMatches: true,
    });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest.mock.calls[0][0].body).toEqual(Buffer.alloc(0));
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("un content encoding non supportato restituisce DOCUMENT_BODY_INVALID", async () => {
    await expectSafeFailure(
      await postReport(maliciousPayload, {
        "Content-Encoding": "not-supported",
      }),
      "DOCUMENT_BODY_INVALID",
      "document",
      400
    );
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("un run ID non UUID restituisce 400 senza registrare diagnostica", async () => {
    await expectSafeFailure(
      await postReport(maliciousPayload, {
        "X-Amazon-Import-Run-Id": maliciousPayload,
      }),
      "RUN_ID_INVALID",
      "metadata",
      400,
      false
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it.each([
    ["X-Amazon-Report-Type", "REPORT_TYPE_INVALID"],
    ["X-Amazon-Report-Id", "REPORT_ID_INVALID"],
    ["X-Amazon-Report-Document-Id", "DOCUMENT_ID_INVALID"],
  ] as const)(
    "metadato non valido %s restituisce 400",
    async (header, code) => {
      await expectSafeFailure(
        await postReport(maliciousPayload, { [header]: "" }),
        code,
        "metadata",
        400
      );
      expect(mocks.ingest).not.toHaveBeenCalled();
    }
  );
  it("JSON corrotto su report-status restituisce INVALID_INPUT senza il corpo", async () => {
    const response = await fetch(`${url}/report-status`, {
      method: "POST",
      headers: reportHeaders({ "Content-Type": "application/json" }),
      body: `{"outcome": ${JSON.stringify(maliciousPayload)}`,
    });
    await expectSafeFailure(response, "INVALID_INPUT", "metadata", 400);
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("un errore sconosciuto con message e cause sensibili non li espone", async () => {
    mocks.ingest.mockRejectedValueOnce(
      new Error(maliciousPayload, {
        cause: new Error(maliciousPayload),
      })
    );
    const data = await expectSafeFailure(
      await postReport(maliciousPayload),
      "INTERNAL_ERROR",
      "document"
    );
    expect(data.details).toEqual({});
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("un errore parser tipizzato espone solo il codice e dettagli allowlisted", async () => {
    const error = new AmazonImportError("COMPRESSION_MISMATCH", {
      bytes: 42,
      compression: "GZIP",
      wireFormat: "plain",
      missingHeader: maliciousPayload,
    });
    Object.assign(error, {
      message: maliciousPayload,
      cause: new Error(maliciousPayload),
    });
    mocks.ingest.mockRejectedValueOnce(error);
    const data = await expectSafeFailure(
      await postReport(maliciousPayload, {
        "X-Amazon-Compression-Algorithm": "GZIP",
      }),
      "COMPRESSION_MISMATCH",
      "document"
    );
    expect(data.details).toEqual({
      bytes: 42,
      compression: "GZIP",
      wireFormat: "plain",
    });
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("un vincolo DB in una cause Drizzle espone solo SQLSTATE 23505", async () => {
    mocks.ingest.mockRejectedValueOnce(
      new Error(maliciousPayload, {
        cause: Object.assign(new Error(maliciousPayload), {
          code: "23505",
          query: maliciousPayload,
          detail: maliciousPayload,
        }),
      })
    );
    const data = await expectSafeFailure(
      await postReport(maliciousPayload),
      "DATABASE_CONSTRAINT",
      "database"
    );
    expect(data.details).toEqual({ sqlState: "23505" });
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("il fallimento di persistenza non maschera l'errore originale e non logga il messaggio", async () => {
    mocks.ingest.mockRejectedValueOnce(
      new AmazonImportError("DOCUMENT_ENCODING")
    );
    mocks.persist.mockRejectedValueOnce(
      new Error(maliciousPayload, {
        cause: new Error(maliciousPayload),
      })
    );
    const data = await expectSafeFailure(
      await postReport(maliciousPayload),
      "DOCUMENT_ENCODING",
      "document",
      409,
      false
    );
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId,
        runId,
        diagnostic: expect.objectContaining({
          code: "DOCUMENT_ENCODING",
          phase: "document",
        }),
      })
    );
    expect(consoleError.mock.calls).toEqual([
      [
        "[AMAZON_IMPORT]",
        {
          errorCode: "DIAGNOSTIC_PERSIST_FAILED",
          phase: "database",
          requestId: data.requestId,
        },
      ],
      [
        "[AMAZON_IMPORT]",
        {
          errorCode: "DOCUMENT_ENCODING",
          phase: "document",
          requestId: data.requestId,
          details: {},
          checks: data.checks,
          diagnosticPersisted: false,
        },
      ],
    ]);
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("una persistenza senza record corrispondente dichiara diagnosticPersisted false", async () => {
    mocks.persist.mockResolvedValueOnce(false);
    await expectSafeFailure(
      await postReport("test", { "X-Amazon-Processing-Status": "IN_PROGRESS" }),
      "REPORT_NOT_DONE",
      "metadata",
      409,
      false
    );
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("il body-parser rifiuta 4 MiB + 1 byte con codice sicuro 413 prima di DB e ingest", async () => {
    const body = Buffer.alloc(4 * 1024 * 1024 + 1, "x");
    body.write(maliciousPayload);
    const data = await expectSafeFailure(
      await postReport(body),
      "DOCUMENT_TOO_LARGE",
      "document",
      413
    );
    expect(data.checks).toEqual({
      reportIdPresent: true,
      documentIdPresent: true,
    });
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });
});
