/**
 * Fatture in Cloud API Integration
 * Funzioni per sincronizzare prodotti, inventario e documenti
 */

import { makeAuthenticatedRequest } from "./fattureincloud-oauth";

// Tipi API Fatture in Cloud
export interface FICProduct {
  id: number;
  code: string;
  name: string;
  description?: string;
  category?: string;
  net_price?: number;
  gross_price?: number;
  stock?: {
    initial?: number;
    current?: number;
    average_cost?: number;
    average_price?: number;
  };
  measure_unit?: string;
}

export interface FICDocument {
  id: number;
  type: string;
  numeration: string;
  date: string;
  items: FICDocumentItem[];
}

export interface FICDocumentItem {
  id: number;
  product_id: number;
  code: string;
  name: string;
  quantity: number;
  measure_unit?: string;
  net_price?: number;
  gross_price?: number;
}

/**
 * Ottiene lista prodotti da Fatture in Cloud
 */
export async function fetchProducts(
  companyId: number,
  accessToken: string
): Promise<FICProduct[]> {
  try {
    const response = await makeAuthenticatedRequest<{ data: FICProduct[] }>(
      companyId,
      "/products",
      accessToken,
      "GET"
    );

    return response.data || [];
  } catch (error) {
    console.error("[FattureInCloud API] Failed to fetch products:", error);
    throw error;
  }
}

/**
 * Ottiene singolo prodotto per ID
 */
export async function fetchProductById(
  companyId: number,
  productId: number,
  accessToken: string
): Promise<FICProduct | null> {
  try {
    const response = await makeAuthenticatedRequest<{ data: FICProduct }>(
      companyId,
      `/products/${productId}`,
      accessToken,
      "GET"
    );

    return response.data || null;
  } catch (error) {
    console.error("[FattureInCloud API] Failed to fetch product:", error);
    return null;
  }
}

/**
 * Ottiene documenti (fatture, DDT, ecc.) in un range di date
 */
export async function fetchDocuments(
  companyId: number,
  accessToken: string,
  startDate: string,
  endDate: string,
  documentType?: string
): Promise<FICDocument[]> {
  try {
    const params = new URLSearchParams({
      date_from: startDate,
      date_to: endDate,
    });

    if (documentType) {
      params.append("type", documentType);
    }

    const response = await makeAuthenticatedRequest<{ data: FICDocument[] }>(
      companyId,
      `/issued_documents?${params.toString()}`,
      accessToken,
      "GET"
    );

    return response.data || [];
  } catch (error) {
    console.error("[FattureInCloud API] Failed to fetch documents:", error);
    throw error;
  }
}

/**
 * Mappa prodotto Fatture in Cloud a formato interno
 */
export function mapFICProductToInternal(ficProduct: FICProduct) {
  return {
    sku: ficProduct.code || `FIC-${ficProduct.id}`,
    name: ficProduct.name,
    description: ficProduct.description || null,
    category: ficProduct.category || null,
    unitPrice: ficProduct.net_price?.toString() || null,
    unit: ficProduct.measure_unit || null,
    fattureInCloudId: ficProduct.id.toString(),
  };
}

/**
 * Calcola movimenti stock da documenti
 */
export function extractStockMovementsFromDocuments(
  documents: FICDocument[],
  retailerId: number
): Array<{
  productCode: string;
  productName: string;
  quantity: number;
  type: "IN" | "OUT";
  documentType: string;
  documentNumber: string;
  date: string;
}> {
  const movements: Array<{
    productCode: string;
    productName: string;
    quantity: number;
    type: "IN" | "OUT";
    documentType: string;
    documentNumber: string;
    date: string;
  }> = [];

  for (const doc of documents) {
    // Determina tipo movimento in base al tipo documento
    const movementType = determineMovementType(doc.type);

    if (!movementType) continue; // Ignora documenti non rilevanti per stock

    for (const item of doc.items || []) {
      movements.push({
        productCode: item.code,
        productName: item.name,
        quantity: Math.abs(item.quantity),
        type: movementType,
        documentType: doc.type,
        documentNumber: doc.numeration,
        date: doc.date,
      });
    }
  }

  return movements;
}

/**
 * Determina tipo movimento in base al tipo documento
 */
function determineMovementType(documentType: string): "IN" | "OUT" | null {
  const incomingTypes = ["purchase_order", "delivery_note_in", "order"];
  const outgoingTypes = ["invoice", "delivery_note", "credit_note", "receipt"];

  const normalizedType = documentType.toLowerCase();

  if (incomingTypes.some((t) => normalizedType.includes(t))) {
    return "IN";
  }

  if (outgoingTypes.some((t) => normalizedType.includes(t))) {
    return "OUT";
  }

  return null;
}

/**
 * Verifica connessione API con test call
 */
export async function testConnection(
  companyId: number,
  accessToken: string
): Promise<boolean> {
  try {
    await makeAuthenticatedRequest(companyId, "/info", accessToken, "GET");
    return true;
  } catch (error) {
    console.error("[FattureInCloud API] Connection test failed:", error);
    return false;
  }
}
