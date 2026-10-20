import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  inventoryByBatch,
  labelMovements,
  locations,
  orderItems,
  orderStatusEvents,
  orders,
  productBatches,
  products,
  retailers,
  stockMovements,
} from "../../drizzle/schema";
import { SOKETO_SRL_INTERCOMPANY_RETAILER_ID } from "../../shared/const";
import { getDb } from "../db";
import type { OrderStatus } from "./orderStateMachine";

export type FulfillmentSource = "manual_step" | "delivery_confirm";
export type FulfillmentTarget = Extract<OrderStatus, "transferring" | "shipped" | "delivered">;

type TransferAllocation = {
  productId: string;
  productName: string;
  productSku: string;
  batchId: string;
  batchNumber: string;
  expirationDate: string;
  quantityPackages: number;
  quantityPieces: number;
  sourceItemId: string;
};

type OrderItemForFulfillment = {
  id: string;
  orderId: string;
  productId: string;
  batchId: string | null;
  quantity: number;
  unitPriceBase: string;
  discountPercent: string;
  unitPriceFinal: string;
  vatRate: string;
  lineTotalNet: string;
  lineTotalGross: string;
  productSku: string;
  productName: string;
  createdAt: Date;
  piecesPerUnit: number;
};

type LockedInventory = {
  id: string;
  batchId: string;
  productId: string;
  batchNumber: string;
  expirationDate: string;
  quantity: number;
};

const STATUS_INDEX: Record<OrderStatus, number> = {
  pending: 0,
  transferring: 1,
  shipped: 2,
  delivered: 3,
  cancelled: -1,
};

const money = (value: number) => (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);

function fulfillmentError(message: string): TRPCError {
  return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function compareAllocations(a: TransferAllocation, b: TransferAllocation) {
  return a.productId.localeCompare(b.productId)
    || a.expirationDate.localeCompare(b.expirationDate)
    || a.batchId.localeCompare(b.batchId)
    || a.sourceItemId.localeCompare(b.sourceItemId);
}

/**
 * Calcola le quote FEFO delle sole righe non ancora assegnate. La quantità
 * dell'ordine è in confezioni, mentre le giacenze sono in pezzi: il piano
 * non usa mai pezzi residui che non compongono una confezione intera.
 */
function buildAllocationPlan(input: {
  items: OrderItemForFulfillment[];
  inventories: LockedInventory[];
  companyName: string;
}) {
  const inventoryByBatchId = new Map(input.inventories.map((row) => [row.batchId, row]));
  const availableByBatchId = new Map(input.inventories.map((row) => [row.batchId, row.quantity]));
  const byProduct = new Map<string, LockedInventory[]>();
  for (const row of input.inventories) {
    const rows = byProduct.get(row.productId) ?? [];
    rows.push(row);
    byProduct.set(row.productId, rows);
  }

  const allocations = new Map<string, TransferAllocation[]>();

  // Le righe con lotto già esplicito restano tali, ma la loro domanda riserva
  // prima la giacenza del lotto per evitare di sovra-allocarlo alle righe NULL.
  for (const item of input.items.filter((row) => row.batchId)) {
    const inventory = inventoryByBatchId.get(item.batchId!);
    const pieces = item.quantity * item.piecesPerUnit;
    if (!inventory || inventory.productId !== item.productId) {
      throw fulfillmentError(`Lotto assegnato non disponibile nel centrale ${input.companyName}: ${item.productName}.`);
    }
    const available = availableByBatchId.get(inventory.batchId) ?? 0;
    if (available < pieces) {
      throw fulfillmentError(
        `Giacenza insufficiente nel centrale ${input.companyName}: ${item.productName}, mancano ${pieces - Math.max(available, 0)} pz.`,
      );
    }
    availableByBatchId.set(inventory.batchId, available - pieces);
    allocations.set(item.id, [{
      productId: item.productId,
      productName: item.productName,
      productSku: item.productSku,
      batchId: inventory.batchId,
      batchNumber: inventory.batchNumber,
      expirationDate: inventory.expirationDate,
      quantityPackages: item.quantity,
      quantityPieces: pieces,
      sourceItemId: item.id,
    }]);
  }

  // FEFO per le righe "Da allocare", con spezzatura riga quando necessario.
  for (const item of input.items.filter((row) => !row.batchId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    let remainingPackages = item.quantity;
    const itemAllocations: TransferAllocation[] = [];
    const candidates = (byProduct.get(item.productId) ?? [])
      .slice()
      .sort((a, b) => a.expirationDate.localeCompare(b.expirationDate) || a.batchId.localeCompare(b.batchId));

    for (const candidate of candidates) {
      if (remainingPackages === 0) break;
      const availablePieces = availableByBatchId.get(candidate.batchId) ?? 0;
      const allocatablePackages = Math.min(remainingPackages, Math.floor(availablePieces / item.piecesPerUnit));
      if (allocatablePackages <= 0) continue;
      const allocationPieces = allocatablePackages * item.piecesPerUnit;
      availableByBatchId.set(candidate.batchId, availablePieces - allocationPieces);
      itemAllocations.push({
        productId: item.productId,
        productName: item.productName,
        productSku: item.productSku,
        batchId: candidate.batchId,
        batchNumber: candidate.batchNumber,
        expirationDate: candidate.expirationDate,
        quantityPackages: allocatablePackages,
        quantityPieces: allocationPieces,
        sourceItemId: item.id,
      });
      remainingPackages -= allocatablePackages;
    }

    if (remainingPackages > 0) {
      throw fulfillmentError(
        `Travaso necessario: ${item.productName}, mancano ${remainingPackages * item.piecesPerUnit} pz su ${input.companyName}.`,
      );
    }
    allocations.set(item.id, itemAllocations);
  }

  return { allocations, availableByBatchId };
}

async function getWarehouseAndRetailerLocation(database: any, order: { retailerId: string | null; companyId: string }) {
  if (!order.retailerId) throw fulfillmentError("L'ordine non è associato a un rivenditore.");
  const [[warehouse], [retailerLocation]] = await Promise.all([
    database.select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.type, "central_warehouse"), eq(locations.companyId, order.companyId)))
      .limit(1),
    database.select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.type, "retailer"), eq(locations.retailerId, order.retailerId), eq(locations.companyId, order.companyId)))
      .limit(1),
  ]);
  if (!warehouse) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Magazzino centrale non configurato." });
  if (!retailerLocation) throw fulfillmentError("Il rivenditore non ha una location di magazzino nella company dell'ordine.");
  return { warehouse, retailerLocation };
}

async function loadItems(database: any, orderId: string, lock = false): Promise<OrderItemForFulfillment[]> {
  let query = database
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      batchId: orderItems.batchId,
      quantity: orderItems.quantity,
      unitPriceBase: orderItems.unitPriceBase,
      discountPercent: orderItems.discountPercent,
      unitPriceFinal: orderItems.unitPriceFinal,
      vatRate: orderItems.vatRate,
      lineTotalNet: orderItems.lineTotalNet,
      lineTotalGross: orderItems.lineTotalGross,
      productSku: orderItems.productSku,
      productName: orderItems.productName,
      createdAt: orderItems.createdAt,
      piecesPerUnit: products.piecesPerUnit,
    })
    .from(orderItems)
    .innerJoin(products, eq(orderItems.productId, products.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  if (lock) query = query.for("update");
  const rows = await query;
  return rows.map((row: any) => ({ ...row, piecesPerUnit: row.piecesPerUnit ?? 1 }));
}

async function loadCentralInventory(database: any, companyId: string, warehouseId: string, productIds: string[], lock = false): Promise<LockedInventory[]> {
  if (productIds.length === 0) return [];
  let query = database
    .select({
      id: inventoryByBatch.id,
      batchId: inventoryByBatch.batchId,
      productId: productBatches.productId,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      quantity: inventoryByBatch.quantity,
    })
    .from(inventoryByBatch)
    .innerJoin(productBatches, eq(inventoryByBatch.batchId, productBatches.id))
    .where(and(
      eq(inventoryByBatch.locationId, warehouseId),
      eq(inventoryByBatch.companyId, companyId),
      eq(productBatches.companyId, companyId),
      inArray(productBatches.productId, productIds),
    ))
    .orderBy(asc(productBatches.productId), asc(productBatches.expirationDate), asc(productBatches.id));
  if (lock) query = query.for("update");
  return await query;
}

async function replaceUnassignedRows(database: any, items: OrderItemForFulfillment[], allocations: Map<string, TransferAllocation[]>) {
  for (const item of items.filter((row) => !row.batchId)) {
    const splits = allocations.get(item.id) ?? [];
    if (splits.length === 0) throw new Error(`Piano FEFO mancante per la riga ${item.id}`);
    if (splits.length === 1) {
      await database.update(orderItems).set({ batchId: splits[0].batchId }).where(eq(orderItems.id, item.id));
      continue;
    }

    await database.delete(orderItems).where(eq(orderItems.id, item.id));
    await database.insert(orderItems).values(splits.map((split) => {
      const lineNet = Number(item.unitPriceFinal) * split.quantityPackages;
      const lineGross = lineNet * (1 + Number(item.vatRate) / 100);
      return {
        orderId: item.orderId,
        productId: item.productId,
        batchId: split.batchId,
        quantity: split.quantityPackages,
        unitPriceBase: item.unitPriceBase,
        discountPercent: item.discountPercent,
        unitPriceFinal: item.unitPriceFinal,
        vatRate: item.vatRate,
        lineTotalNet: money(lineNet),
        lineTotalGross: money(lineGross),
        productSku: item.productSku,
        productName: item.productName,
      };
    }));
  }
}

async function consumeLabelsAtomically(database: any, input: {
  items: OrderItemForFulfillment[];
  orderId: string;
  orderNumber: string | null;
  actorUserId: string;
}) {
  const byProduct = new Map<string, { quantity: number; productName: string }>();
  for (const item of input.items) {
    const current = byProduct.get(item.productId) ?? { quantity: 0, productName: item.productName };
    current.quantity += item.quantity;
    byProduct.set(item.productId, current);
  }
  const productIds = Array.from(byProduct.keys()).sort();
  if (productIds.length === 0) return;

  const lockedProducts = await database
    .select({ id: products.id, name: products.name, labelStock: products.labelStock })
    .from(products)
    .where(inArray(products.id, productIds))
    .orderBy(asc(products.id))
    .for("update");

  const productById = new Map<string, { id: string; name: string; labelStock: number }>(
    lockedProducts.map((row: any) => [row.id, row]),
  );
  for (const productId of productIds) {
    const requirement = byProduct.get(productId)!;
    const product = productById.get(productId);
    if (!product || product.labelStock < requirement.quantity) {
      throw fulfillmentError(
        `Etichette insufficienti per ${requirement.productName}: disponibili ${product?.labelStock ?? 0}, richieste ${requirement.quantity}.`,
      );
    }
  }

  for (const productId of productIds) {
    const requirement = byProduct.get(productId)!;
    const product = productById.get(productId)!;
    const newStock = product.labelStock - requirement.quantity;
    await database.update(products).set({ labelStock: newStock, updatedAt: new Date() }).where(eq(products.id, productId));
    await database.insert(labelMovements).values({
      productId,
      type: "CONSUMPTION",
      quantity: -requirement.quantity,
      previousStock: product.labelStock,
      newStock,
      sourceOrderId: input.orderId,
      notes: `Spedizione ordine ${input.orderNumber ?? input.orderId}`,
      createdBy: input.actorUserId,
    });
  }
}

function nextStatuses(currentStatus: OrderStatus, targetStatus: FulfillmentTarget): Array<{ fromStatus: OrderStatus; toStatus: FulfillmentTarget }> {
  const sequence: FulfillmentTarget[] = ["transferring", "shipped", "delivered"];
  const currentIndex = STATUS_INDEX[currentStatus];
  const targetIndex = STATUS_INDEX[targetStatus];
  return sequence
    .filter((status) => STATUS_INDEX[status] > currentIndex && STATUS_INDEX[status] <= targetIndex)
    .map((toStatus, index, all) => ({
      fromStatus: index === 0 ? currentStatus : all[index - 1],
      toStatus,
    }));
}

export async function previewOrderDelivery(input: { orderId: string; companyId: string }) {
  const database = await getDb();
  if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  const [order] = await database
    .select({ id: orders.id, retailerId: orders.retailerId, companyId: orders.companyId, status: orders.status, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.companyId, input.companyId)))
    .limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
  if (order.retailerId === SOKETO_SRL_INTERCOMPANY_RETAILER_ID) {
    return { canConfirm: false, reason: "Ordine inter-company: usare il flusso di travaso dedicato.", allocations: [] as TransferAllocation[] };
  }
  if (order.status === "cancelled" || order.status === "delivered") {
    return { canConfirm: false, reason: "L'ordine non è confermabile nello stato attuale.", allocations: [] as TransferAllocation[] };
  }
  if (order.paymentStatus !== "paid") {
    return { canConfirm: false, reason: "Il pagamento deve essere confermato prima della consegna.", allocations: [] as TransferAllocation[] };
  }

  const { warehouse } = await getWarehouseAndRetailerLocation(database, order);
  const items = await loadItems(database, order.id);
  try {
    const inventory = await loadCentralInventory(database, order.companyId, warehouse.id, Array.from(new Set(items.map((item) => item.productId))));
    const plan = buildAllocationPlan({ items, inventories: inventory, companyName: warehouse.name });
    return {
      canConfirm: true,
      reason: null,
      allocations: Array.from(plan.allocations.values()).flat().filter((allocation) => !items.find((item) => item.id === allocation.sourceItemId)?.batchId).sort(compareAllocations),
    };
  } catch (error) {
    return {
      canConfirm: false,
      reason: error instanceof Error ? error.message : "Impossibile preparare la consegna.",
      allocations: [] as TransferAllocation[],
    };
  }
}

export async function executeOrderFulfillment(input: {
  orderId: string;
  companyId: string;
  actorUserId: string;
  targetStatus: FulfillmentTarget;
  source: FulfillmentSource;
  requirePayment: boolean;
}) {
  const database = await getDb();
  if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  return await database.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        retailerId: orders.retailerId,
        companyId: orders.companyId,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        ficProformaId: orders.ficProformaId,
        ficInvoiceId: orders.ficInvoiceId,
      })
      .from(orders)
      .where(and(eq(orders.id, input.orderId), eq(orders.companyId, input.companyId)))
      .for("update")
      .limit(1);

    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
    const currentStatus = order.status as OrderStatus;
    if (order.retailerId === SOKETO_SRL_INTERCOMPANY_RETAILER_ID) {
      throw fulfillmentError("Ordine inter-company: il nuovo flusso di consegna è disabilitato finché M11.D non sarà rimosso.");
    }
    if (currentStatus === "cancelled") throw fulfillmentError("Un ordine annullato non può essere evaso.");
    if (currentStatus === "delivered") {
      return {
        idempotent: true,
        orderId: order.id,
        orderNumber: order.orderNumber,
        retailerId: order.retailerId,
        companyId: order.companyId,
        previousStatus: currentStatus,
        newStatus: currentStatus,
        allocations: [] as TransferAllocation[],
        needsProforma: false,
        needsInvoice: false,
      };
    }
    if (input.requirePayment && order.paymentStatus !== "paid") {
      throw fulfillmentError("Il pagamento deve essere confermato prima di segnare l'ordine come consegnato.");
    }
    if (STATUS_INDEX[currentStatus] > STATUS_INDEX[input.targetStatus]) {
      throw fulfillmentError(`L'ordine è già oltre lo step richiesto (${currentStatus}).`);
    }

    const items = await loadItems(tx, order.id, true);
    if (items.length === 0) throw fulfillmentError("L'ordine non contiene righe da trasferire.");
    let effectiveTransfers: TransferAllocation[] = [];

    // Il trasferimento fisico avviene una sola volta, all'uscita da pending.
    // Gli step successivi riusano lo stesso service ma non ri-scaricano stock.
    if (currentStatus === "pending") {
      const { warehouse, retailerLocation } = await getWarehouseAndRetailerLocation(tx, order);
      const inventory = await loadCentralInventory(tx, order.companyId, warehouse.id, Array.from(new Set(items.map((item) => item.productId))), true);
      const plan = buildAllocationPlan({ items, inventories: inventory, companyName: warehouse.name });
      await replaceUnassignedRows(tx, items, plan.allocations);

      effectiveTransfers = Array.from(plan.allocations.values()).flat().sort(compareAllocations);
      const inventoryByBatchId = new Map(inventory.map((row) => [row.batchId, row]));
      const transferredPiecesByBatch = new Map<string, number>();
      for (const transfer of effectiveTransfers) {
        transferredPiecesByBatch.set(transfer.batchId, (transferredPiecesByBatch.get(transfer.batchId) ?? 0) + transfer.quantityPieces);
      }

      const runningCentralByBatch = new Map(inventory.map((row) => [row.batchId, row.quantity]));
      for (const transfer of effectiveTransfers) {
        const before = runningCentralByBatch.get(transfer.batchId);
        if (before == null || before < transfer.quantityPieces) {
          throw new Error(`Piano trasferimento incoerente per lotto ${transfer.batchNumber}.`);
        }
        const after = before - transfer.quantityPieces;
        runningCentralByBatch.set(transfer.batchId, after);
        await tx.insert(inventoryByBatch).values({
          locationId: retailerLocation.id,
          batchId: transfer.batchId,
          quantity: transfer.quantityPieces,
          companyId: order.companyId,
        }).onConflictDoUpdate({
          target: [inventoryByBatch.locationId, inventoryByBatch.batchId],
          set: {
            quantity: sql`${inventoryByBatch.quantity} + ${transfer.quantityPieces}`,
            updatedAt: new Date(),
          },
        });
        await tx.insert(stockMovements).values({
          productId: transfer.productId,
          type: "TRANSFER",
          quantity: transfer.quantityPieces,
          previousQuantity: before,
          newQuantity: after,
          sourceDocumentType: "order_transfer",
          sourceDocument: order.id,
          retailerId: order.retailerId!,
          batchId: transfer.batchId,
          fromLocationId: warehouse.id,
          toLocationId: retailerLocation.id,
          notes: `Ordine ${order.orderNumber ?? order.id}: ${transfer.quantityPackages} conf. (${transfer.quantityPieces} pz)`,
          notesInternal: `Trasferimento atomico lotto ${transfer.batchNumber} verso ${retailerLocation.name}`,
          createdBy: input.actorUserId,
          companyId: order.companyId,
        });
      }

      for (const [batchId, transferredPieces] of Array.from(transferredPiecesByBatch.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        const inventoryRow = inventoryByBatchId.get(batchId);
        if (!inventoryRow) throw new Error(`Lotto ${batchId} non trovato nel centrale.`);
        await tx.update(inventoryByBatch)
          .set({ quantity: inventoryRow.quantity - transferredPieces, updatedAt: new Date() })
          .where(eq(inventoryByBatch.id, inventoryRow.id));
      }
    }

    if (STATUS_INDEX[input.targetStatus] >= STATUS_INDEX.shipped && STATUS_INDEX[currentStatus] < STATUS_INDEX.shipped) {
      await consumeLabelsAtomically(tx, {
        items: await loadItems(tx, order.id),
        orderId: order.id,
        orderNumber: order.orderNumber,
        actorUserId: input.actorUserId,
      });
    }

    const transitions = nextStatuses(currentStatus, input.targetStatus);
    const now = new Date();
    const update: Record<string, unknown> = { status: input.targetStatus, updatedAt: now };
    for (const transition of transitions) {
      if (transition.toStatus === "transferring") update.transferringAt = now;
      if (transition.toStatus === "shipped") update.shippedAt = now;
      if (transition.toStatus === "delivered") update.deliveredAt = now;
    }
    await tx.update(orders).set(update).where(eq(orders.id, order.id));
    if (transitions.length > 0) {
      const eventBaseTime = Date.now();
      await tx.insert(orderStatusEvents).values(transitions.map((transition, index) => ({
        orderId: order.id,
        companyId: order.companyId,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        source: input.source,
        actorUserId: input.actorUserId,
        // L'ordine degli step composti deve restare leggibile anche quando il
        // DB assegna la stessa precisione di timestamp a un insert multiplo.
        createdAt: new Date(eventBaseTime + index),
      })));
    }

    return {
      idempotent: false,
      orderId: order.id,
      orderNumber: order.orderNumber,
      retailerId: order.retailerId,
      companyId: order.companyId,
      previousStatus: currentStatus,
      newStatus: input.targetStatus,
      allocations: effectiveTransfers,
      needsProforma: !order.ficProformaId,
      needsInvoice: input.targetStatus === "delivered" && !order.ficInvoiceId,
    };
  });
}
