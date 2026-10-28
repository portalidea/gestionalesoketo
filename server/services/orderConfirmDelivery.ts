import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  companies,
  inventoryByBatch,
  labelMovements,
  locations,
  orderItemFulfillmentExceptions,
  orderItems,
  orderStatusEvents,
  orders,
  productBatches,
  products,
  retailers,
  stockMovements,
} from "../../drizzle/schema";
import {
  EKETO_COMPANY_ID,
  SOKETO_COMPANY_ID,
  SOKETO_SRL_INTERCOMPANY_RETAILER_ID,
} from "../../shared/const";
import { getDb } from "../db";
import type { OrderStatus } from "./orderStateMachine";

export type FulfillmentSource = "manual_step" | "delivery_confirm" | "delivery_exception";
export type FulfillmentTarget = Extract<OrderStatus, "transferring" | "shipped" | "delivered">;

export type FulfillmentExceptionType = "reallocated" | "no_stock_movement";

export type FulfillmentExceptionSelection = {
  orderItemId: string;
  exceptionType: FulfillmentExceptionType;
  reason: string;
};

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
  originalBatchNumber: string | null;
  originalBatchExpirationDate: string | null;
};

type LockedInventory = {
  id: string;
  batchId: string;
  productId: string;
  batchNumber: string;
  expirationDate: string;
  quantity: number;
};

type FulfillmentExceptionPreview = {
  orderItemId: string;
  productId: string;
  productName: string;
  productSku: string;
  quantityPackages: number;
  quantityPieces: number;
  originalBatchId: string;
  originalBatchNumber: string;
  originalBatchExpirationDate: string;
  originalBatchQuantity: number;
  productCentralQuantity: number;
  issue: string;
  reallocated: { available: boolean; allocations: TransferAllocation[] };
  noStockMovement: { available: boolean };
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

function getCounterpartyCompanyId(companyId: string) {
  if (companyId === EKETO_COMPANY_ID) return SOKETO_COMPANY_ID;
  if (companyId === SOKETO_COMPANY_ID) return EKETO_COMPANY_ID;
  return null;
}

function availabilityError(input: {
  productName: string;
  requiredPieces: number;
  availableCurrentCompanyPieces: number;
  availableCounterpartyPieces: number;
  companyName: string;
}) {
  const missingInCurrentCompany = Math.max(input.requiredPieces - input.availableCurrentCompanyPieces, 0);
  if (missingInCurrentCompany > 0 && input.availableCounterpartyPieces >= missingInCurrentCompany) {
    return fulfillmentError(
      `Travaso necessario: ${input.productName}, mancano ${missingInCurrentCompany} pz su ${input.companyName}.`,
    );
  }

  const totalShortage = Math.max(
    input.requiredPieces - input.availableCurrentCompanyPieces - input.availableCounterpartyPieces,
    0,
  );
  return fulfillmentError(
    `Giacenza insufficiente: ${input.productName}, mancano ${totalShortage} pz complessivi tra E-Keto Food Srls e SoKeto Srl.`,
  );
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
  counterpartyAvailablePiecesByProduct: Map<string, number>;
  reallocatedItemIds?: Set<string>;
  excludedItemIds?: Set<string>;
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

  const reallocatedItemIds = input.reallocatedItemIds ?? new Set<string>();
  const excludedItemIds = input.excludedItemIds ?? new Set<string>();

  // Le righe con lotto già esplicito restano tali, salvo la sola riga scelta
  // esplicitamente dall'amministratore per la riallocazione FEFO. La loro
  // domanda riserva prima la giacenza del lotto per evitare di sovra-allocarlo
  // alle righe senza lotto.
  for (const item of input.items.filter((row) => (
    row.batchId && !reallocatedItemIds.has(row.id) && !excludedItemIds.has(row.id)
  ))) {
    const inventory = inventoryByBatchId.get(item.batchId!);
    const pieces = item.quantity * item.piecesPerUnit;
    if (!inventory || inventory.productId !== item.productId) {
      throw fulfillmentError(`Lotto assegnato non disponibile nel centrale ${input.companyName}: ${item.productName}.`);
    }
    const available = availableByBatchId.get(inventory.batchId) ?? 0;
    if (available < pieces) {
      const availableForProduct = input.inventories
        .filter((row) => row.productId === item.productId)
        .reduce((total, row) => total + (availableByBatchId.get(row.batchId) ?? 0), 0);
      throw availabilityError({
        productName: item.productName,
        requiredPieces: pieces,
        availableCurrentCompanyPieces: availableForProduct,
        availableCounterpartyPieces: input.counterpartyAvailablePiecesByProduct.get(item.productId) ?? 0,
        companyName: input.companyName,
      });
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

  // FEFO per le righe "Da allocare" e per le sole righe esplicitamente
  // riallocate; il lotto originario della seconda categoria non viene più
  // riservato, pertanto può rientrare nel FEFO se è ancora il più prossimo.
  for (const item of input.items
    .filter((row) => (
      (!row.batchId || reallocatedItemIds.has(row.id)) && !excludedItemIds.has(row.id)
    ))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
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
      const availableForProduct = candidates
        .reduce((total, candidate) => total + (availableByBatchId.get(candidate.batchId) ?? 0), 0);
      throw availabilityError({
        productName: item.productName,
        requiredPieces: remainingPackages * item.piecesPerUnit,
        availableCurrentCompanyPieces: availableForProduct,
        availableCounterpartyPieces: input.counterpartyAvailablePiecesByProduct.get(item.productId) ?? 0,
        companyName: input.companyName,
      });
    }
    allocations.set(item.id, itemAllocations);
  }

  return { allocations, availableByBatchId };
}

async function getWarehouseAndRetailerLocation(database: any, order: { retailerId: string | null; companyId: string }) {
  if (!order.retailerId) throw fulfillmentError("L'ordine non è associato a un rivenditore.");
  const [[warehouse], [retailerLocation], [company]] = await Promise.all([
    database.select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.type, "central_warehouse"), eq(locations.companyId, order.companyId)))
      .limit(1),
    database.select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.type, "retailer"), eq(locations.retailerId, order.retailerId), eq(locations.companyId, order.companyId)))
      .limit(1),
    database.select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, order.companyId))
      .limit(1),
  ]);
  if (!warehouse) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Magazzino centrale non configurato." });
  if (!retailerLocation) throw fulfillmentError("Il rivenditore non ha una location di magazzino nella company dell'ordine.");
  if (!company) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Company dell'ordine non trovata." });
  return { warehouse, retailerLocation, companyName: company.name };
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
  const batchIds = rows.map((row: any) => row.batchId).filter(Boolean) as string[];
  const batchSnapshots = batchIds.length === 0
    ? []
    : await database
      .select({ id: productBatches.id, batchNumber: productBatches.batchNumber, expirationDate: productBatches.expirationDate })
      .from(productBatches)
      .where(inArray(productBatches.id, batchIds));
  const snapshotByBatchId = new Map<string, { batchNumber: string; expirationDate: string }>(
    batchSnapshots.map((batch: any) => [batch.id, { batchNumber: batch.batchNumber, expirationDate: batch.expirationDate }]),
  );
  return rows.map((row: any) => {
    const snapshot = row.batchId ? snapshotByBatchId.get(row.batchId) : undefined;
    return {
      ...row,
      piecesPerUnit: row.piecesPerUnit ?? 1,
      originalBatchNumber: snapshot?.batchNumber ?? null,
      originalBatchExpirationDate: snapshot?.expirationDate ?? null,
    };
  });
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

async function loadCounterpartyCentralAvailability(
  database: any,
  companyId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const counterpartyCompanyId = getCounterpartyCompanyId(companyId);
  if (!counterpartyCompanyId || productIds.length === 0) return new Map();

  const rows = await database
    .select({
      productId: productBatches.productId,
      quantity: sql<number>`COALESCE(SUM(${inventoryByBatch.quantity}), 0)::int`,
    })
    .from(inventoryByBatch)
    .innerJoin(productBatches, eq(inventoryByBatch.batchId, productBatches.id))
    .innerJoin(locations, eq(inventoryByBatch.locationId, locations.id))
    .where(and(
      eq(locations.type, "central_warehouse"),
      eq(locations.companyId, counterpartyCompanyId),
      eq(inventoryByBatch.companyId, counterpartyCompanyId),
      eq(productBatches.companyId, counterpartyCompanyId),
      inArray(productBatches.productId, productIds),
    ))
    .groupBy(productBatches.productId);

  return new Map(rows.map((row: any) => [row.productId, Number(row.quantity)]));
}

async function replaceRowsForFefo(database: any, input: {
  items: OrderItemForFulfillment[];
  allocations: Map<string, TransferAllocation[]>;
  reallocatedItemIds: Set<string>;
}) {
  for (const item of input.items.filter((row) => !row.batchId || input.reallocatedItemIds.has(row.id))) {
    const splits = input.allocations.get(item.id) ?? [];
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
    if (!product) {
      throw fulfillmentError(`Prodotto non trovato per il consumo etichette: ${requirement.productName}.`);
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

function buildFulfillmentExceptionPreviews(
  items: OrderItemForFulfillment[],
  inventories: LockedInventory[],
): FulfillmentExceptionPreview[] {
  const inventoryByBatchId = new Map(inventories.map((row) => [row.batchId, row]));
  const productQuantityById = new Map<string, number>();
  for (const inventory of inventories) {
    productQuantityById.set(
      inventory.productId,
      (productQuantityById.get(inventory.productId) ?? 0) + inventory.quantity,
    );
  }

  return items
    .filter((item) => item.batchId)
    .map((item) => {
      const requiredPieces = item.quantity * item.piecesPerUnit;
      const originalInventory = inventoryByBatchId.get(item.batchId!);
      const originalBatchQuantity = originalInventory?.quantity ?? 0;
      const productCentralQuantity = productQuantityById.get(item.productId) ?? 0;
      if (originalInventory && originalInventory.productId === item.productId && originalBatchQuantity >= requiredPieces) {
        return null;
      }
      const originalBatchNumber = item.originalBatchNumber ?? originalInventory?.batchNumber;
      const originalBatchExpirationDate = item.originalBatchExpirationDate ?? originalInventory?.expirationDate;
      if (!originalBatchNumber || !originalBatchExpirationDate) {
        throw fulfillmentError(`Lotto originario non reperibile per la riga ${item.productName}.`);
      }
      const reallocationAvailable = productCentralQuantity >= requiredPieces;
      const noStockMovementAvailable = originalBatchQuantity === 0 && productCentralQuantity < requiredPieces;
      return {
        orderItemId: item.id,
        productId: item.productId,
        productName: item.productName,
        productSku: item.productSku,
        quantityPackages: item.quantity,
        quantityPieces: requiredPieces,
        originalBatchId: item.batchId!,
        originalBatchNumber,
        originalBatchExpirationDate,
        originalBatchQuantity,
        productCentralQuantity,
        issue: `Il lotto originario non copre ${item.quantity} conf. (${requiredPieces} pz).`,
        reallocated: { available: reallocationAvailable, allocations: [] as TransferAllocation[] },
        noStockMovement: { available: noStockMovementAvailable },
      } satisfies FulfillmentExceptionPreview;
    })
    .filter((item): item is FulfillmentExceptionPreview => item !== null);
}

export async function previewOrderDelivery(input: { orderId: string; companyId: string }) {
  const database = await getDb();
  if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  const [order] = await database
    .select({ id: orders.id, retailerId: orders.retailerId, companyId: orders.companyId, status: orders.status, paymentStatus: orders.paymentStatus, eventType: orders.eventType })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.companyId, input.companyId)))
    .limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordine non trovato" });
  if (order.eventType) {
    return { canConfirm: false, requiresExceptions: false, reason: "Ordine evento: usare il flusso di consegna dedicato.", allocations: [] as TransferAllocation[], exceptionItems: [] as FulfillmentExceptionPreview[] };
  }
  if (order.retailerId === SOKETO_SRL_INTERCOMPANY_RETAILER_ID) {
    return { canConfirm: false, requiresExceptions: false, reason: "Ordine inter-company: usare il flusso di travaso dedicato.", allocations: [] as TransferAllocation[], exceptionItems: [] as FulfillmentExceptionPreview[] };
  }
  if (order.status === "cancelled" || order.status === "delivered") {
    return { canConfirm: false, requiresExceptions: false, reason: "L'ordine non è confermabile nello stato attuale.", allocations: [] as TransferAllocation[], exceptionItems: [] as FulfillmentExceptionPreview[] };
  }
  // Dopo il primo trasferimento non c'è uno scarico da alterare: gli step
  // mancanti restano confermabili con il flusso ordinario, senza eccezioni.
  if (order.status !== "pending") {
    return { canConfirm: true, requiresExceptions: false, reason: null, allocations: [] as TransferAllocation[], exceptionItems: [] as FulfillmentExceptionPreview[] };
  }

  const { warehouse, companyName } = await getWarehouseAndRetailerLocation(database, order);
  const items = await loadItems(database, order.id);
  try {
    const productIds = Array.from(new Set(items.map((item) => item.productId)));
    const [inventory, counterpartyAvailablePiecesByProduct] = await Promise.all([
      loadCentralInventory(database, order.companyId, warehouse.id, productIds),
      loadCounterpartyCentralAvailability(database, order.companyId, productIds),
    ]);
    const exceptionItems = buildFulfillmentExceptionPreviews(items, inventory);
    if (exceptionItems.length > 0) {
      return {
        canConfirm: false,
        requiresExceptions: true,
        reason: "Sono presenti righe con lotto storico non evadibile: un amministratore deve scegliere un'opzione per ogni riga.",
        allocations: [] as TransferAllocation[],
        exceptionItems,
      };
    }
    const plan = buildAllocationPlan({
      items,
      inventories: inventory,
      companyName,
      counterpartyAvailablePiecesByProduct,
    });
    return {
      canConfirm: true,
      requiresExceptions: false,
      reason: null,
      allocations: Array.from(plan.allocations.values()).flat().filter((allocation) => !items.find((item) => item.id === allocation.sourceItemId)?.batchId).sort(compareAllocations),
      exceptionItems: [] as FulfillmentExceptionPreview[],
    };
  } catch (error) {
    return {
      canConfirm: false,
      requiresExceptions: false,
      reason: error instanceof Error ? error.message : "Impossibile preparare la consegna.",
      allocations: [] as TransferAllocation[],
      exceptionItems: [] as FulfillmentExceptionPreview[],
    };
  }
}

export async function executeOrderFulfillment(input: {
  orderId: string;
  companyId: string;
  actorUserId: string;
  targetStatus: FulfillmentTarget;
  source: FulfillmentSource;
  exceptions?: FulfillmentExceptionSelection[];
}) {
  const database = await getDb();
  if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  const requestedExceptions = input.exceptions ?? [];
  const selectionByItemId = new Map<string, FulfillmentExceptionSelection>();
  for (const selection of requestedExceptions) {
    const reason = selection.reason.trim();
    if (!reason || reason.length > 2_000) {
      throw fulfillmentError("Ogni eccezione di evasione richiede un motivo tra 1 e 2.000 caratteri.");
    }
    if (selectionByItemId.has(selection.orderItemId)) {
      throw fulfillmentError("La stessa riga ordine non può avere due eccezioni di evasione.");
    }
    selectionByItemId.set(selection.orderItemId, { ...selection, reason });
  }
  if (requestedExceptions.length > 0 && input.targetStatus !== "delivered") {
    throw fulfillmentError("Le eccezioni di evasione sono consentite solo dalla conferma amministrativa di consegna.");
  }

  return await database.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        retailerId: orders.retailerId,
        companyId: orders.companyId,
        status: orders.status,
        eventType: orders.eventType,
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
    if (order.eventType) {
      throw fulfillmentError("Ordine evento: usare il flusso di consegna dedicato.");
    }
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
    if (STATUS_INDEX[currentStatus] > STATUS_INDEX[input.targetStatus]) {
      throw fulfillmentError(`L'ordine è già oltre lo step richiesto (${currentStatus}).`);
    }
    if (selectionByItemId.size > 0 && currentStatus !== "pending") {
      throw fulfillmentError("Le eccezioni di evasione possono essere applicate solo prima del primo trasferimento.");
    }

    const items = await loadItems(tx, order.id, true);
    if (items.length === 0) throw fulfillmentError("L'ordine non contiene righe da trasferire.");
    let effectiveTransfers: TransferAllocation[] = [];
    const noStockMovementItemIds = new Set<string>();
    let effectiveSource = input.source;

    // Il trasferimento fisico avviene una sola volta, all'uscita da pending.
    // Gli step successivi riusano lo stesso service ma non ri-scaricano stock.
    if (currentStatus === "pending") {
      const { warehouse, retailerLocation, companyName } = await getWarehouseAndRetailerLocation(tx, order);
      const productIds = Array.from(new Set(items.map((item) => item.productId)));
      const [inventory, counterpartyAvailablePiecesByProduct] = await Promise.all([
        loadCentralInventory(tx, order.companyId, warehouse.id, productIds, true),
        loadCounterpartyCentralAvailability(tx, order.companyId, productIds),
      ]);
      const exceptionPreviews = buildFulfillmentExceptionPreviews(items, inventory);
      const previewByItemId = new Map(exceptionPreviews.map((item) => [item.orderItemId, item]));

      if (selectionByItemId.size > 0 || exceptionPreviews.length > 0) {
        if (selectionByItemId.size !== exceptionPreviews.length) {
          throw fulfillmentError("Scegli un'opzione amministrativa per ogni riga con lotto non evadibile.");
        }
        for (const [orderItemId, selection] of Array.from(selectionByItemId.entries())) {
          const preview = previewByItemId.get(orderItemId);
          if (!preview) {
            throw fulfillmentError("L'eccezione selezionata non corrisponde a una riga non evadibile dell'ordine.");
          }
          if (
            (selection.exceptionType === "reallocated" && !preview.reallocated.available)
            || (selection.exceptionType === "no_stock_movement" && !preview.noStockMovement.available)
          ) {
            throw fulfillmentError(`L'opzione selezionata non è disponibile per ${preview.productName}.`);
          }
        }
      }

      const reallocatedItemIds = new Set(
        Array.from(selectionByItemId.values())
          .filter((selection) => selection.exceptionType === "reallocated")
          .map((selection) => selection.orderItemId),
      );
      for (const selection of Array.from(selectionByItemId.values())) {
        if (selection.exceptionType === "no_stock_movement") {
          noStockMovementItemIds.add(selection.orderItemId);
        }
      }
      const plan = buildAllocationPlan({
        items,
        inventories: inventory,
        companyName,
        counterpartyAvailablePiecesByProduct,
        reallocatedItemIds,
        excludedItemIds: noStockMovementItemIds,
      });

      if (selectionByItemId.size > 0) {
        const exceptionsToInsert = Array.from(selectionByItemId.values()).map((selection) => {
          const preview = previewByItemId.get(selection.orderItemId)!;
          const replacementAllocations = selection.exceptionType === "reallocated"
            ? (plan.allocations.get(selection.orderItemId) ?? []).map((allocation) => ({
              batchId: allocation.batchId,
              batchNumber: allocation.batchNumber,
              expirationDate: allocation.expirationDate,
              quantityPackages: allocation.quantityPackages,
              quantityPieces: allocation.quantityPieces,
            }))
            : [];
          if (selection.exceptionType === "reallocated" && replacementAllocations.length === 0) {
            throw new Error(`Piano FEFO mancante per la riallocazione della riga ${selection.orderItemId}.`);
          }
          return {
            companyId: order.companyId,
            orderId: order.id,
            orderItemId: preview.orderItemId,
            productId: preview.productId,
            originalBatchId: preview.originalBatchId,
            originalBatchNumberSnapshot: preview.originalBatchNumber,
            originalBatchExpirationSnapshot: preview.originalBatchExpirationDate,
            productSkuSnapshot: preview.productSku,
            productNameSnapshot: preview.productName,
            piecesPerUnitSnapshot: items.find((item) => item.id === preview.orderItemId)!.piecesPerUnit,
            quantityPackages: preview.quantityPackages,
            quantityPieces: preview.quantityPieces,
            originalBatchQuantityAtAction: preview.originalBatchQuantity,
            productCentralQuantityAtAction: preview.productCentralQuantity,
            exceptionType: selection.exceptionType,
            replacementAllocations,
            reason: selection.reason,
            actorUserId: input.actorUserId,
          };
        });
        await tx.insert(orderItemFulfillmentExceptions).values(exceptionsToInsert);
        effectiveSource = "delivery_exception";
      }

      await replaceRowsForFefo(tx, { items, allocations: plan.allocations, reallocatedItemIds });

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
      const itemsForLabels = (await loadItems(tx, order.id)).filter((item) => !noStockMovementItemIds.has(item.id));
      await consumeLabelsAtomically(tx, {
        items: itemsForLabels,
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
        source: effectiveSource,
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
