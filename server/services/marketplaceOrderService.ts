/**
 * M8.1 — Marketplace Order Service
 * Gestisce import idempotente e consumo FEFO per ordini marketplace.
 *
 * Principi di sicurezza:
 * - il cutoff Shopify viene applicato nel servizio, non nella sola UI;
 * - inventoryByBatch e stockMovements sono aggiornati nella stessa transazione;
 * - ogni movimento marketplace è scoped alla company dello store.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  channelVariantComponents,
  channelVariants,
  inventoryByBatch,
  locations,
  marketplaceOrderItems,
  marketplaceOrders,
  productBatches,
  salesStores,
  stockMovements,
} from "../../drizzle/schema";
import type { ShopifyOrder } from "./shopifyService";

type ImportStatus = "imported" | "duplicate" | "skipped_before_cutoff" | "skipped_missing_cutoff";
type StockProcessingStatus = "processed" | "partial" | "failed" | "skipped";

type ActiveShopifyStore = {
  id: string;
  name: string;
  storeIdentifier: string;
  apiCredentials: unknown;
  companyId: string | null;
  lastSyncAt: Date | null;
  orderImportStartDate: string | null;
};

export type ShopifyScheduledSyncStoreResult = {
  storeId: string;
  storeName: string;
  companyId: string | null;
  cutoffDate: string | null;
  fetchStart: string | null;
  gapRecovered: {
    lastSuccessfulSyncAt: string;
    gapStart: string;
    gapEnd: string;
    elapsedHours: number;
  } | null;
  gapTooLarge: {
    lastSuccessfulSyncAt: string;
    gapStart: string;
    gapEnd: string;
    elapsedHours: number;
  } | null;
  lastSyncAtUpdated: boolean;
  fetched: number;
  imported: number;
  duplicates: number;
  skippedBeforeCutoff: number;
  skippedMissingCutoff: number;
  notStarted: boolean;
  processedStock: number;
  failedStock: number;
  errors: Array<{ orderId: string; error: string }>;
};

export type ShopifyScheduledSyncResult = {
  executedAt: string;
  stores: ShopifyScheduledSyncStoreResult[];
};

export type ShopifyOrderFetchParams = {
  createdAtMin: string;
  financialStatus: "paid";
};

export type ShopifyOrdersFetcher = (
  store: ActiveShopifyStore,
  params: ShopifyOrderFetchParams,
) => Promise<ShopifyOrder[]>;

const BUSINESS_TIME_ZONE = "Europe/Rome";

function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} deve avere formato YYYY-MM-DD`);
  }
  return value;
}

/** Shopify restituisce created_at con offset dello store: il prefisso data è
 * la data commerciale che deve essere confrontata con il cutoff configurato. */
export function isShopifyOrderBeforeImportCutoff(createdAt: string, cutoffDate: string): boolean {
  const orderBusinessDate = assertIsoDate(createdAt.slice(0, 10), "created_at Shopify");
  return orderBusinessDate < assertIsoDate(cutoffDate, "orderImportStartDate");
}

/** Per gli ordini già persistiti usiamo esplicitamente il calendario italiano,
 * così retry e chiamate dirette non possono riattivare il pregresso pre-cutoff. */
export function isPersistedMarketplaceOrderBeforeImportCutoff(orderDate: Date, cutoffDate: string): boolean {
  const orderBusinessDate = getBusinessDateInRome(orderDate);
  return orderBusinessDate < assertIsoDate(cutoffDate, "orderImportStartDate");
}

function getBusinessDateInRome(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * La query Shopify riceve un timestamp UTC. La finestra parte dal cutoff e,
 * dopo il primo run, riprende dall'ultimo sync con 48 ore di sovrapposizione.
 * I duplicati sono sicuri per il vincolo (storeId, channelOrderId), mentre la
 * sovrapposizione cattura pagamenti registrati in ritardo. Se il fetch fallisce
 * lastSyncAt non viene aggiornato e il run successivo recupera il periodo.
 */
const NORMAL_OVERLAP_MS = 48 * 60 * 60 * 1000;
const MAX_AUTOMATIC_GAP_MS = 7 * 24 * 60 * 60 * 1000;

function getScheduledSyncWindow(store: ActiveShopifyStore, now: Date): {
  fetchStart: string;
  gapRecovered: ShopifyScheduledSyncStoreResult["gapRecovered"];
  gapTooLarge: ShopifyScheduledSyncStoreResult["gapTooLarge"];
} {
  if (!store.orderImportStartDate) throw new Error("orderImportStartDate non configurata");
  const cutoffStart = getRomeMidnightAsUtc(store.orderImportStartDate);
  if (!store.lastSyncAt) return { fetchStart: cutoffStart.toISOString(), gapRecovered: null, gapTooLarge: null };

  const elapsedMs = Math.max(0, now.getTime() - store.lastSyncAt.getTime());
  const gap = {
    lastSuccessfulSyncAt: store.lastSyncAt.toISOString(),
    gapStart: store.lastSyncAt.toISOString(),
    gapEnd: now.toISOString(),
    elapsedHours: Number((elapsedMs / (60 * 60 * 1000)).toFixed(2)),
  };
  if (elapsedMs > MAX_AUTOMATIC_GAP_MS) {
    return { fetchStart: cutoffStart.toISOString(), gapRecovered: null, gapTooLarge: gap };
  }

  // Anche nel recupero manteniamo 48 ore di sovrapposizione: l’intervallo
  // scoperto è interamente coperto, mentre pagamenti Shopify tardivi restano
  // protetti dal vincolo idempotente dell’import.
  const overlappedLastSync = new Date(store.lastSyncAt.getTime() - NORMAL_OVERLAP_MS);
  return {
    fetchStart: new Date(Math.max(cutoffStart.getTime(), overlappedLastSync.getTime())).toISOString(),
    gapRecovered: elapsedMs > NORMAL_OVERLAP_MS ? gap : null,
    gapTooLarge: null,
  };
}

function getRomeMidnightAsUtc(date: string): Date {
  const [year, month, day] = assertIsoDate(date, "orderImportStartDate").split("-").map(Number);
  const utcMidnightGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetAt = (instant: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant.getTime();
  };
  // Il secondo passaggio gestisce correttamente la data successiva al cambio
  // dell'ora legale, quando l'offset a 00:00 UTC differisce da quello locale.
  const firstCandidate = new Date(utcMidnightGuess.getTime() - offsetAt(utcMidnightGuess));
  return new Date(utcMidnightGuess.getTime() - offsetAt(firstCandidate));
}

async function fetchAllPaidOrdersFromShopify(
  store: ActiveShopifyStore,
  params: ShopifyOrderFetchParams,
): Promise<ShopifyOrder[]> {
  const accessToken = (store.apiCredentials as { accessToken?: string } | null)?.accessToken;
  if (!accessToken) throw new Error("Store Shopify senza accessToken configurato");
  const { ShopifyClient } = await import("./shopifyService");
  const client = new ShopifyClient(store.storeIdentifier, accessToken);
  let response = await client.fetchOrders({
    createdAtMin: params.createdAtMin,
    financialStatus: params.financialStatus,
    status: "any",
    limit: 50,
  });
  const orders = [...response.orders];
  while (response.nextPageInfo) {
    response = await client.fetchOrdersByPageInfo(response.nextPageInfo, 50);
    orders.push(...response.orders);
  }
  return orders;
}

/**
 * Esegue l'import deterministico per tutti gli store Shopify attivi.
 * Il fetcher è iniettabile esclusivamente per i test isolati; in produzione
 * usa Shopify Admin REST. Non aggiorna lastSyncAt quando il fetch API fallisce.
 */
export async function runScheduledShopifyOrderSync(input: {
  now?: Date;
  fetchOrders?: ShopifyOrdersFetcher;
} = {}): Promise<ShopifyScheduledSyncResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = input.now ?? new Date();
  const stores = await db
    .select({
      id: salesStores.id,
      name: salesStores.name,
      storeIdentifier: salesStores.storeIdentifier,
      apiCredentials: salesStores.apiCredentials,
      companyId: salesStores.companyId,
      lastSyncAt: salesStores.lastSyncAt,
      orderImportStartDate: salesStores.orderImportStartDate,
    })
    .from(salesStores)
    .where(and(eq(salesStores.channel, "shopify"), eq(salesStores.isActive, true)));

  const results: ShopifyScheduledSyncStoreResult[] = [];
  for (const store of stores) {
    const result: ShopifyScheduledSyncStoreResult = {
      storeId: store.id,
      storeName: store.name,
      companyId: store.companyId,
      cutoffDate: store.orderImportStartDate,
      fetchStart: null,
      gapRecovered: null,
      gapTooLarge: null,
      lastSyncAtUpdated: false,
      fetched: 0,
      imported: 0,
      duplicates: 0,
      skippedBeforeCutoff: 0,
      skippedMissingCutoff: 0,
      notStarted: false,
      processedStock: 0,
      failedStock: 0,
      errors: [],
    };
    results.push(result);

    if (!store.orderImportStartDate) {
      result.skippedMissingCutoff = 1;
      result.errors.push({ orderId: "store", error: "orderImportStartDate non configurata: sync Shopify bloccato in sicurezza" });
      continue;
    }
    if (getBusinessDateInRome(now) < store.orderImportStartDate) {
      result.notStarted = true;
      result.errors.push({ orderId: "store", error: `Sync Shopify non avviata: cutoff ${store.orderImportStartDate} non ancora raggiunto` });
      continue;
    }

    const syncWindow = getScheduledSyncWindow(store, now);
    result.fetchStart = syncWindow.fetchStart;
    result.gapRecovered = syncWindow.gapRecovered;
    result.gapTooLarge = syncWindow.gapTooLarge;
    if (syncWindow.gapTooLarge) {
      result.errors.push({
        orderId: "store",
        error: `Gap Shopify di ${syncWindow.gapTooLarge.elapsedHours} ore dal ${syncWindow.gapTooLarge.gapStart}: supera il limite automatico di 7 giorni; nessun import eseguito, intervento manuale richiesto`,
      });
      continue;
    }

    let orders: ShopifyOrder[];
    try {
      const fetchParams = { createdAtMin: syncWindow.fetchStart, financialStatus: "paid" as const };
      orders = input.fetchOrders
        ? await input.fetchOrders(store, fetchParams)
        : await fetchAllPaidOrdersFromShopify(store, fetchParams);
      result.fetched = orders.length;
    } catch (error: any) {
      result.errors.push({ orderId: "store", error: `Fetch Shopify fallito: ${error.message}` });
      continue;
    }

    for (const shopifyOrder of orders) {
      try {
        const importResult = await importShopifyOrder(store.id, shopifyOrder);
        if (importResult.status === "duplicate") {
          const [existingOrder] = await db
            .select({ stockProcessingStatus: marketplaceOrders.stockProcessingStatus, stockProcessingError: marketplaceOrders.stockProcessingError })
            .from(marketplaceOrders)
            .where(eq(marketplaceOrders.id, importResult.marketplaceOrderId!))
            .limit(1);
          if (existingOrder?.stockProcessingStatus === "processed") {
            result.duplicates++;
          } else {
            result.failedStock++;
            result.errors.push({
              orderId: String(shopifyOrder.order_number),
              error: `Ordine Shopify già importato ma non elaborato con successo (stato ${existingOrder?.stockProcessingStatus || "sconosciuto"}): ${existingOrder?.stockProcessingError || "watermark non avanzato"}`,
            });
          }
          continue;
        }
        if (importResult.status === "skipped_before_cutoff") {
          result.skippedBeforeCutoff++;
          continue;
        }
        if (importResult.status === "skipped_missing_cutoff") {
          result.skippedMissingCutoff++;
          continue;
        }
        if (!importResult.marketplaceOrderId) {
          result.failedStock++;
          result.errors.push({ orderId: String(shopifyOrder.order_number), error: importResult.reason || "Import senza ID ordine" });
          continue;
        }
        result.imported++;
        const stockResult = await processStockForMarketplaceOrder(importResult.marketplaceOrderId, store.companyId ?? undefined);
        if (stockResult.status === "processed") result.processedStock++;
        else {
          result.failedStock++;
          result.errors.push({ orderId: String(shopifyOrder.order_number), error: stockResult.errors.join("; ") });
        }
      } catch (error: any) {
        result.failedStock++;
        result.errors.push({ orderId: String(shopifyOrder.order_number || shopifyOrder.id), error: error.message });
      }
    }

    // Il watermark avanza solo se TUTTI gli ordini in finestra sono stati
    // importati e processati. In caso contrario il prossimo run riapre la
    // finestra dall’ultimo sync riuscito, invece di perdere gli ordini falliti.
    if (result.failedStock === 0) {
      await db
        .update(salesStores)
        .set({ lastSyncAt: now, updatedAt: now })
        .where(eq(salesStores.id, store.id));
      result.lastSyncAtUpdated = true;
    } else {
      result.errors.push({
        orderId: "store",
        error: "lastSyncAt invariato: almeno un ordine della finestra non è stato importato e processato con successo",
      });
    }
  }

  return { executedAt: now.toISOString(), stores: results };
}

async function setMarketplaceOrderStatus(
  marketplaceOrderId: string,
  status: StockProcessingStatus,
  error: string | null,
  incrementAttempts = true,
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(marketplaceOrders)
    .set({
      stockProcessingStatus: status,
      stockProcessedAt: status === "processed" ? new Date() : null,
      stockProcessingError: error,
      ...(incrementAttempts ? { stockProcessingAttempts: sql`"stockProcessingAttempts" + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(marketplaceOrders.id, marketplaceOrderId));
}

// ─── Import Order ────────────────────────────────────────────────────────────

export async function importShopifyOrder(
  storeId: string,
  shopifyOrder: ShopifyOrder,
): Promise<{
  marketplaceOrderId: string | null;
  status: ImportStatus;
  reason?: string;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Fail closed: un cutoff assente non consente import e quindi non consente
  // alcun possibile scarico. Il controllo è qui, a monte della persistenza.
  const [store] = await db
    .select({ channel: salesStores.channel, orderImportStartDate: salesStores.orderImportStartDate })
    .from(salesStores)
    .where(eq(salesStores.id, storeId))
    .limit(1);
  if (!store) throw new Error(`Store ${storeId} not found`);
  if (store.channel !== "shopify") throw new Error(`Store ${storeId} is not Shopify`);
  if (!store.orderImportStartDate) {
    return {
      marketplaceOrderId: null,
      status: "skipped_missing_cutoff",
      reason: "orderImportStartDate non configurata: import Shopify bloccato in sicurezza",
    };
  }
  if (isShopifyOrderBeforeImportCutoff(shopifyOrder.created_at, store.orderImportStartDate)) {
    return {
      marketplaceOrderId: null,
      status: "skipped_before_cutoff",
      reason: `Ordine Shopify ${shopifyOrder.created_at.slice(0, 10)} precedente al cutoff ${store.orderImportStartDate}`,
    };
  }

  const channelOrderId = String(shopifyOrder.id);

  const existing = await db
    .select({ id: marketplaceOrders.id })
    .from(marketplaceOrders)
    .where(and(eq(marketplaceOrders.storeId, storeId), eq(marketplaceOrders.channelOrderId, channelOrderId)))
    .limit(1);

  if (existing.length > 0) {
    console.log(`[marketplaceOrderService.import] duplicate: storeId=${storeId} orderId=${channelOrderId}`);
    return { marketplaceOrderId: existing[0].id, status: "duplicate" };
  }

  const customerName = shopifyOrder.customer
    ? [shopifyOrder.customer.first_name, shopifyOrder.customer.last_name].filter(Boolean).join(" ") || null
    : null;
  const skus = shopifyOrder.line_items.map((line) => line.sku).filter((sku): sku is string => !!sku);
  const variantMap = new Map<string, { id: string; productId: string | null; multiplier: number }>();

  if (skus.length > 0) {
    const variants = await db
      .select({ id: channelVariants.id, channelSku: channelVariants.channelSku, productId: channelVariants.productId, multiplier: channelVariants.multiplier })
      .from(channelVariants)
      .where(and(eq(channelVariants.storeId, storeId), inArray(channelVariants.channelSku, skus), eq(channelVariants.isActive, true)));
    for (const variant of variants) {
      variantMap.set(variant.channelSku, { id: variant.id, productId: variant.productId, multiplier: variant.multiplier });
    }
  }

  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(marketplaceOrders)
      .values({
        storeId,
        channelOrderId,
        channelOrderNumber: String(shopifyOrder.order_number),
        customerEmail: shopifyOrder.email || null,
        customerName,
        orderDate: new Date(shopifyOrder.created_at),
        totalGross: shopifyOrder.total_price,
        currency: shopifyOrder.currency,
        shippingCountry: shopifyOrder.shipping_address?.country_code || null,
        rawPayload: shopifyOrder as unknown as Record<string, unknown>,
        stockProcessingStatus: "pending",
      })
      .returning();

    const itemValues = shopifyOrder.line_items.map((line) => {
      const sku = line.sku || `unknown_${line.id}`;
      const variant = variantMap.get(sku);
      const multiplier = variant?.multiplier ?? 1;
      return {
        marketplaceOrderId: order.id,
        channelSku: sku,
        productId: variant?.productId || null,
        channelVariantId: variant?.id || null,
        channelQuantity: line.quantity,
        piecesQuantity: line.quantity * multiplier,
        unitPrice: line.price,
        lineTotal: (parseFloat(line.price) * line.quantity).toFixed(2),
        displayName: line.name,
      };
    });
    if (itemValues.length > 0) await tx.insert(marketplaceOrderItems).values(itemValues);
    return order;
  });

  console.log(`[marketplaceOrderService.import] imported: marketplaceOrderId=${result.id} channelOrderId=${channelOrderId}`);
  return { marketplaceOrderId: result.id, status: "imported" };
}

// ─── Process Stock (FEFO) ────────────────────────────────────────────────────

export async function processStockForMarketplaceOrder(
  marketplaceOrderId: string,
  companyId?: string,
): Promise<{ status: StockProcessingStatus; errors: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [order] = await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.id, marketplaceOrderId)).limit(1);
  if (!order) throw new Error(`Order ${marketplaceOrderId} not found`);
  if (order.stockProcessingStatus === "processed") {
    console.log(`[marketplaceOrderService.processStock] already processed: ${marketplaceOrderId}`);
    return { status: "processed", errors: [] };
  }
  if (order.stockProcessingStatus === "skipped") {
    return { status: "skipped", errors: [order.stockProcessingError || "Ordine marketplace già escluso"] };
  }

  const [store] = await db
    .select({ channel: salesStores.channel, companyId: salesStores.companyId, orderImportStartDate: salesStores.orderImportStartDate })
    .from(salesStores)
    .where(eq(salesStores.id, order.storeId))
    .limit(1);
  if (!store) throw new Error(`Store ${order.storeId} not found`);

  if (store.channel === "shopify") {
    if (!store.orderImportStartDate) {
      const message = "orderImportStartDate non configurata: scarico Shopify bloccato in sicurezza";
      await setMarketplaceOrderStatus(marketplaceOrderId, "skipped", message, false);
      return { status: "skipped", errors: [message] };
    }
    if (isPersistedMarketplaceOrderBeforeImportCutoff(order.orderDate, store.orderImportStartDate)) {
      const message = `Ordine Shopify precedente al cutoff ${store.orderImportStartDate}: nessuno scarico applicato`;
      await setMarketplaceOrderStatus(marketplaceOrderId, "skipped", message, false);
      return { status: "skipped", errors: [message] };
    }
  }

  const resolvedCompanyId = companyId ?? store.companyId ?? undefined;
  if (!resolvedCompanyId) {
    const message = "Store marketplace senza companyId: scarico bloccato in sicurezza";
    await setMarketplaceOrderStatus(marketplaceOrderId, "failed", message);
    return { status: "failed", errors: [message] };
  }

  try {
    return await db.transaction(async (tx) => {
      const [warehouse] = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.type, "central_warehouse"), eq(locations.companyId, resolvedCompanyId)))
        .limit(1);
      if (!warehouse) throw new Error("Magazzino centrale non configurato");

      const items = await tx.select().from(marketplaceOrderItems).where(eq(marketplaceOrderItems.marketplaceOrderId, marketplaceOrderId));
      const errors: string[] = [];
      let processedCount = 0;

      for (const item of items) {
        try {
          let variant: { id: string; productId: string | null; multiplier: number; isBundle: boolean } | null = null;
          if (item.channelVariantId) {
            const [loadedVariant] = await tx
              .select({ id: channelVariants.id, productId: channelVariants.productId, multiplier: channelVariants.multiplier, isBundle: channelVariants.isBundle })
              .from(channelVariants)
              .where(eq(channelVariants.id, item.channelVariantId))
              .limit(1);
            variant = loadedVariant || null;
          }

          if (variant?.isBundle) {
            const components = await tx
              .select({ productId: channelVariantComponents.productId, quantity: channelVariantComponents.quantity })
              .from(channelVariantComponents)
              .where(eq(channelVariantComponents.channelVariantId, variant.id));
            if (components.length === 0) {
              errors.push(`SKU "${item.channelSku}" (${item.displayName}): bundle senza componenti configurati`);
              continue;
            }

            let bundleOk = true;
            for (const component of components) {
              const requiredQty = component.quantity * item.channelQuantity;
              const fefoResult = await decrementStockFEFO({
                db: tx,
                productId: component.productId,
                quantity: requiredQty,
                warehouseId: warehouse.id,
                companyId: resolvedCompanyId,
                marketplaceOrderId,
                notes: `Shopify order #${order.channelOrderNumber}`,
                notesInternal: `Shopify order #${order.channelOrderNumber}, bundle ${item.displayName} component, customer: ${order.customerName || order.customerEmail || "N/A"}, SKU: ${item.channelSku}`,
              });
              if (fefoResult.shortfall > 0) {
                errors.push(`SKU "${item.channelSku}" bundle component productId=${component.productId}: stock insufficiente, mancano ${fefoResult.shortfall} pezzi`);
                bundleOk = false;
              }
            }
            if (bundleOk) processedCount++;
            continue;
          }

          if (!item.productId) {
            errors.push(`SKU "${item.channelSku}" (${item.displayName}): non mappato a prodotto interno`);
            continue;
          }
          const fefoResult = await decrementStockFEFO({
            db: tx,
            productId: item.productId,
            quantity: item.piecesQuantity,
            warehouseId: warehouse.id,
            companyId: resolvedCompanyId,
            marketplaceOrderId,
            notes: `Shopify order #${order.channelOrderNumber}`,
            notesInternal: `Shopify order #${order.channelOrderNumber}, customer: ${order.customerName || order.customerEmail || "N/A"}, SKU: ${item.channelSku}`,
          });
          if (fefoResult.shortfall > 0) {
            errors.push(`SKU "${item.channelSku}" (${item.displayName}): stock insufficiente, mancano ${fefoResult.shortfall} pezzi su ${item.piecesQuantity} richiesti`);
          } else {
            processedCount++;
          }
        } catch (error: any) {
          // Un errore di ledger è rilanciato: deve annullare l'intera transazione,
          // non trasformarsi in un ordine parzialmente scaricato senza movimento.
          throw new Error(`SKU "${item.channelSku}" (${item.displayName}): ${error.message}`);
        }
      }

      const finalStatus: StockProcessingStatus = errors.length === 0 ? "processed" : processedCount > 0 ? "partial" : "failed";
      await tx
        .update(marketplaceOrders)
        .set({
          stockProcessingStatus: finalStatus,
          stockProcessedAt: finalStatus === "processed" ? new Date() : null,
          stockProcessingError: errors.length > 0 ? errors.join("; ") : null,
          stockProcessingAttempts: sql`"stockProcessingAttempts" + 1`,
          updatedAt: new Date(),
        })
        .where(eq(marketplaceOrders.id, marketplaceOrderId));

      console.log(`[marketplaceOrderService.processStock] orderId=${marketplaceOrderId} status=${finalStatus} processed=${processedCount}/${items.length} errors=${errors.length}`);
      return { status: finalStatus, errors };
    });
  } catch (error: any) {
    const message = `Rollback atomico stock marketplace: ${error.message}`;
    await setMarketplaceOrderStatus(marketplaceOrderId, "failed", message);
    console.error(`[marketplaceOrderService.processStock] orderId=${marketplaceOrderId} ${message}`);
    return { status: "failed", errors: [message] };
  }
}

// ─── Retry Failed Orders ─────────────────────────────────────────────────────

export async function retryFailedOrders(storeId?: string): Promise<{ retried: number; succeeded: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [inArray(marketplaceOrders.stockProcessingStatus, ["failed", "partial"]), sql`"stockProcessingAttempts" < 5`];
  if (storeId) conditions.push(eq(marketplaceOrders.storeId, storeId));
  const failedOrders = await db.select({ id: marketplaceOrders.id }).from(marketplaceOrders).where(and(...conditions));
  let succeeded = 0;
  for (const order of failedOrders) {
    const result = await processStockForMarketplaceOrder(order.id);
    if (result.status === "processed") succeeded++;
  }
  console.log(`[marketplaceOrderService.retryFailed] retried=${failedOrders.length} succeeded=${succeeded}`);
  return { retried: failedOrders.length, succeeded };
}

// ─── FEFO Decrement Helper ──────────────────────────────────────────────────

interface DecrementStockFEFOParams {
  db: any;
  productId: string;
  quantity: number;
  warehouseId: string;
  companyId: string;
  marketplaceOrderId: string;
  notes: string;
  notesInternal: string;
}

async function decrementStockFEFO(params: DecrementStockFEFOParams): Promise<{ allocated: number; shortfall: number }> {
  const { db, productId, quantity, warehouseId, companyId, marketplaceOrderId, notes, notesInternal } = params;
  const availableBatches = await db
    .select({
      batchId: productBatches.id,
      batchNumber: productBatches.batchNumber,
      expirationDate: productBatches.expirationDate,
      quantity: inventoryByBatch.quantity,
      inventoryId: inventoryByBatch.id,
    })
    .from(productBatches)
    .innerJoin(inventoryByBatch, and(eq(inventoryByBatch.batchId, productBatches.id), eq(inventoryByBatch.locationId, warehouseId)))
    .where(and(eq(productBatches.productId, productId), eq(productBatches.companyId, companyId), eq(inventoryByBatch.companyId, companyId), gt(inventoryByBatch.quantity, 0)))
    .orderBy(asc(productBatches.expirationDate))
    .for("update");

  let remaining = quantity;
  for (const batch of availableBatches) {
    if (remaining <= 0) break;
    const allocatedQuantity = Math.min(remaining, batch.quantity);
    await db
      .update(inventoryByBatch)
      .set({ quantity: batch.quantity - allocatedQuantity, updatedAt: new Date() })
      .where(eq(inventoryByBatch.id, batch.inventoryId));
    await db.insert(stockMovements).values({
      productId,
      type: "SHOPIFY_EXIT",
      quantity: allocatedQuantity,
      previousQuantity: batch.quantity,
      newQuantity: batch.quantity - allocatedQuantity,
      batchId: batch.batchId,
      fromLocationId: warehouseId,
      toLocationId: null,
      marketplaceOrderId,
      notes,
      notesInternal: `${notesInternal}, batch: ${batch.batchNumber}`,
      companyId,
    });
    remaining -= allocatedQuantity;
  }
  return { allocated: quantity - remaining, shortfall: remaining };
}
