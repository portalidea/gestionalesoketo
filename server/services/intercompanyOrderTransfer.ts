import { and, eq, gt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { inventoryByBatch, locations, orderItems, orders, productBatches, products, stockMovements } from "../../drizzle/schema";
import { EKETO_COMPANY_ID, SOKETO_COMPANY_ID } from "../../shared/const";
import { getDb } from "../db";

const INTERCOMPANY_TRANSFER_SOURCE_TYPE = "intercompany_transfer";

type IntercompanyDirection = {
  sourceCompanyId: string;
  destinationCompanyId: string;
  sourceCompanyName: "SoKeto" | "E-Keto";
  destinationCompanyName: "SoKeto" | "E-Keto";
};

function getDirectionForDestination(destinationCompanyId: string): IntercompanyDirection | null {
  if (destinationCompanyId === EKETO_COMPANY_ID) {
    return {
      sourceCompanyId: SOKETO_COMPANY_ID,
      destinationCompanyId: EKETO_COMPANY_ID,
      sourceCompanyName: "SoKeto",
      destinationCompanyName: "E-Keto",
    };
  }
  if (destinationCompanyId === SOKETO_COMPANY_ID) {
    return {
      sourceCompanyId: EKETO_COMPANY_ID,
      destinationCompanyId: SOKETO_COMPANY_ID,
      sourceCompanyName: "E-Keto",
      destinationCompanyName: "SoKeto",
    };
  }
  return null;
}

async function getCentralWarehouse(tx: any, companyId: string) {
  const [warehouse] = await tx.select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), eq(locations.type, "central_warehouse")))
    .limit(1);
  if (!warehouse) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Magazzino centrale company non trovato" });
  return warehouse;
}

export async function getIntercompanySourceBatches(orderItemId: string, activeCompanyId: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
  const [item] = await db.select({ orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity, batchId: orderItems.batchId, productName: orderItems.productName, piecesPerUnit: products.piecesPerUnit })
    .from(orderItems).innerJoin(products, eq(products.id, orderItems.productId)).where(eq(orderItems.id, orderItemId)).limit(1);
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Riga ordine non trovata" });
  const [order] = await db.select({ companyId: orders.companyId, status: orders.status }).from(orders).where(eq(orders.id, item.orderId)).limit(1);
  const direction = order ? getDirectionForDestination(order.companyId) : null;
  if (!order || !direction || activeCompanyId !== direction.destinationCompanyId || order.status !== "pending") {
    return { eligible: false, reason: "Il travaso richiede un ordine pending nella company attiva.", batches: [] as any[] };
  }
  if (item.batchId) return { eligible: false, reason: `La riga possiede già un lotto ${direction.destinationCompanyName}.`, batches: [] as any[] };
  const destinationWarehouse = await getCentralWarehouse(db, direction.destinationCompanyId);
  const local = await db.select({ pieces: sql<number>`COALESCE(SUM(${inventoryByBatch.quantity}), 0)::int` }).from(inventoryByBatch)
    .innerJoin(productBatches, eq(productBatches.id, inventoryByBatch.batchId))
    .where(and(eq(inventoryByBatch.locationId, destinationWarehouse.id), eq(productBatches.productId, item.productId), eq(productBatches.companyId, direction.destinationCompanyId)));
  const requiredPieces = item.quantity * (item.piecesPerUnit ?? 1);
  if ((local[0]?.pieces ?? 0) > 0) return { eligible: false, reason: `Il prodotto ha già giacenza nel centrale ${direction.destinationCompanyName}; aggiorna l'assegnazione locale.`, batches: [] as any[] };
  const sourceWarehouse = await getCentralWarehouse(db, direction.sourceCompanyId);
  const batches = await db.select({ batchId: productBatches.id, batchNumber: productBatches.batchNumber, expirationDate: productBatches.expirationDate, availablePieces: inventoryByBatch.quantity, costPrice: productBatches.costPrice })
    .from(productBatches).innerJoin(inventoryByBatch, and(eq(inventoryByBatch.batchId, productBatches.id), eq(inventoryByBatch.locationId, sourceWarehouse.id)))
    .where(and(eq(productBatches.productId, item.productId), eq(productBatches.companyId, direction.sourceCompanyId), gt(inventoryByBatch.quantity, 0)))
    .orderBy(productBatches.expirationDate);
  return {
    eligible: true,
    productName: item.productName,
    requiredPieces,
    piecesPerUnit: item.piecesPerUnit ?? 1,
    sourceCompanyName: direction.sourceCompanyName,
    destinationCompanyName: direction.destinationCompanyName,
    directionLabel: `${direction.sourceCompanyName} → ${direction.destinationCompanyName}`,
    batches: batches.map((b) => ({ ...b, canTransfer: b.availablePieces >= requiredPieces })),
  };
}

export async function confirmIntercompanyTransferAndAssign(input: { orderItemId: string; sourceBatchId: string; actorUserId: string; activeCompanyId: string }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
  return db.transaction(async (tx) => {
    const [item] = await tx.select({ id: orderItems.id, orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity, batchId: orderItems.batchId, productName: orderItems.productName, piecesPerUnit: products.piecesPerUnit })
      .from(orderItems).innerJoin(products, eq(products.id, orderItems.productId)).where(eq(orderItems.id, input.orderItemId)).for("update").limit(1);
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Riga ordine non trovata" });
    if (item.batchId) return { alreadyAssigned: true, batchId: item.batchId };
    const [order] = await tx.select({ id: orders.id, orderNumber: orders.orderNumber, companyId: orders.companyId, status: orders.status }).from(orders).where(eq(orders.id, item.orderId)).for("update").limit(1);
    const direction = order ? getDirectionForDestination(order.companyId) : null;
    if (!order || !direction || input.activeCompanyId !== direction.destinationCompanyId || order.status !== "pending") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "L'ordine non è più pending nella company attiva." });
    }
    const sourceWarehouse = await getCentralWarehouse(tx, direction.sourceCompanyId);
    const destinationWarehouse = await getCentralWarehouse(tx, direction.destinationCompanyId);
    const [source] = await tx.select({ id: productBatches.id, batchNumber: productBatches.batchNumber, expirationDate: productBatches.expirationDate, productionDate: productBatches.productionDate, producerId: productBatches.producerId, costPrice: productBatches.costPrice, inventoryId: inventoryByBatch.id, availablePieces: inventoryByBatch.quantity })
      .from(productBatches).innerJoin(inventoryByBatch, and(eq(inventoryByBatch.batchId, productBatches.id), eq(inventoryByBatch.locationId, sourceWarehouse.id)))
      .where(and(eq(productBatches.id, input.sourceBatchId), eq(productBatches.productId, item.productId), eq(productBatches.companyId, direction.sourceCompanyId))).for("update").limit(1);
    const quantityPieces = item.quantity * (item.piecesPerUnit ?? 1);
    if (!source || source.availablePieces < quantityPieces) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Giacenza ${direction.sourceCompanyName} insufficiente: aggiorna la preview prima di confermare.` });
    let [targetBatch] = await tx.select({ id: productBatches.id, costPrice: productBatches.costPrice }).from(productBatches)
      .where(and(eq(productBatches.companyId, direction.destinationCompanyId), eq(productBatches.productId, item.productId), eq(productBatches.batchNumber, source.batchNumber))).limit(1);
    if (!targetBatch) {
      [targetBatch] = await tx.insert(productBatches).values({ productId: item.productId, batchNumber: source.batchNumber, expirationDate: source.expirationDate, productionDate: source.productionDate, producerId: source.producerId, initialQuantity: quantityPieces, costPrice: source.costPrice, companyId: direction.destinationCompanyId, notes: `Lotto speculare da ${direction.sourceCompanyName} — travaso ordine ${order.orderNumber}` }).returning({ id: productBatches.id, costPrice: productBatches.costPrice });
    }
    const [targetInventory] = await tx.select({ id: inventoryByBatch.id, quantity: inventoryByBatch.quantity }).from(inventoryByBatch)
      .where(and(eq(inventoryByBatch.locationId, destinationWarehouse.id), eq(inventoryByBatch.batchId, targetBatch.id))).for("update").limit(1);
    await tx.update(inventoryByBatch).set({ quantity: source.availablePieces - quantityPieces, updatedAt: new Date() }).where(eq(inventoryByBatch.id, source.inventoryId));
    if (targetInventory) await tx.update(inventoryByBatch).set({ quantity: targetInventory.quantity + quantityPieces, updatedAt: new Date() }).where(eq(inventoryByBatch.id, targetInventory.id));
    else await tx.insert(inventoryByBatch).values({ locationId: destinationWarehouse.id, batchId: targetBatch.id, quantity: quantityPieces, companyId: direction.destinationCompanyId });
    const ref = order.id;
    const note = `Travaso inter-company ${direction.sourceCompanyName} → ${direction.destinationCompanyName} per ordine ${order.orderNumber}, lotto ${source.batchNumber}`;
    const [sourceMovement] = await tx.insert(stockMovements).values({ productId: item.productId, type: "TRANSFER", quantity: quantityPieces, previousQuantity: source.availablePieces, newQuantity: source.availablePieces - quantityPieces, sourceDocumentType: INTERCOMPANY_TRANSFER_SOURCE_TYPE, sourceDocument: ref, batchId: source.id, fromLocationId: sourceWarehouse.id, toLocationId: null, notes: note, notesInternal: `Travaso ${direction.sourceCompanyName}→${direction.destinationCompanyName}; ordine=${ref}; batchDest=${targetBatch.id}`, createdBy: input.actorUserId, companyId: direction.sourceCompanyId }).returning({ id: stockMovements.id });
    await tx.insert(stockMovements).values({ productId: item.productId, type: "TRANSFER", quantity: quantityPieces, previousQuantity: targetInventory?.quantity ?? 0, newQuantity: (targetInventory?.quantity ?? 0) + quantityPieces, sourceDocumentType: INTERCOMPANY_TRANSFER_SOURCE_TYPE, sourceDocument: ref, batchId: targetBatch.id, fromLocationId: null, toLocationId: destinationWarehouse.id, notes: note, notesInternal: `Travaso ${direction.sourceCompanyName}→${direction.destinationCompanyName}; ordine=${ref}; movimentoSorgente=${sourceMovement.id}; batchSorgente=${source.id}`, createdBy: input.actorUserId, companyId: direction.destinationCompanyId });
    await tx.update(orderItems).set({ batchId: targetBatch.id }).where(eq(orderItems.id, item.id));
    return { alreadyAssigned: false, batchId: targetBatch.id, batchNumber: source.batchNumber, quantityPieces, sourceMovementId: sourceMovement.id, directionLabel: `${direction.sourceCompanyName} → ${direction.destinationCompanyName}` };
  });
}
