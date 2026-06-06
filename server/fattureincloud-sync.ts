/**
 * Fatture in Cloud Synchronization Service
 * DEPRECATED by M11.C — per-retailer sync no longer used.
 * Kept as stub for backward compatibility if any reference remains.
 */

export interface SyncResult {
  success: boolean;
  productsSync: number;
  inventorySync: number;
  movementsSync: number;
  errors: string[];
}

/**
 * DEPRECATED — Sincronizza tutti i dati per un rivenditore.
 * M11.C: questa funzione non è più utilizzata. Il nuovo flusso
 * usa ficConnections per-company e non sincronizza dati per-retailer.
 */
export async function syncRetailerData(_retailerId: string): Promise<SyncResult> {
  console.warn("[fattureincloud-sync] syncRetailerData is DEPRECATED (M11.C)");
  return {
    success: false,
    productsSync: 0,
    inventorySync: 0,
    movementsSync: 0,
    errors: ["DEPRECATED: use per-company FiC flow via /settings/integrations"],
  };
}
