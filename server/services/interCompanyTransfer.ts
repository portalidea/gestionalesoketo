/**
 * M11.D — Inter-company stock loading service.
 *
 * When an order from E-Keto Food to retailer "Soketo Srl" (d2955b43)
 * is transferred (startTransfer), this service automatically loads
 * the same products into SoKeto company's central warehouse.
 *
 * For each transferred item:
 * 1. Find or create a productBatch on SoKeto with same batchNumber + productId
 * 2. Upsert inventoryByBatch on SoKeto's central warehouse
 * 3. Record an IN stock movement on SoKeto
 *
 * costPrice = products.costPrice (anagrafico) × (1 + INTERCOMPANY_MARKUP)
 * NOT productBatches.costPrice (often 0 for DDT batches).
 */
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  productBatches,
  inventoryByBatch,
  stockMovements,
  products,
  locations,
} from "../../drizzle/schema";
import {
  INTERCOMPANY_MARKUP,
  SOKETO_SRL_RETAILER_ID,
  SOKETO_COMPANY_ID,
} from "../../shared/const";

export interface InterCompanyLoadInput {
  orderId: string;
  orderNumber: string | null;
  items: Array<{
    productId: string;
    batchId: string; // E-Keto source batch
    quantity: number; // in pieces (already converted)
    productName: string;
  }>;
  createdBy: string;
}

export interface InterCompanyLoadResult {
  loaded: Array<{
    productName: string;
    batchNumber: string;
    quantity: number;
    costPrice: string;
    isNewBatch: boolean;
  }>;
  warnings: string[];
}

/**
 * Check if an order targets the inter-company retailer (Soketo Srl).
 */
export function isInterCompanyOrder(retailerId: string | null): boolean {
  return retailerId === SOKETO_SRL_RETAILER_ID;
}

/**
 * Execute the inter-company stock loading for all items in an order.
 * Must be called within the same transaction context as the E-Keto discharge
 * to ensure atomicity.
 */
export async function loadInterCompanyStock(
  input: InterCompanyLoadInput,
): Promise<InterCompanyLoadResult> {
  const db = await getDb();
  if (!db) throw new Error("[M11.D] Database not available");

  const result: InterCompanyLoadResult = { loaded: [], warnings: [] };

  // Get SoKeto central warehouse location
  const [soketoWarehouse] = await db
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.type, "central_warehouse"),
        eq(locations.companyId, SOKETO_COMPANY_ID),
      ),
    )
    .limit(1);

  if (!soketoWarehouse) {
    throw new Error(
      "[M11.D] Magazzino Centrale SoKeto non trovato (companyId=" +
        SOKETO_COMPANY_ID +
        ")",
    );
  }

  return await db.transaction(async (tx) => {
    for (const item of input.items) {
      // 1. Get source batch info (batchNumber, expirationDate, producerId)
      const [sourceBatch] = await tx
        .select({
          batchNumber: productBatches.batchNumber,
          expirationDate: productBatches.expirationDate,
          producerId: productBatches.producerId,
        })
        .from(productBatches)
        .where(eq(productBatches.id, item.batchId));

      if (!sourceBatch) {
        result.warnings.push(
          `[M11.D] Lotto sorgente ${item.batchId} non trovato — skip carico per ${item.productName}`,
        );
        continue;
      }

      // 2. Get product costPrice (anagrafico)
      const [product] = await tx
        .select({ costPrice: products.costPrice })
        .from(products)
        .where(eq(products.id, item.productId));

      const rawCostPrice = parseFloat(product?.costPrice ?? "0");
      if (rawCostPrice === 0) {
        result.warnings.push(
          `[M11.D] WARNING: costPrice anagrafico = 0 per ${item.productName} (productId=${item.productId}). Batch SoKeto creato a costo 0.`,
        );
        console.warn(
          `[M11.D] costPrice=0 for product ${item.productId} (${item.productName})`,
        );
      }
      const soketoCostPrice = (rawCostPrice * (1 + INTERCOMPANY_MARKUP)).toFixed(4);

      // 3. Find or create SoKeto batch with same batchNumber + productId + companyId
      const existingBatches = await tx
        .select({ id: productBatches.id })
        .from(productBatches)
        .where(
          and(
            eq(productBatches.productId, item.productId),
            eq(productBatches.batchNumber, sourceBatch.batchNumber),
            eq(productBatches.companyId, SOKETO_COMPANY_ID),
          ),
        )
        .limit(1);

      let soketoBatchId: string;
      let isNewBatch = false;

      if (existingBatches.length > 0) {
        soketoBatchId = existingBatches[0].id;
      } else {
        // Create new batch on SoKeto
        const [newBatch] = await tx
          .insert(productBatches)
          .values({
            productId: item.productId,
            batchNumber: sourceBatch.batchNumber,
            expirationDate: sourceBatch.expirationDate,
            initialQuantity: item.quantity,
            costPrice: soketoCostPrice,
            companyId: SOKETO_COMPANY_ID,
            producerId: sourceBatch.producerId,
            notes: `Carico automatico inter-company da E-Keto (ordine ${input.orderNumber ?? input.orderId})`,
          })
          .returning({ id: productBatches.id });
        soketoBatchId = newBatch.id;
        isNewBatch = true;
      }

      // 4. Upsert inventoryByBatch on SoKeto central warehouse
      const existingInventory = await tx
        .select({ id: inventoryByBatch.id, quantity: inventoryByBatch.quantity })
        .from(inventoryByBatch)
        .where(
          and(
            eq(inventoryByBatch.locationId, soketoWarehouse.id),
            eq(inventoryByBatch.batchId, soketoBatchId),
          ),
        )
        .for("update");

      if (existingInventory.length > 0) {
        const inv = existingInventory[0];
        await tx
          .update(inventoryByBatch)
          .set({
            quantity: inv.quantity + item.quantity,
            updatedAt: new Date(),
          })
          .where(eq(inventoryByBatch.id, inv.id));
      } else {
        await tx.insert(inventoryByBatch).values({
          locationId: soketoWarehouse.id,
          batchId: soketoBatchId,
          quantity: item.quantity,
          companyId: SOKETO_COMPANY_ID,
        });
      }

      // 5. Record stock movement IN on SoKeto
      await tx.insert(stockMovements).values({
        productId: item.productId,
        type: "IN",
        quantity: item.quantity,
        previousQuantity: existingInventory.length > 0 ? existingInventory[0].quantity : 0,
        newQuantity:
          (existingInventory.length > 0 ? existingInventory[0].quantity : 0) +
          item.quantity,
        batchId: soketoBatchId,
        toLocationId: soketoWarehouse.id,
        notes: `Carico automatico transfer inter-company da E-Keto ordine ${input.orderNumber ?? input.orderId}`,
        notesInternal: `[M11.D] Auto-load from E-Keto order ${input.orderId}, source batch ${item.batchId}, qty ${item.quantity} pz, costPrice ${soketoCostPrice}`,
        createdBy: input.createdBy,
        companyId: SOKETO_COMPANY_ID,
      });

      result.loaded.push({
        productName: item.productName,
        batchNumber: sourceBatch.batchNumber,
        quantity: item.quantity,
        costPrice: soketoCostPrice,
        isNewBatch,
      });
    }

    return result;
  });
}

/**
 * M11.D — Reverse inter-company stock loading when an order is cancelled
 * after transfer. Creates OUT movements and decrements SoKeto inventory.
 */
export async function reverseInterCompanyStock(input: {
  orderId: string;
  orderNumber: string | null;
  items: Array<{
    productId: string;
    batchId: string; // E-Keto source batch
    quantity: number; // in pieces
    productName: string;
  }>;
  createdBy: string;
}): Promise<{ reversed: string[]; warnings: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("[M11.D] Database not available");

  const reversed: string[] = [];
  const warnings: string[] = [];

  // Get SoKeto central warehouse
  const [soketoWarehouse] = await db
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.type, "central_warehouse"),
        eq(locations.companyId, SOKETO_COMPANY_ID),
      ),
    )
    .limit(1);

  if (!soketoWarehouse) {
    warnings.push("[M11.D] Magazzino Centrale SoKeto non trovato — impossibile stornare");
    return { reversed, warnings };
  }

  await db.transaction(async (tx) => {
    for (const item of input.items) {
      // Find source batch info
      const [sourceBatch] = await tx
        .select({ batchNumber: productBatches.batchNumber })
        .from(productBatches)
        .where(eq(productBatches.id, item.batchId));

      if (!sourceBatch) {
        warnings.push(`[M11.D] Lotto sorgente ${item.batchId} non trovato — skip storno ${item.productName}`);
        continue;
      }

      // Find corresponding SoKeto batch
      const [soketoBatch] = await tx
        .select({ id: productBatches.id })
        .from(productBatches)
        .where(
          and(
            eq(productBatches.productId, item.productId),
            eq(productBatches.batchNumber, sourceBatch.batchNumber),
            eq(productBatches.companyId, SOKETO_COMPANY_ID),
          ),
        )
        .limit(1);

      if (!soketoBatch) {
        warnings.push(
          `[M11.D] Batch SoKeto per ${item.productName} (${sourceBatch.batchNumber}) non trovato — skip storno`,
        );
        continue;
      }

      // Decrement inventory
      const [inv] = await tx
        .select({ id: inventoryByBatch.id, quantity: inventoryByBatch.quantity })
        .from(inventoryByBatch)
        .where(
          and(
            eq(inventoryByBatch.locationId, soketoWarehouse.id),
            eq(inventoryByBatch.batchId, soketoBatch.id),
          ),
        )
        .for("update");

      if (!inv) {
        warnings.push(
          `[M11.D] Inventario SoKeto per batch ${sourceBatch.batchNumber} non trovato — skip storno`,
        );
        continue;
      }

      const newQty = Math.max(0, inv.quantity - item.quantity);
      await tx
        .update(inventoryByBatch)
        .set({ quantity: newQty, updatedAt: new Date() })
        .where(eq(inventoryByBatch.id, inv.id));

      // Record OUT movement
      await tx.insert(stockMovements).values({
        productId: item.productId,
        type: "OUT",
        quantity: item.quantity,
        previousQuantity: inv.quantity,
        newQuantity: newQty,
        batchId: soketoBatch.id,
        fromLocationId: soketoWarehouse.id,
        notes: `Storno automatico transfer inter-company — annullamento ordine E-Keto ${input.orderNumber ?? input.orderId}`,
        notesInternal: `[M11.D] Reversal for cancelled E-Keto order ${input.orderId}`,
        createdBy: input.createdBy,
        companyId: SOKETO_COMPANY_ID,
      });

      reversed.push(`${item.productName}: -${item.quantity} pz (batch ${sourceBatch.batchNumber})`);
    }
  });

  return { reversed, warnings };
}
