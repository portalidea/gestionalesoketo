export type DdtItemValidationInput = {
  productMatchedId: string | null;
  batchNumber: string | null;
  expirationDate: string | null;
  quantityPieces: number | null;
  notes: string | null;
};

const PARTIAL_EXTRACTION_PREFIX = "[ESTRAZIONE PARZIALE]";
const ISO_DATE = /^\d{4}-(\d{2})-(\d{2})$/;

export function isValidDdtExpirationDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(match[1]);
  const day = Number(match[2]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function deriveDdtItemValidation(item: DdtItemValidationInput) {
  const missingProduct = !item.productMatchedId;
  const missingBatch = !item.batchNumber?.trim();
  const invalidExpirationDate = !isValidDdtExpirationDate(item.expirationDate);
  const invalidQuantity = !Number.isInteger(item.quantityPieces) || (item.quantityPieces ?? 0) <= 0;
  const hasHistoricalPartialExtraction = item.notes?.startsWith(PARTIAL_EXTRACTION_PREFIX) ?? false;
  const isValid = !missingProduct && !missingBatch && !invalidExpirationDate && !invalidQuantity;

  return {
    isValid,
    missingProduct,
    missingBatch,
    invalidExpirationDate,
    invalidQuantity,
    hasHistoricalPartialExtraction,
    isHistoricallyCorrected: hasHistoricalPartialExtraction && isValid,
  };
}

export function summarizeDdtItemValidation(items: DdtItemValidationInput[]) {
  const validations = items.map(deriveDdtItemValidation);
  return {
    incompleteCount: validations.filter((item) => !item.isValid).length,
    missingProductCount: validations.filter((item) => item.missingProduct).length,
    missingBatchCount: validations.filter((item) => item.missingBatch).length,
    invalidExpirationDateCount: validations.filter((item) => item.invalidExpirationDate).length,
    invalidQuantityCount: validations.filter((item) => item.invalidQuantity).length,
    historicallyCorrectedCount: validations.filter((item) => item.isHistoricallyCorrected).length,
  };
}
