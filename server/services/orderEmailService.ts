/**
 * M6.2.B — Order Email Notification Service
 *
 * Sends email notifications to retailer on each order status transition.
 * Also notifies admin on cancellation and new orders.
 */
import { sendEmail } from "../email";
import { getDb } from "../db";
import { eq } from "drizzle-orm";
import { retailers, users } from "../../drizzle/schema";
import { ENV } from "../_core/env";

export interface OrderEmailInput {
  orderId: string;
  orderNumber: string;
  retailerId: string;
  newStatus: string;
  previousStatus: string;
  reason?: string;
  ficInvoiceNumber?: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "In attesa di pagamento",
  paid: "Pagamento confermato",
  approved_for_shipping: "Approvato per spedizione",
  transferring: "In preparazione",
  shipped: "Spedito",
  delivered: "Consegnato",
  paid_on_delivery: "Pagato alla consegna",
  cancelled: "Annullato",
  modified: "Ordine modificato",
};

/**
 * Send order status change notification to retailer + admin (if applicable).
 */
export async function sendOrderStatusEmail(input: OrderEmailInput): Promise<void> {
  const { orderId, orderNumber, retailerId, newStatus, previousStatus, reason, ficInvoiceNumber } = input;

  try {
    const db = await getDb();
    if (!db) return;

    // Get retailer email
    const [retailer] = await db
      .select({ email: retailers.email, name: retailers.name })
      .from(retailers)
      .where(eq(retailers.id, retailerId))
      .limit(1);

    if (!retailer?.email) {
      console.warn(`[orderEmail] No email for retailer ${retailerId}, skipping`);
      return;
    }

    const statusLabel = STATUS_LABELS[newStatus] ?? newStatus;
    const subject = `Ordine ${orderNumber} — ${statusLabel}`;
    const html = buildStatusEmailHtml({
      orderNumber,
      retailerName: retailer.name,
      newStatus,
      statusLabel,
      reason,
      ficInvoiceNumber,
    });

    await sendEmail({
      to: retailer.email,
      subject,
      html,
    });

    // Notify admin on cancellation
    if (newStatus === "cancelled") {
      await notifyAdmin(
        `Ordine ${orderNumber} annullato`,
        `L'ordine ${orderNumber} del rivenditore ${retailer.name} è stato annullato.${reason ? ` Motivo: ${reason}` : ""}`,
      );
    }

    console.log(`[orderEmail] Sent ${newStatus} notification to ${retailer.email} for ${orderNumber}`);
  } catch (err: any) {
    console.error(`[orderEmail] Failed: ${err.message}`);
  }
}

/**
 * Notify admin email about important events.
 */
async function notifyAdmin(subject: string, body: string): Promise<void> {
  const adminEmail = ENV.ownerEmail;
  if (!adminEmail) return;

  await sendEmail({
    to: adminEmail,
    subject: `[SoKeto Admin] ${subject}`,
    html: wrapInTemplate(body),
  });
}

// --- HTML Templates ---

function buildStatusEmailHtml(params: {
  orderNumber: string;
  retailerName: string;
  newStatus: string;
  statusLabel: string;
  reason?: string;
  ficInvoiceNumber?: string;
}): string {
  const { orderNumber, retailerName, newStatus, statusLabel, reason, ficInvoiceNumber } = params;

  let bodyContent = "";

  switch (newStatus) {
    case "paid":
      bodyContent = `
        <p>Il pagamento per l'ordine <strong>${orderNumber}</strong> è stato confermato.</p>
        <p>Il tuo ordine è ora in fase di preparazione. Ti invieremo un aggiornamento quando sarà pronto per la spedizione.</p>
      `;
      break;

    case "approved_for_shipping":
      bodyContent = `
        <p>L'ordine <strong>${orderNumber}</strong> è stato approvato per la spedizione.</p>
        <p>Stiamo preparando il tuo ordine. Il pagamento avverrà alla consegna.</p>
      `;
      break;

    case "transferring":
      bodyContent = `
        <p>L'ordine <strong>${orderNumber}</strong> è in fase di preparazione presso il nostro magazzino.</p>
        <p>Riceverai una notifica quando la merce sarà stata spedita.</p>
      `;
      break;

    case "shipped":
      bodyContent = `
        <p>L'ordine <strong>${orderNumber}</strong> è stato spedito!</p>
        <p>La merce è in viaggio verso il tuo punto vendita. Ti contatteremo per concordare la consegna.</p>
      `;
      break;

    case "delivered":
      bodyContent = `
        <p>L'ordine <strong>${orderNumber}</strong> è stato consegnato con successo.</p>
        ${ficInvoiceNumber ? `<p>Fattura n. <strong>${ficInvoiceNumber}</strong> disponibile su Fatture in Cloud.</p>` : ""}
        <p>Grazie per il tuo ordine!</p>
      `;
      break;

    case "paid_on_delivery":
      bodyContent = `
        <p>Il pagamento alla consegna per l'ordine <strong>${orderNumber}</strong> è stato registrato.</p>
        <p>Grazie!</p>
      `;
      break;

    case "cancelled":
      bodyContent = `
        <p>L'ordine <strong>${orderNumber}</strong> è stato annullato.</p>
        ${reason ? `<p><strong>Motivo:</strong> ${reason}</p>` : ""}
        <p>Se hai domande, contattaci rispondendo a questa email.</p>
      `;
      break;

    case "modified":
      bodyContent = `
        <p>L'ordine <strong>${orderNumber}</strong> è stato modificato dall'amministratore.</p>
        <p>Verifica i dettagli aggiornati nel portale rivenditori.</p>
      `;
      break;

    default:
      bodyContent = `
        <p>Lo stato dell'ordine <strong>${orderNumber}</strong> è cambiato a: <strong>${statusLabel}</strong>.</p>
      `;
  }

  return wrapInTemplate(`
    <h2 style="color: #1a1a1a; margin-bottom: 16px;">Ordine ${orderNumber}</h2>
    <div style="background: #f0fdf4; border-left: 4px solid #16a34a; padding: 12px 16px; margin-bottom: 20px; border-radius: 4px;">
      <strong>Stato:</strong> ${statusLabel}
    </div>
    ${bodyContent}
    <p style="color: #666; font-size: 13px; margin-top: 24px;">
      Puoi visualizzare i dettagli del tuo ordine accedendo al <a href="https://gestionale.soketo.it/partner-portal/orders/${params.orderNumber}" style="color: #16a34a;">portale rivenditori</a>.
    </p>
  `);
}

function wrapInTemplate(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="border-bottom: 2px solid #16a34a; padding-bottom: 12px; margin-bottom: 24px;">
    <strong style="font-size: 18px; color: #16a34a;">SoKeto</strong>
    <span style="color: #666; font-size: 14px; margin-left: 8px;">Gestionale Ordini</span>
  </div>
  ${content}
  <div style="border-top: 1px solid #eee; padding-top: 16px; margin-top: 32px; font-size: 12px; color: #999;">
    <p>Questa email è stata inviata automaticamente dal sistema SoKeto. Non rispondere a questo indirizzo.</p>
  </div>
</body>
</html>`;
}
