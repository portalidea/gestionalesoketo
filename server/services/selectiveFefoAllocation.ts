import { and, asc, eq, gt } from "drizzle-orm";
import { inventoryByBatch, locations, productBatches } from "../../drizzle/schema";
import { getDb } from "../db";

export type SelectiveFefoInputItem = {
  productId: string;
  quantity: number;
  piecesPerUnit?: number | null;
  productSku: string;
};

export type ExistingBatchAssignment = {
  productId: string;
  batchId: string | null;
  quantity: number;
};

export type BatchAllocation = {
  productId: string;
  batchId: string;
  quantity: number;
  batchNumber: string;
  expirationDate: string;
};

export type SelectiveFefoAllocationResult = {
  allocationsByProduct: Map<string, BatchAllocation[]>;
  warnings: string[];
};

/**
 * Costruisce l'allocazione lotti per un ordine pending.
 *
 * Le assegnazioni precedenti restano tali quando il batch è ancora presente
 * nel centrale della company e la sua giacenza copre la quantità preservata.
 * Per ogni differenza (nuova riga, incremento o batch non più disponibile)
 * viene applicato FEFO sul solo magazzino centrale della company indicata.
 */
export async function allocateBatchesSelectively({
  companyId,
  items,
  existingAssignments,
}: {
  companyId: string;
  items: SelectiveFefoInputItem[];
  existingAssignments: ExistingBatchAssignment[];
}): Promise<SelectiveFefoAllocationResult> {
  const db = await getDb();
  if (!db) throw new Error("DB non disponibile durante l'allocazione FEFO.");

  const [warehouse] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.type, "central_warehouse"), eq(locations.companyId, companyId)))
    .limit(1);

  const allocationsByProduct = new Map<string, BatchAllocation[]>();
  const warnings: string[] = [];

  for (const item of items) {
    const allocations: BatchAllocation[] = [];
    const piecesPerUnit = item.piecesPerUnit ?? 1;
    let remaining = item.quantity;
    let reassignedUnavailableBatch = false;

    if (warehouse) {
      const availableBatches = await db
        .select({
          batchId: productBatches.id,
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
          centralStock: inventoryByBatch.quantity,
        })
        .from(productBatches)
        .innerJoin(
          inventoryByBatch,
          and(
            eq(inventoryByBatch.batchId, productBatches.id),
            eq(inventoryByBatch.locationId, warehouse.id),
          ),
        )
        .where(
          and(
            eq(productBatches.productId, item.productId),
            eq(productBatches.companyId, companyId),
            gt(inventoryByBatch.quantity, 0),
          ),
        )
        .orderBy(asc(productBatches.expirationDate));

      const remainingByBatch = new Map(
        availableBatches.map((batch) => [batch.batchId, Math.floor(batch.centralStock / piecesPerUnit)]),
      );
      const batchById = new Map(availableBatches.map((batch) => [batch.batchId, batch]));

      // Quando la quantità diminuisce, preserva prima le righe con scadenza più prossima.
      const priorAssignments = existingAssignments
        .filter((assignment) => assignment.productId === item.productId && assignment.batchId !== null)
        .sort((left, right) => {
          const leftExpiry = batchById.get(left.batchId!)?.expirationDate ?? "9999-12-31";
          const rightExpiry = batchById.get(right.batchId!)?.expirationDate ?? "9999-12-31";
          return leftExpiry.localeCompare(rightExpiry);
        });

      for (const assignment of priorAssignments) {
        if (remaining <= 0) break;
        const batchId = assignment.batchId!;
        const availableUnits = remainingByBatch.get(batchId) ?? 0;
        const batch = batchById.get(batchId);
        if (!batch || availableUnits <= 0) {
          reassignedUnavailableBatch = true;
          continue;
        }

        const preservedTarget = Math.min(assignment.quantity, remaining);
        const quantity = Math.min(preservedTarget, availableUnits);
        if (quantity <= 0) continue;
        allocations.push({
          productId: item.productId,
          batchId,
          quantity,
          batchNumber: batch.batchNumber,
          expirationDate: batch.expirationDate,
        });
        remaining -= quantity;
        remainingByBatch.set(batchId, availableUnits - quantity);
        if (quantity < preservedTarget) {
          reassignedUnavailableBatch = true;
        }
      }

      // La parte non preservabile viene assegnata FEFO, evitando quantità già riservate sopra.
      for (const batch of availableBatches) {
        if (remaining <= 0) break;
        const availableUnits = remainingByBatch.get(batch.batchId) ?? 0;
        if (availableUnits <= 0) continue;
        const quantity = Math.min(remaining, availableUnits);
        allocations.push({
          productId: item.productId,
          batchId: batch.batchId,
          quantity,
          batchNumber: batch.batchNumber,
          expirationDate: batch.expirationDate,
        });
        remaining -= quantity;
        remainingByBatch.set(batch.batchId, availableUnits - quantity);
      }
    }

    if (reassignedUnavailableBatch) {
      warnings.push(
        `${item.productSku}: lotto precedentemente assegnato non più disponibile — riallocato FEFO dove possibile`,
      );
    }

    const allocationsByBatch = new Map<string, BatchAllocation>();
    for (const allocation of allocations) {
      const existing = allocationsByBatch.get(allocation.batchId);
      if (existing) {
        existing.quantity += allocation.quantity;
      } else {
        allocationsByBatch.set(allocation.batchId, { ...allocation });
      }
    }
    const consolidatedAllocations = Array.from(allocationsByBatch.values()).sort((left, right) =>
      left.expirationDate.localeCompare(right.expirationDate),
    );

    if (remaining > 0) {
      warnings.push(
        `${item.productSku}: stock insufficiente per ${remaining} conf. su ${item.quantity} richieste — ${remaining} senza lotto`,
      );
    }

    allocationsByProduct.set(item.productId, consolidatedAllocations);
  }

  return { allocationsByProduct, warnings };
}
