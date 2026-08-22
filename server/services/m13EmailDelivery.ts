import { Resend } from "resend";

export type M13DeliveryPayload = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type M13DeliveryResult =
  | { delivered: true; providerMessageId: string }
  | { delivered: false; reason: "delivery_disabled" | "missing_api_key" | "provider_error"; errorMessage?: string };

export type M13RenderedItem = {
  productName: string;
  batchCode: string;
  quantityPieces: number;
  piecesPerUnit: number;
};

/** Formatta quantità senza imporre alcun testo commerciale o amministrativo. */
export function formatM13Quantity(quantityPieces: number, piecesPerUnit: number): string {
  if (piecesPerUnit <= 1) return `${quantityPieces} pz`;
  const packages = Math.floor(quantityPieces / piecesPerUnit);
  const remainder = quantityPieces % piecesPerUnit;
  return remainder === 0 ? `${packages} confezioni (${quantityPieces} pz)` : `${packages} confezioni + ${remainder} pz (${quantityPieces} pz)`;
}

/** Compone solo struttura e quantità; il testo introduttivo resta fornito dall'amministratore. */
export function renderM13PlainText(input: { introText: string; items: M13RenderedItem[] }): string {
  return [input.introText.trim(), "", ...input.items.map((item) => `- ${item.productName} · lotto ${item.batchCode}: ${formatM13Quantity(item.quantityPieces, item.piecesPerUnit)}`)].join("\n");
}

/**
 * Protezione hard-stop: l'invio M13 resta spento finché non viene impostata
 * esplicitamente la variabile di produzione dopo validazione umana dell'HTML.
 */
export function isM13RealDeliveryEnabled(env = process.env): boolean {
  return env.M13_EMAIL_DELIVERY_ENABLED === "true";
}

/**
 * Deve essere chiamata solo dopo la reservation riuscita in email_log. La
 * chiave è inviata anche al provider (copertura 24h), ma la protezione
 * primaria e permanente resta l'indice PostgreSQL dell'applicazione.
 */
export async function deliverReservedM13Email(payload: M13DeliveryPayload): Promise<M13DeliveryResult> {
  if (!isM13RealDeliveryEnabled()) return { delivered: false, reason: "delivery_disabled" };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { delivered: false, reason: "missing_api_key" };

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: "SoKeto Gestionale <noreply@sm.soketo.it>",
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      headers: { "Idempotency-Key": payload.idempotencyKey },
    });
    if (error || !data?.id) {
      return { delivered: false, reason: "provider_error", errorMessage: error?.message ?? "Resend non ha restituito un message ID" };
    }
    return { delivered: true, providerMessageId: data.id };
  } catch (error) {
    return { delivered: false, reason: "provider_error", errorMessage: error instanceof Error ? error.message : "Errore provider sconosciuto" };
  }
}
