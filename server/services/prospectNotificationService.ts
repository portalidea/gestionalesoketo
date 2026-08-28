import { Resend } from "resend";
import { ENV } from "../_core/env";
import { getProspectNotificationRecipient } from "./prospectNotificationConfig";

export type ProspectNotificationPayload = {
  simulationId: string;
  legalName: string;
  contactName: string;
  email: string;
  phone: string;
  businessType: string;
  city: string;
  vatNumber: string;
  listSubtotalNet: string;
  reachedTierName: string;
  itemCount: number;
};

export type ProspectNotificationResult =
  | { sent: true }
  | { sent: false; errorMessage: string };

export type ProspectInvitationNotificationPayload = {
  legalName: string;
  contactName: string;
  email: string;
  orderUrl: string;
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** Invia solo dopo il salvataggio della richiesta; non usa email_log né i flag M13. */
export async function sendProspectSimulationNotification(
  payload: ProspectNotificationPayload,
): Promise<ProspectNotificationResult> {
  try {
    if (!ENV.resendApiKey) return { sent: false, errorMessage: "RESEND_API_KEY non configurata" };
    const recipient = getProspectNotificationRecipient();
    const resend = new Resend(ENV.resendApiKey);
    const subject = `Nuova richiesta prospect — ${payload.legalName}`;
    const html = `<!doctype html><html lang="it"><body style="margin:0;background:#FAF7F0;color:#2D5A27;font-family:Poppins,Arial,sans-serif"><main style="max-width:640px;margin:24px auto;background:#fff;border-radius:12px;padding:32px"><h1 style="margin:0 0 18px;font-size:22px">Nuova richiesta dal simulatore</h1><p style="margin:0 0 22px">È stata salvata una nuova simulazione prospect.</p><table role="presentation" cellspacing="0" cellpadding="8" style="border-collapse:collapse;width:100%"><tr><td><strong>Ragione sociale</strong></td><td>${escapeHtml(payload.legalName)}</td></tr><tr><td><strong>Referente</strong></td><td>${escapeHtml(payload.contactName)}</td></tr><tr><td><strong>Email</strong></td><td>${escapeHtml(payload.email)}</td></tr><tr><td><strong>Telefono</strong></td><td>${escapeHtml(payload.phone)}</td></tr><tr><td><strong>Attività</strong></td><td>${escapeHtml(payload.businessType)}</td></tr><tr><td><strong>Città</strong></td><td>${escapeHtml(payload.city)}</td></tr><tr><td><strong>P. IVA</strong></td><td>${escapeHtml(payload.vatNumber)}</td></tr><tr><td><strong>Totale listino</strong></td><td>€ ${escapeHtml(payload.listSubtotalNet)} IVA esclusa</td></tr><tr><td><strong>Fascia simulata</strong></td><td>${escapeHtml(payload.reachedTierName)}</td></tr><tr><td><strong>Righe carrello</strong></td><td>${payload.itemCount}</td></tr></table><p style="margin:24px 0 0;color:#61705E;font-size:13px">ID richiesta: ${escapeHtml(payload.simulationId)}</p></main></body></html>`;
    const { data, error } = await resend.emails.send({
      from: "SoKeto Gestionale <noreply@sm.soketo.it>",
      to: [recipient],
      subject,
      html,
    });
    if (error || !data?.id) return { sent: false, errorMessage: error?.message ?? "Resend non ha restituito un message ID" };
    return { sent: true };
  } catch (error) {
    return { sent: false, errorMessage: error instanceof Error ? error.message : "Errore email sconosciuto" };
  }
}

/** Invio diretto dell'invito: la failure è restituita al chiamante per la persistenza sull'invito. */
export async function sendProspectInvitationNotification(
  payload: ProspectInvitationNotificationPayload,
): Promise<ProspectNotificationResult> {
  try {
    if (!ENV.resendApiKey) return { sent: false, errorMessage: "RESEND_API_KEY non configurata" };
    const resend = new Resend(ENV.resendApiKey);
    const subject = "Il tuo ordine SoKeto è pronto da compilare";
    const safeName = escapeHtml(payload.contactName || payload.legalName);
    const safeCompany = escapeHtml(payload.legalName);
    const safeUrl = escapeHtml(payload.orderUrl);
    const html = `<!doctype html><html lang="it"><body style="margin:0;background:#FAF7F0;color:#2D5A27;font-family:Poppins,Arial,sans-serif"><main style="max-width:640px;margin:24px auto;background:#fff;border-radius:12px;padding:32px"><h1 style="margin:0 0 18px;font-size:22px">Completa il tuo ordine SoKeto</h1><p>Ciao ${safeName},</p><p>Abbiamo preparato un link personale per compilare il tuo primo ordine per <strong>${safeCompany}</strong>.</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#2D5A27;color:#fff;text-decoration:none;border-radius:8px;padding:13px 20px;font-weight:700">COMPILA IL TUO ORDINE</a></p><p style="color:#61705E;font-size:13px">Il link resta valido per 15 giorni. Se hai bisogno di assistenza, contattaci.</p></main></body></html>`;
    const { data, error } = await resend.emails.send({
      from: "SoKeto Gestionale <noreply@sm.soketo.it>",
      to: [payload.email],
      subject,
      html,
    });
    if (error || !data?.id) return { sent: false, errorMessage: error?.message ?? "Resend non ha restituito un message ID" };
    return { sent: true };
  } catch (error) {
    return { sent: false, errorMessage: error instanceof Error ? error.message : "Errore email sconosciuto" };
  }
}
