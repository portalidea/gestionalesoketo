/**
 * M5 — Claude Vision extraction per DDT PDF.
 * Invia il PDF come immagine base64 a Claude e riceve JSON strutturato
 * con header DDT + righe prodotto.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ENV } from "./_core/env";

let _anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (!ENV.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY non configurata");
  }
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: ENV.anthropicApiKey });
  }
  return _anthropic;
}

/**
 * Schema output atteso da Claude Vision.
 */
export interface DdtExtractedData {
  ddtNumber: string | null;
  ddtDate: string | null; // YYYY-MM-DD
  producerName: string | null;
  destinationName: string | null;
  items: DdtExtractedItem[];
}

export interface DdtExtractedItem {
  productCode: string | null;
  productName: string;
  quantityPieces: number;
  quantityKg: number | null;
  batchNumber: string;
  expirationDate: string; // YYYY-MM-DD
}

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

/**
 * Estrae dati strutturati da un PDF DDT usando Claude Vision.
 * Il PDF viene inviato come base64 (Claude supporta PDF nativamente).
 */
export async function extractFromPdf(pdfBuffer: Buffer): Promise<DdtExtractedData> {
  const anthropic = getAnthropic();

  const base64Pdf = pdfBuffer.toString("base64");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            type: "text",
            text: "Estrai tutti i dati da questo DDT secondo lo schema richiesto. Rispondi SOLO con il JSON.",
          },
        ],
      },
    ],
    system: SYSTEM_PROMPT,
  });

  // Estrai il testo dalla risposta
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude Vision non ha restituito testo");
  }

  // Parse JSON dalla risposta
  const rawText = textBlock.text.trim();
  // Rimuovi eventuale markdown code block
  const jsonText = rawText.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

  try {
    const parsed = JSON.parse(jsonText) as DdtExtractedData;
    // Validazione base
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
