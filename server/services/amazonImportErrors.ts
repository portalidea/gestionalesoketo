import { z } from "zod";

/** Never serialize exception.message/cause, request headers, report contents or SQL. */
export const AMAZON_IMPORT_ERRORS = {
  UNAUTHORIZED: "Accesso Amazon non autorizzato",
  SERVER_STORE_UNCONFIGURED: "Store Amazon non configurato sul server",
  RATE_LIMITED: "Troppe richieste Amazon",
  DATABASE_UNAVAILABLE: "Database Amazon non disponibile",
  DATABASE_CONSTRAINT: "Vincolo database Amazon non rispettato",
  INTERNAL_ERROR: "Errore interno Amazon: verificare il codice diagnostico",
  DIAGNOSTIC_PERSIST_FAILED: "Impossibile registrare la diagnostica Amazon",
  STORE_UNCONFIGURED: "Configurazione import Amazon assente",
  STORE_DISABLED: "Import Amazon disabilitato",
  STORE_SCOPE: "Store Amazon o azienda non ammessi",
  INVALID_CUTOFF: "Cutoff acquisto Amazon non valido",
  INVALID_INPUT: "Parametri Amazon non validi",
  RUN_ID_INVALID: "Identificativo esecuzione Amazon mancante o non valido",
  REPORT_ID_INVALID: "Identificativo report Amazon mancante o non valido",
  REPORT_TYPE_INVALID: "Tipo report Amazon non ammesso",
  DOCUMENT_ID_INVALID: "Identificativo documento Amazon mancante o non valido",
  REPORT_NOT_DONE: "Il report Amazon non risulta completo",
  RUN_NOT_FOUND: "Esecuzione Amazon non trovata nello store autorizzato",
  REPORT_ID_MISMATCH:
    "Il report ricevuto non corrisponde a quello associato all’esecuzione",
  EXECUTION_STATE: "Lo stato dell’esecuzione non consente questa operazione",
  DOCUMENT_REPLAY_MISMATCH:
    "Il documento ripetuto non corrisponde a quello già acquisito",
  DOCUMENT_BODY_INVALID:
    "Il documento Amazon deve essere inviato come byte originali",
  DOCUMENT_EMPTY: "Il documento Amazon ricevuto è vuoto",
  DOCUMENT_TOO_LARGE: "Il documento Amazon supera il limite consentito",
  COMPRESSION_UNSUPPORTED: "Compressione del documento Amazon non supportata",
  COMPRESSION_MISMATCH:
    "La compressione dichiarata non corrisponde ai byte del documento Amazon",
  DOCUMENT_GZIP_INVALID: "Il documento GZIP Amazon non è valido",
  DOCUMENT_ENCODING: "Il documento Amazon non è UTF-8 valido",
  DOCUMENT_NUL: "Il documento Amazon contiene byte NUL",
  DOCUMENT_HEADERS_INVALID: "Intestazioni Amazon mancanti o duplicate",
  DOCUMENT_HEADER_MISSING: "Intestazione obbligatoria Amazon mancante",
  DOCUMENT_ROW_INVALID: "Struttura di una riga Amazon non valida",
  DOCUMENT_ROWS_LIMIT: "Il report Amazon supera 2000 righe",
  DOCUMENT_TIMESTAMP_INVALID:
    "Timestamp Amazon non valido o privo di fuso esplicito",
  DOCUMENT_IDENTIFIER_INVALID: "Identificativo Amazon troppo lungo",
  DOCUMENT_PRICE_INVALID: "Importo Amazon non valido",
  STOCK_TRANSACTION_FAILED: "Transazione di scarico Amazon non completata",
} as const;
export type AmazonImportErrorCode = keyof typeof AMAZON_IMPORT_ERRORS;
export type AmazonImportPhase =
  | "authorization"
  | "store"
  | "metadata"
  | "execution"
  | "document"
  | "database"
  | "processing";
export interface AmazonDiagnosticDetails {
  missingHeader?: string;
  rowNumber?: number;
  bytes?: number;
  wireFormat?: "gzip" | "plain" | "empty";
  compression?: "GZIP" | "NONE";
  sqlState?: string;
}
const safeHeaders = new Set([
  "purchase-date",
  "last-updated-date",
  "order-status",
  "item-status",
  "fulfillment-channel",
  "sku",
  "quantity",
  "currency",
  "item-price",
]);
export function safeAmazonDetails(
  input: AmazonDiagnosticDetails = {}
): AmazonDiagnosticDetails {
  const result: AmazonDiagnosticDetails = {};
  if (input.missingHeader && safeHeaders.has(input.missingHeader))
    result.missingHeader = input.missingHeader;
  for (const key of ["rowNumber", "bytes"] as const) {
    const value = input[key];
    if (Number.isSafeInteger(value) && value! >= 0) result[key] = value;
  }
  if (["gzip", "plain", "empty"].includes(input.wireFormat ?? ""))
    result.wireFormat = input.wireFormat;
  if (["GZIP", "NONE"].includes(input.compression ?? ""))
    result.compression = input.compression;
  if (/^[A-Z0-9]{5}$/.test(input.sqlState ?? ""))
    result.sqlState = input.sqlState;
  return result;
}
export class AmazonImportError extends Error {
  readonly details: AmazonDiagnosticDetails;
  constructor(
    readonly code: AmazonImportErrorCode,
    details: AmazonDiagnosticDetails = {}
  ) {
    const safe = safeAmazonDetails(details);
    super(
      AMAZON_IMPORT_ERRORS[code] +
        (safe.missingHeader ? `: ${safe.missingHeader}` : "")
    );
    this.name = "AmazonImportError";
    this.details = safe;
  }
}
export function amazonImportError(error: unknown): AmazonImportError {
  if (
    error instanceof AmazonImportError &&
    Object.prototype.hasOwnProperty.call(AMAZON_IMPORT_ERRORS, error.code)
  )
    return new AmazonImportError(error.code, safeAmazonDetails(error.details));
  if (error instanceof z.ZodError)
    return new AmazonImportError("INVALID_INPUT");
  // Drizzle wraps PostgreSQL errors. Read only the SQLSTATE, never its text or query.
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const entry = current as {
      code?: unknown;
      cause?: unknown;
      type?: unknown;
      status?: unknown;
    };
    if (entry.type === "entity.parse.failed")
      return new AmazonImportError("INVALID_INPUT");
    if (entry.type === "entity.too.large")
      return new AmazonImportError("DOCUMENT_TOO_LARGE");
    if (
      entry.type === "request.aborted" ||
      entry.type === "encoding.unsupported"
    )
      return new AmazonImportError("DOCUMENT_BODY_INVALID");
    if (typeof entry.code === "string" && /^[A-Z0-9]{5}$/.test(entry.code)) {
      if (entry.code.startsWith("23"))
        return new AmazonImportError("DATABASE_CONSTRAINT", {
          sqlState: entry.code,
        });
      if (
        entry.code.startsWith("08") ||
        entry.code === "57P01" ||
        entry.code === "53300"
      )
        return new AmazonImportError("DATABASE_UNAVAILABLE", {
          sqlState: entry.code,
        });
    }
    current = entry.cause;
  }
  return new AmazonImportError("INTERNAL_ERROR");
}
