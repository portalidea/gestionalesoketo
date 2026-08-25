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
  expiryDate?: string;
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function renderM13AlignmentEmail(input: { retailerName: string; responseUrl: string; items: M13RenderedItem[] }): { subject: string; html: string; text: string } {
  const rowsHtml = input.items.map((item) => `<tr><td style="padding:12px 10px;border-bottom:1px solid #E4E8DE">${escapeHtml(item.productName)}</td><td style="padding:12px 10px;border-bottom:1px solid #E4E8DE">${escapeHtml(item.batchCode)}</td><td style="padding:12px 10px;border-bottom:1px solid #E4E8DE">${escapeHtml(item.expiryDate ?? "—")}</td><td style="padding:12px 10px;border-bottom:1px solid #E4E8DE;text-align:right;font-weight:700">${escapeHtml(formatM13Quantity(item.quantityPieces, item.piecesPerUnit))}</td></tr>`).join("");
  const listText = input.items.map((item) => `- ${item.productName} | Lotto ${item.batchCode} | Scadenza ${item.expiryDate ?? "—"} | ${formatM13Quantity(item.quantityPieces, item.piecesPerUnit)}`).join("\n");
  const subject = "Verifica giacenze SoKeto — ci serve il tuo riscontro";
  const text = `Ciao ${input.retailerName},\n\nstiamo attivando un sistema che ti segnalerà in anticipo i lotti SoKeto vicini alla data di scadenza, così hai il tempo di organizzare una promozione invece di ritrovarti con merce ferma.\n\nPerché funzioni ci serve una cosa sola: sapere cosa hai davvero a magazzino oggi. Il nostro gestionale registra quello che ti abbiamo spedito, ma non quello che hai già venduto — quindi i numeri qui sotto sono quasi certamente più alti del reale.\n\nProdotto | Lotto | Scadenza | Confezioni risultanti a noi\n${listText}\n\nTi chiediamo due minuti per correggerli. Da qui in avanti riceverai solo segnalazioni pertinenti.\n\nVERIFICA LE TUE GIACENZE: ${input.responseUrl}\n\nSe un lotto è esaurito basta un clic, non serve scrivere nulla.\n\nGrazie,\nIl team SoKeto`;
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet"></head><body style="margin:0;background:#FAF7F0;font-family:Poppins,Arial,sans-serif;color:#2D5A27"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FAF7F0;padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border-radius:14px;overflow:hidden"><tr><td style="background:#2D5A27;padding:28px 32px;color:#fff"><div style="font-size:22px;font-weight:700">SoKeto</div><div style="font-size:14px;opacity:.9;margin-top:4px">Verifica giacenze</div></td></tr><tr><td style="padding:32px"><p style="margin:0 0 18px">Ciao ${escapeHtml(input.retailerName)},</p><p style="margin:0 0 18px">stiamo attivando un sistema che ti segnalerà in anticipo i lotti SoKeto vicini alla data di scadenza, così hai il tempo di organizzare una promozione invece di ritrovarti con merce ferma.</p><p style="margin:0 0 24px">Perché funzioni ci serve una cosa sola: sapere cosa hai davvero a magazzino oggi. Il nostro gestionale registra quello che ti abbiamo spedito, ma non quello che hai già venduto — quindi i numeri qui sotto sono quasi certamente più alti del reale.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px"><thead><tr style="background:#EAF2E4"><th align="left" style="padding:12px 10px">Prodotto</th><th align="left" style="padding:12px 10px">Lotto</th><th align="left" style="padding:12px 10px">Scadenza</th><th align="right" style="padding:12px 10px">Confezioni risultanti a noi</th></tr></thead><tbody>${rowsHtml}</tbody></table><p style="margin:24px 0">Ti chiediamo due minuti per correggerli. Da qui in avanti riceverai solo segnalazioni pertinenti.</p><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(input.responseUrl)}" style="display:inline-block;background:#7AB648;color:#163315;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px">VERIFICA LE TUE GIACENZE</a></p><p style="margin:0 0 24px">Se un lotto è esaurito basta un clic, non serve scrivere nulla.</p><p style="margin:0">Grazie,<br>Il team SoKeto</p></td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
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
