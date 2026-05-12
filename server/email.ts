/**
 * Email helper via Resend.
 * Dominio custom: sm.soketo.it
 */
import { Resend } from "resend";
import { ENV } from "./_core/env";

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (!ENV.resendApiKey) {
    console.warn("[Email] RESEND_API_KEY non configurata — email disabilitate");
    return null;
  }
  if (!_resend) {
    _resend = new Resend(ENV.resendApiKey);
  }
  return _resend;
}

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
}

/**
 * Invia una email tramite Resend.
 * Ritorna true se inviata con successo, false se fallita o non configurata.
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;

  try {
    const { error } = await resend.emails.send({
      from: options.from ?? "SoKeto Gestionale <noreply@sm.soketo.it>",
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject,
      html: options.html,
    });

    if (error) {
      console.error("[Email] Errore invio:", error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[Email] Eccezione invio:", err);
    return false;
  }
}
