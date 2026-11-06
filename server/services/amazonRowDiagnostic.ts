import {
  safeAmazonDetails,
  type AmazonImportErrorCode,
} from "./amazonImportErrors";

const ROW_CODES = new Set<AmazonImportErrorCode>([
  "DOCUMENT_ROW_INVALID",
  "DOCUMENT_TIMESTAMP_INVALID",
  "DOCUMENT_IDENTIFIER_INVALID",
  "DOCUMENT_PRICE_INVALID",
]);
export interface SafeAmazonRowDiagnostic {
  code: AmazonImportErrorCode;
  rowNumber: number;
  expectedColumns?: number;
  actualColumns?: number;
  field?: string;
}

/** Never copy raw cells, unknown fields or exception messages into a diagnostic. */
export function safeAmazonRowDiagnostic(
  value: unknown
): SafeAmazonRowDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.code !== "string" ||
    !ROW_CODES.has(input.code as AmazonImportErrorCode)
  )
    return null;
  const safe = safeAmazonDetails({
    rowNumber:
      typeof input.rowNumber === "number" ? input.rowNumber : undefined,
    expectedColumns:
      typeof input.expectedColumns === "number"
        ? input.expectedColumns
        : undefined,
    actualColumns:
      typeof input.actualColumns === "number" ? input.actualColumns : undefined,
    field: typeof input.field === "string" ? input.field : undefined,
  });
  if (safe.rowNumber === undefined || safe.rowNumber < 2) return null;
  return {
    code: input.code as AmazonImportErrorCode,
    rowNumber: safe.rowNumber,
    ...(safe.expectedColumns !== undefined
      ? { expectedColumns: safe.expectedColumns }
      : {}),
    ...(safe.actualColumns !== undefined
      ? { actualColumns: safe.actualColumns }
      : {}),
    ...(safe.field !== undefined ? { field: safe.field } : {}),
  };
}
