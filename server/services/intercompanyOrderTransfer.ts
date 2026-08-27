import { and, eq, gt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { inventoryByBatch, locations, orderItems, orders, productBatches, products, stockMovements } from "../../drizzle/schema";
import { EKETO_COMPANY_ID, SOKETO_COMPANY_ID } from "../../shared/const";
import { getDb } from "../db";

const INTERCOMPANY_TRANSFER_SOURCE_TYPE = "intercompany_transfer";

async function getCentralWarehouse(tx: any, companyId: string) {
  const [warehouse] = await tx.select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), eq(locations.type, "central_warehouse")))
    .limit(1);
  if (!warehouse) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Magazzino centrale company non trovato" });
  return warehouse;
}

export async function getIntercompanySourceBatches(orderItemId: string, activeCompanyId: string) {
  if (activeCompanyId !== EKETO_COMPANY_ID) return { eligible: false, reason: "Il travaso è disponibile solo su ordini E-Keto.", batches: [] as any[] };
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
  const [item] = await db.select({ orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity, batchId: orderItems.batchId, productName: orderItems.productName, piecesPerUnit: products.piecesPerUnit })
    .from(orderItems).innerJoin(products, eq(products.id, orderItems.productId)).where(eq(orderItems.id, orderItemId)).limit(1);
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Riga ordine non trovata" });
  const [order] = await db.select({ companyId: orders.companyId, status: orders.status }).from(orders).where(eq(orders.id, item.orderId)).limit(1);
  if (!order || order.companyId !== EKETO_COMPANY_ID || order.status !== "pending") return { eligible: false, reason: "Il travaso richiede un ordine E-Keto in attesa.", batches: [] as any[] };
  if (item.batchId) return { eligible: false, reason: "La riga possiede già un lotto E-Keto.", batches: [] as any[] };
  const eKetoWarehouse = await getCentralWarehouse(db, EKETO_COMPANY_ID);
  const local = await db.select({ pieces: sql<number>`COALESCE(SUM(${inventoryByBatch.quantity}), 0)::int` }).from(inventoryByBatch)
    .innerJoin(productBatches, eq(productBatches.id, inventoryByBatch.batchId))
    .where(and(eq(inventoryByBatch.locationId, eKetoWarehouse.id), eq(productBatches.productId, item.productId), eq(productBatches.companyId, EKETO_COMPANY_ID)));
  const requiredPieces = item.quantity * (item.piecesPerUnit ?? 1);
  if ((local[0]?.pieces ?? 0) > 0) return { eligible: false, reason: "Il prodotto ha già giacenza nel centrale E-Keto; aggiorna l'assegnazione locale.", batches: [] as any[] };
  const soketoWarehouse = await getCentralWarehouse(db, SOKETO_COMPANY_ID);
  const batches = await db.select({ batchId: productBatches.id, batchNumber: productBatches.batchNumber, expirationDate: productBatches.expirationDate, availablePieces: inventoryByBatch.quantity, costPrice: productBatches.costPrice })
    .from(productBatches).innerJoin(inventoryByBatch, and(eq(inventoryByBatch.batchId, productBatches.id), eq(inventoryByBatch.locationId, soketoWarehouse.id)))
    .where(and(eq(productBatches.productId, item.productId), eq(productBatches.companyId, SOKETO_COMPANY_ID), gt(inventoryByBatch.quantity, 0)))
    .orderBy(productBatches.expirationDate);
  return { eligible: true, productName: item.productName, requiredPieces, piecesPerUnit: item.piecesPerUnit ?? 1, batches: batches.map((b) => ({ ...b, canTransfer: b.availablePieces >= requiredPieces })) };
}

export async function confirmIntercompanyTransferAndAssign(input: { orderItemId: string; sourceBatchId: string; actorUserId: string; activeCompanyId: string }) {
  if (input.activeCompanyId !== EKETO_COMPANY_ID) throw new TRPCError({ code: "FORBIDDEN", message: "Il travaso è consentito solo dal contesto E-Keto." });
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });
  return db.transaction(async (tx) => {
    const [item] = await tx.select({ id: orderItems.id, orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity, batchId: orderItems.batchId, productName: orderItems.productName, piecesPerUnit: products.piecesPerUnit })
      .from(orderItems).innerJoin(products, eq(products.id, orderItems.productId)).where(eq(orderItems.id, input.orderItemId)).for("update").limit(1);
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Riga ordine non trovata" });
    if (item.batchId) return { alreadyAssigned: true, batchId: item.batchId };
    const [order] = await tx.select({ id: orders.id, orderNumber: orders.orderNumber, companyId: orders.companyId, status: orders.status }).from(orders).where(eq(orders.id, item.orderId)).for("update").limit(1);
    if (!order || order.companyId !== EKETO_COMPANY_ID || order.status !== "pending") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "L'ordine non è più un pending E-Keto." });
    const soketoWarehouse = await getCentralWarehouse(tx, SOKETO_COMPANY_ID);
    const eKetoWarehouse = await getCentralWarehouse(tx, EKETO_COMPANY_ID);
    const [source] = await tx.select({ id: productBatches.id, batchNumber: productBatches.batchNumber, expirationDate: productBatches.expirationDate, productionDate: productBatches.productionDate, producerId: productBatches.producerId, costPrice: productBatches.costPrice, inventoryId: inventoryByBatch.id, availablePieces: inventoryByBatch.quantity })
      .from(productBatches).innerJoin(inventoryByBatch, and(eq(inventoryByBatch.batchId, productBatches.id), eq(inventoryByBatch.locationId, soketoWarehouse.id)))
      .where(and(eq(productBatches.id, input.sourceBatchId), eq(productBatches.productId, item.productId), eq(productBatches.companyId, SOKETO_COMPANY_ID))).for("update").limit(1);
    const quantityPieces = item.quantity * (item.piecesPerUnit ?? 1);
    if (!source || source.availablePieces < quantityPieces) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Giacenza SoKeto insufficiente: aggiorna la preview prima di confermare." });
    let [targetBatch] = await tx.select({ id: productBatches.id, costPrice: productBatches.costPrice }).from(productBatches)
      .where(and(eq(productBatches.companyId, EKETO_COMPANY_ID), eq(productBatches.productId, item.productId), eq(productBatches.batchNumber, source.batchNumber))).limit(1);
    if (!targetBatch) {
      [targetBatch] = await tx.insert(productBatches).values({ productId: item.productId, batchNumber: source.batchNumber, expirationDate: source.expirationDate, productionDate: source.productionDate, producerId: source.producerId, initialQuantity: quantityPieces, costPrice: source.costPrice, companyId: EKETO_COMPANY_ID, notes: `Lotto speculare da SoKeto — travaso ordine ${order.orderNumber}` }).returning({ id: productBatches.id, costPrice: productBatches.costPrice });
    }
    const [targetInventory] = await tx.select({ id: inventoryByBatch.id, quantity: inventoryByBatch.quantity }).from(inventoryByBatch)
      .where(and(eq(inventoryByBatch.locationId, eKetoWarehouse.id), eq(inventoryByBatch.batchId, targetBatch.id))).for("update").limit(1);
    await tx.update(inventoryByBatch).set({ quantity: source.availablePieces - quantityPieces, updatedAt: new Date() }).where(eq(inventoryByBatch.id, source.inventoryId));
    if (targetInventory) await tx.update(inventoryByBatch).set({ quantity: targetInventory.quantity + quantityPieces, updatedAt: new Date() }).where(eq(inventoryByBatch.id, targetInventory.id));
    else await tx.insert(inventoryByBatch).values({ locationId: eKetoWarehouse.id, batchId: targetBatch.id, quantity: quantityPieces, companyId: EKETO_COMPANY_ID });
    const ref = order.id;
    const note = `Travaso inter-company SoKeto → E-Keto per ordine ${order.orderNumber}, lotto ${source.batchNumber}`;
    const [sourceMovement] = await tx.insert(stockMovements).values({ productId: item.productId, type: "TRANSFER", quantity: quantityPieces, previousQuantity: source.availablePieces, newQuantity: source.availablePieces - quantityPieces, sourceDocumentType: INTERCOMPANY_TRANSFER_SOURCE_TYPE, sourceDocument: ref, batchId: source.id, fromLocationId: soketoWarehouse.id, toLocationId: null, notes: note, notesInternal: `Travaso SoKeto→E-Keto; ordine=${ref}; batchDest=${targetBatch.id}`, createdBy: input.actorUserId, companyId: SOKETO_COMPANY_ID }).returning({ id: stockMovements.id });
    await tx.insert(stockMovements).values({ productId: item.productId, type: "TRANSFER", quantity: quantityPieces, previousQuantity: targetInventory?.quantity ?? 0, newQuantity: (targetInventory?.quantity ?? 0) + quantityPieces, sourceDocumentType: INTERCOMPANY_TRANSFER_SOURCE_TYPE, sourceDocument: ref, batchId: targetBatch.id, fromLocationId: null, toLocationId: eKetoWarehouse.id, notes: note, notesInternal: `Travaso SoKeto→E-Keto; ordine=${ref}; movimentoSorgente=${sourceMovement.id}; batchSorgente=${source.id}`, createdBy: input.actorUserId, companyId: EKETO_COMPANY_ID });
    await tx.update(orderItems).set({ batchId: targetBatch.id }).where(eq(orderItems.id, item.id));
    return { alreadyAssigned: false, batchId: targetBatch.id, batchNumber: source.batchNumber, quantityPieces, sourceMovementId: sourceMovement.id };
  });
}
