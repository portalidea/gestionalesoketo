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
      "quantityPieces": "numero intero OBBLIGATORIO, mai null, mai 0",
      "quantityKg": "numero decimale o null (se presente)",
      "batchNumber": "codice lotto",
      "expirationDate": "YYYY-MM-DD"
    }
  ]
}

Regole:
- Ignora righe non-prodotto: SPESE IMBALLAGGIO, Rimborso Trasporto, Spese Accessorie, Costo di Trasporto/Shipping costs, ecc.
- "Pezzi" prende precedenza su "Quantità KG" per quantityPieces
- Date in formato italiano (DD/MM/YY o DD/MM/YYYY) convertile a YYYY-MM-DD
- Anno a 2 cifre: <50 → 20XX, >=50 → 19XX (improbabile)
- Lotti possono apparire come "Lotto: XXX", "Lotto XXX", "LOTTO XXX", "L. XXX"
- Scadenze: "Scad.", "SCAD:", "Scadenza", spesso vicino al lotto

REGOLA MULTI-LOTTO (CRITICA):
- Se un articolo ha PIÙ LOTTI distinti (es. "Lotto: ABC Scad. 01/01/29" e "Lotto: DEF Scad. 02/02/28" sotto la stessa descrizione prodotto), genera UNA RIGA SEPARATA in "items" per OGNI lotto.
- La descrizione prodotto (productName, productCode) resta la stessa per ogni riga, ma batchNumber, expirationDate e quantityPieces sono propri di ciascun lotto.
- NON aggregare più lotti in una sola riga. NON lasciare quantityPieces null.

REGOLA CONVERSIONE KG → PEZZI:
- quantityPieces è OBBLIGATORIO e MAI null/0.
- Se la quantità del singolo lotto è espressa in kg (es. "Qta: 1,75" con U.M. KG), convertila in pezzi usando il peso unitario del prodotto riconoscibile dal nome:
  * Prodotti "250g" o "250 g" → dividi kg per 0.250
  * Prodotti "500g" o "500 g" → dividi kg per 0.500
  * Prodotti "1kg" o "1000g" → dividi kg per 1.000
  * Prodotti "200g" → dividi kg per 0.200
  * Prodotti "300g" → dividi kg per 0.300
  * Prodotti "150g" → dividi kg per 0.150
  * Se non riesci a determinare il peso unitario, cerca la colonna "Pz/Cnf" o "Pezzi" nel DDT.
- Arrotonda SEMPRE al numero intero più vicino.
- Se il DDT ha una colonna "Pz/Cnf" o "Pezzi" con il totale pezzi per l'articolo E l'articolo ha un solo lotto, usa quel valore direttamente.
- Se l'articolo ha più lotti, calcola i pezzi per ogni lotto dalla sua quantità in kg.

Esempio output corretto per multi-lotto:
[
  { "productCode": "LS240", "productName": "Tagliatelle High Protein 250g c/terzi",
    "quantityPieces": 7, "quantityKg": 1.75,
    "batchNumber": "P02C62FT", "expirationDate": "2029-03-31" },
  { "productCode": "LS240", "productName": "Tagliatelle High Protein 250g c/terzi",
    "quantityPieces": 153, "quantityKg": 38.25,
    "batchNumber": "P10K52FT", "expirationDate": "2028-11-30" }
]

Se non trovi un campo, valore null (tranne quantityPieces che è sempre un intero > 0). Se zero items, items=[].`;

/**
 * Estrae dati strutturati da un PDF DDT usando Claude Vision.
 * Il PDF viene inviato come base64 (Claude supporta PDF nativamente).
 */
export async function extractFromPdf(pdfBuffer: Buffer): Promise<DdtExtractedData> {
  const anthropic = getAnthropic();

  const base64Pdf = pdfBuffer.toString("base64");

  const response = await anthropic.messages.create({
    // Modello Claude: verificare validità periodicamente su
    // https://docs.claude.com/en/docs/about-claude/models
    model: "claude-sonnet-4-6",
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
