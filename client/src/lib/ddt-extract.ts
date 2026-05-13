/**
 * M5.4 — Helper per chiamare l'Edge Function /api/ddt-extract.
 *
 * Flusso:
 * 1. Frontend chiama ddtImports.upload (tRPC) → riceve { id, storagePath }
 * 2. Frontend chiama callDdtExtract() (questo helper) → riceve extractedData
 * 3. Frontend chiama ddtImports.confirmExtraction (tRPC) → salva in DB
 *
 * L'Edge Function gira con timeout 30s (Vercel Hobby).
 */
import { supabase } from "./supabase";

export interface DdtExtractedItem {
  productCode: string | null;
  productName: string;
  quantityPieces: number;
  quantityKg: number | null;
  batchNumber: string;
  expirationDate: string;
}

export interface DdtExtractedData {
  ddtNumber: string | null;
  ddtDate: string | null;
  producerName: string | null;
  destinationName: string | null;
  items: DdtExtractedItem[];
}

interface DdtExtractResponse {
  success: boolean;
  ddtImportId: string;
  extractedData: DdtExtractedData;
  extractedBy: string;
}

interface DdtExtractError {
  error: string;
  detail: string;
}

/**
 * Chiama l'Edge Function /api/ddt-extract per estrarre dati da un PDF DDT
 * usando Claude Vision.
 *
 * @param storagePath - Path del PDF su Supabase Storage (bucket ddt-imports)
 * @param ddtImportId - ID del record ddt_imports
 * @returns I dati estratti dal DDT
 * @throws Error se l'estrazione fallisce o il timeout scade
 */
export async function callDdtExtract(
  storagePath: string,
  ddtImportId: string
): Promise<DdtExtractedData> {
  // Ottieni il JWT Supabase corrente
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  if (!token) {
    throw new Error("Non autenticato. Effettua il login e riprova.");
  }

  // Chiama l'Edge Function con timeout di 35s (5s margine sul 30s Edge)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35_000);

  try {
    const response = await fetch("/api/ddt-extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ storagePath, ddtImportId }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody: DdtExtractError = await response.json().catch(() => ({
        error: "Unknown error",
        detail: `HTTP ${response.status}`,
      }));
      throw new Error(errorBody.detail || errorBody.error);
    }

    const result: DdtExtractResponse = await response.json();

    if (!result.success || !result.extractedData) {
      throw new Error("Risposta Edge Function non valida");
    }

    return result.extractedData;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        "Timeout: l'estrazione AI ha superato i 35 secondi. " +
          "Il PDF potrebbe essere troppo grande o complesso. Riprova."
      );
    }

    throw err;
  }
}
