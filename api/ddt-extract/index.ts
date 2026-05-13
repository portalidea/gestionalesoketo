/**
 * M5.4 — Edge Function isolata per estrazione DDT con Claude Vision.
 *
 * Runtime: Vercel Edge (timeout 30s su Hobby plan)
 * Zero dipendenze Node.js: usa solo fetch() nativo.
 * Auth: verifica token via Supabase Auth API (no jose — cross-realm CryptoKey bug).
 *
 * Flusso:
 * 1. Frontend invia { storagePath, ddtImportId } + JWT Supabase in header
 * 2. Edge Function verifica JWT via Supabase /auth/v1/user
 * 3. Scarica PDF da Supabase Storage via REST API
 * 4. Chiama Claude Vision via fetch() diretto (no SDK, Edge-compatible)
 * 5. Ritorna JSON strutturato estratto
 *
 * L'Edge Function NON accede al database. Il salvataggio dei dati
 * estratti avviene tramite la procedura tRPC ddtImports.confirmExtraction
 * chiamata dal frontend dopo aver ricevuto la risposta.
 */

export const config = {
  runtime: "edge",
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface DdtExtractedItem {
  productCode: string | null;
  productName: string;
  quantityPieces: number;
  quantityKg: number | null;
  batchNumber: string;
  expirationDate: string; // YYYY-MM-DD
}

interface DdtExtractedData {
  ddtNumber: string | null;
  ddtDate: string | null; // YYYY-MM-DD
  producerName: string | null;
  destinationName: string | null;
  items: DdtExtractedItem[];
}

interface RequestBody {
  storagePath: string;
  ddtImportId: string;
}

interface SupabaseUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
  user_metadata?: {
    [key: string]: unknown;
  };
}

// ─── Claude Vision System Prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Sei un assistente che estrae dati da Documenti Di Trasporto (DDT) italiani PDF di aziende alimentari. Estrai i dati in JSON strutturato. Non aggiungere testo prima o dopo il JSON.

Schema output:
{
  "ddtNumber": "string o null",
  "ddtDate": "YYYY-MM-DD o null",
  "producerName": "ragione sociale mittente o null",
  "destinationName": "ragione sociale destinatario o null",
  "items": [
    {
      "productCode": "codice prodotto del mittente (es LS571)",
      "productName": "nome prodotto completo",
      "quantityPieces": "numero intero (cerca campo 'Pezzi' o 'Quantità' in PZ)",
      "quantityKg": "numero decimale o null (se presente)",
      "batchNumber": "codice lotto",
      "expirationDate": "YYYY-MM-DD"
    }
  ]
}

Regole:
- Ignora righe non-prodotto: SPESE IMBALLAGGIO, Rimborso Trasporto, Spese Accessorie, ecc.
- "Pezzi" prende precedenza su "Quantità KG" per quantityPieces
- Date in formato italiano (DD/MM/YY o DD/MM/YYYY) convertile a YYYY-MM-DD
- Anno a 2 cifre: <50 → 20XX, >=50 → 19XX (improbabile)
- Lotti possono apparire come "Lotto: XXX", "Lotto XXX", "LOTTO XXX", "L. XXX"
- Scadenze: "Scad.", "SCAD:", "Scadenza", spesso vicino al lotto

Se non trovi un campo, valore null. Se zero items, items=[].`;

// ─── Auth: Supabase Auth API (Edge-compatible, no jose) ─────────────────────

/**
 * Verifica il token JWT chiamando Supabase Auth API.
 * Bypassa completamente jose (cross-realm CryptoKey bug su Edge Runtime).
 * ~50ms overhead, trascurabile vs 5-20s Claude Vision.
 */
async function verifyToken(
  token: string,
  supabaseUrl: string,
  supabaseServiceRoleKey: string
): Promise<SupabaseUser | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: supabaseServiceRoleKey,
    },
  });

  if (!response.ok) {
    return null;
  }

  const user = (await response.json()) as SupabaseUser;

  // Verifica che l'utente abbia un ID valido
  if (!user.id) {
    return null;
  }

  return user;
}

// ─── Supabase Storage Download (Edge-compatible via fetch) ───────────────────

/**
 * Scarica un file da Supabase Storage usando l'API REST.
 * Non usa @supabase/supabase-js (che ha dipendenze Node.js).
 */
async function downloadFromSupabaseStorage(
  supabaseUrl: string,
  serviceRoleKey: string,
  bucket: string,
  path: string
): Promise<ArrayBuffer> {
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${path}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(
      `Supabase Storage download failed (${response.status}): ${errorText}`
    );
  }

  return response.arrayBuffer();
}

// ─── Claude Vision Call (Edge-compatible via fetch) ──────────────────────────

/**
 * Chiama Claude Vision API direttamente via fetch().
 * Non usa @anthropic-ai/sdk (che ha dipendenze node:fs).
 */
async function callClaudeVision(
  apiKey: string,
  pdfBase64: string
): Promise<DdtExtractedData> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
            },
            {
              type: "text",
              text: "Estrai tutti i dati da questo DDT secondo lo schema richiesto. Rispondi SOLO con il JSON.",
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown");
    throw new Error(
      `Claude API error (${response.status}): ${errorBody}`
    );
  }

  const result = await response.json();

  // Estrai il testo dalla risposta
  const textBlock = result.content?.find(
    (b: { type: string }) => b.type === "text"
  );
  if (!textBlock?.text) {
    throw new Error("Claude Vision non ha restituito testo");
  }

  // Parse JSON dalla risposta (rimuovi eventuale markdown code block)
  const rawText = textBlock.text.trim();
  const jsonText = rawText
    .replace(/^```json?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");

  try {
    const parsed = JSON.parse(jsonText) as DdtExtractedData;
    if (!Array.isArray(parsed.items)) {
      parsed.items = [];
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `Errore parsing JSON da Claude Vision: ${err instanceof Error ? err.message : String(err)}\nRaw: ${rawText.slice(0, 500)}`
    );
  }
}

// ─── Edge Function Handler ──────────────────────────────────────────────────

export default async function handler(request: Request): Promise<Response> {
  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  // Preflight CORS
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Solo POST
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    // ─── Env vars ────────────────────────────────────────────────────────
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          detail: "Missing required environment variables",
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    // ─── Auth: verifica token via Supabase Auth API ─────────────────────
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", detail: "Missing Bearer token" }),
        { status: 401, headers: corsHeaders }
      );
    }

    const token = authHeader.slice(7);
    const user = await verifyToken(token, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (!user) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          detail: "Invalid or expired token",
        }),
        { status: 401, headers: corsHeaders }
      );
    }

    // ─── Parse request body ──────────────────────────────────────────────
    let body: RequestBody;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Bad request", detail: "Invalid JSON body" }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!body.storagePath || !body.ddtImportId) {
      return new Response(
        JSON.stringify({
          error: "Bad request",
          detail: "Missing required fields: storagePath, ddtImportId",
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    // ─── Step 1: Download PDF da Supabase Storage ────────────────────────
    const pdfArrayBuffer = await downloadFromSupabaseStorage(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      "ddt-imports",
      body.storagePath
    );

    // Converti a base64 (Edge-compatible: usa btoa + Uint8Array)
    const pdfBytes = new Uint8Array(pdfArrayBuffer);
    let binary = "";
    // Chunk per evitare stack overflow su file grandi
    const CHUNK_SIZE = 8192;
    for (let i = 0; i < pdfBytes.length; i += CHUNK_SIZE) {
      const chunk = pdfBytes.subarray(i, i + CHUNK_SIZE);
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
    }
    const pdfBase64 = btoa(binary);

    // ─── Step 2: Chiama Claude Vision ────────────────────────────────────
    const extractedData = await callClaudeVision(ANTHROPIC_API_KEY, pdfBase64);

    // ─── Step 3: Ritorna JSON estratto ───────────────────────────────────
    return new Response(
      JSON.stringify({
        success: true,
        ddtImportId: body.ddtImportId,
        extractedData,
        extractedBy: user.id,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    console.error("[ddt-extract] Error:", err);

    const message =
      err instanceof Error ? err.message : "Unknown error";

    return new Response(
      JSON.stringify({ error: "Extraction failed", detail: message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
