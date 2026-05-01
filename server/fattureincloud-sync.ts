/**
 * Fatture in Cloud Synchronization Service
 * Gestisce sincronizzazione prodotti, inventario e movimenti stock
 */

import * as db from "./db";
import {
  fetchProducts,
  fetchDocuments,
  mapFICProductToInternal,
  extractStockMovementsFromDocuments,
  testConnection,
} from "./fattureincloud-api";
import { refreshAccessToken, isTokenExpired, getOAuthConfig } from "./fattureincloud-oauth";

export interface SyncResult {
  success: boolean;
  productsSync: number;
  inventorySync: number;
  movementsSync: number;
  errors: string[];
}

/**
 * Sincronizza tutti i dati per un rivenditore
 */
export async function syncRetailerData(retailerId: string): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    productsSync: 0,
    inventorySync: 0,
    movementsSync: 0,
    errors: [],
  };

  try {
    // Ottieni rivenditore
    const retailer = await db.getRetailerById(retailerId);
    if (!retailer) {
      result.errors.push("Retailer not found");
      return result;
    }

    // Verifica configurazione
    if (!retailer.fattureInCloudCompanyId || !retailer.fattureInCloudAccessToken) {
      result.errors.push("Fatture in Cloud not configured for this retailer");
      return result;
    }

    // Verifica e rinnova token se necessario
    let accessToken = retailer.fattureInCloudAccessToken;
    if (
      retailer.fattureInCloudTokenExpiresAt &&
      isTokenExpired(new Date(retailer.fattureInCloudTokenExpiresAt))
    ) {
      console.log(`[Sync] Refreshing token for retailer ${retailerId}`);
      accessToken = await refreshTokenForRetailer(retailer);
    }

    const companyId = parseInt(retailer.fattureInCloudCompanyId);

    // Test connessione
    const connected = await testConnection(companyId, accessToken);
    if (!connected) {
      result.errors.push("Failed to connect to Fatture in Cloud API");
      await db.createSyncLog({
        retailerId,
        syncType: "FULL",
        status: "FAILED",
        startedAt: new Date(),
        errorMessage: "Connection test failed",
      });
      return result;
    }

    // Sincronizza prodotti
    try {
      result.productsSync = await syncProducts(retailerId, companyId, accessToken);
    } catch (error: any) {
      result.errors.push(`Products sync failed: ${error.message}`);
    }

    // Sincronizza inventario
    try {
      result.inventorySync = await syncInventory(retailerId, companyId, accessToken);
    } catch (error: any) {
      result.errors.push(`Inventory sync failed: ${error.message}`);
    }

    // Sincronizza movimenti recenti (ultimi 30 giorni)
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      result.movementsSync = await syncMovements(
        retailerId,
        companyId,
        accessToken,
        startDate.toISOString().split("T")[0],
        endDate.toISOString().split("T")[0]
      );
    } catch (error: any) {
      result.errors.push(`Movements sync failed: ${error.message}`);
    }

    // Aggiorna timestamp ultima sincronizzazione
    await db.updateRetailer(retailerId, {
      lastSyncAt: new Date(),
    });

    // Log sincronizzazione
    await db.createSyncLog({
      retailerId,
      syncType: "FULL",
      status: result.errors.length === 0 ? "SUCCESS" : "PARTIAL",
      startedAt: new Date(),
      recordsProcessed: result.productsSync + result.inventorySync + result.movementsSync,
      errorMessage:
        result.errors.length > 0
          ? `Completed with errors: ${result.errors.join(", ")}`
          : undefined,
    });

    result.success = result.errors.length === 0;
    return result;
  } catch (error: any) {
    console.error(`[Sync] Fatal error for retailer ${retailerId}:`, error);
    result.errors.push(`Fatal error: ${error.message}`);

    await db.createSyncLog({
      retailerId,
      syncType: "FULL",
      status: "FAILED",
      startedAt: new Date(),
      errorMessage: error.message,
    });

    return result;
  }
}

/**
 * Sincronizza prodotti da Fatture in Cloud
 */
async function syncProducts(
  retailerId: string,
  companyId: number,
  accessToken: string
): Promise<number> {
  const ficProducts = await fetchProducts(companyId, accessToken);
  let synced = 0;

  for (const ficProduct of ficProducts) {
    try {
      const internalProduct = mapFICProductToInternal(ficProduct);

      // Verifica se prodotto esiste già
      const existing = await db.getProductBySku(internalProduct.sku);

      if (existing) {
        // Aggiorna prodotto esistente
        await db.updateProduct(existing.id, internalProduct);
      } else {
        // Crea nuovo prodotto
        await db.createProduct({
          ...internalProduct,
          isLowCarb: 1,
          isGlutenFree: 1,
          isKeto: 1,
          sugarContent: "0%",
        });
      }

      synced++;
    } catch (error) {
      console.error(`[Sync] Failed to sync product ${ficProduct.code}:`, error);
    }
  }

  return synced;
}

/**
 * Sincronizza inventario da Fatture in Cloud
 *
 * Phase B M2: stub no-op. La tabella `inventory` legacy è stata
 * droppata e gli helper `db.upsertInventory` rimossi. Il refactor
 * single-tenant FiC arriverà in Milestone 3 e introdurrà mapping su
 * `inventoryByBatch` + lotti FEFO.
 */
async function syncInventory(
  _retailerId: string,
  _companyId: number,
  _accessToken: string,
): Promise<number> {
  console.warn(
    "[Sync] syncInventory disabled until M3 FiC refactor (single-tenant + lots)",
  );
  return 0;
}

/**
 * Sincronizza movimenti stock da documenti
 *
 * Phase B M2: stub no-op. Stesso motivo di `syncInventory`.
 */
async function syncMovements(
  _retailerId: string,
  _companyId: number,
  _accessToken: string,
  _startDate: string,
  _endDate: string,
): Promise<number> {
  console.warn(
    "[Sync] syncMovements disabled until M3 FiC refactor (single-tenant + lots)",
  );
  return 0;
}

/**
 * Rinnova token per rivenditore
 */
async function refreshTokenForRetailer(retailer: any): Promise<string> {
  const config = getOAuthConfig();
  if (!config) {
    throw new Error("OAuth configuration not available");
  }

  if (!retailer.fattureInCloudRefreshToken) {
    throw new Error("No refresh token available");
  }

  const tokens = await refreshAccessToken(config, retailer.fattureInCloudRefreshToken);

  // Calcola scadenza
  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + tokens.expires_in);

  // Aggiorna token nel database
  await db.updateRetailer(retailer.id, {
    fattureInCloudAccessToken: tokens.access_token,
    fattureInCloudRefreshToken: tokens.refresh_token,
    fattureInCloudTokenExpiresAt: expiresAt,
  });

  return tokens.access_token;
}
