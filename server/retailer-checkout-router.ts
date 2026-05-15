/**
 * M6.2.B — Retailer Checkout Router
 *
 * Procedure retailer per:
 * - preview: anteprima ordine con totali (riusa pricing.calculateOrder)
 * - create: crea ordine con auto-FEFO, genera proforma FiC, invia email
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { retailerProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { calculateOrderPricing } from "./pricing";
import {
  inventoryByBatch,
  locations,
  orderItems,
  orders,
  productBatches,
  retailers,
} from "../drizzle/schema";
import { createFicProforma, getFicClientById } from "./fic-integration";
import { sendEmail } from "./email";

const cartItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1),
});

export const retailerCheckoutRouter = router({
  /**
   * 1. preview — anteprima ordine con totali calcolati
   */
  preview: retailerProcedure
    .input(z.object({ items: z.array(cartItemSchema).min(1) }))
    .query(async ({ input, ctx }) => {
      const pricing = await calculateOrderPricing(ctx.retailerId, input.items);
      return pricing;
    }),

  /**
   * 2. create — crea ordine retailer con:
   *    - Verifica stock disponibile
   *    - Auto-assegnazione lotti FEFO
   *    - Generazione proforma FiC
   *    - Email conferma retailer + admin
   */
  create: retailerProcedure
    .input(
      z.object({
        items: z.array(cartItemSchema).min(1),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

      // 1. Calcola pricing
      const pricing = await calculateOrderPricing(ctx.retailerId, input.items);

      // 2. Verifica stock disponibile (hard check — rifiuta se insufficiente)
      const stockErrors: string[] = [];
      for (const pi of pricing.items) {
        if (pi.stockWarning) {
          stockErrors.push(
            `${pi.productName}: richieste ${pi.quantity} conf, disponibili ${pi.stockAvailableConfezioni} conf`,
          );
        }
      }
      if (stockErrors.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Stock insufficiente:\n${stockErrors.join("\n")}`,
        });
      }

      // 3. Auto-assegnazione FEFO lotti (stessa logica di orders.create in M6.2.A)
      const [warehouse] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.type, "central_warehouse"))
        .limit(1);

      type BatchAllocation = {
        productId: string;
        batchId: string;
        quantity: number;
        batchNumber: string;
        expirationDate: string;
      };
      const allAllocations: (typeof pricing.items[0] & { allocations: BatchAllocation[] })[] = [];

      for (const pi of pricing.items) {
        const allocations: BatchAllocation[] = [];
        let remaining = pi.quantity;

        if (warehouse) {
          const availableBatches = await db
            .select({
              batchId: productBatches.id,
              batchNumber: productBatches.batchNumber,
              expirationDate: productBatches.expirationDate,
              centralStock: inventoryByBatch.quantity,
            })
            .from(productBatches)
            .innerJoin(
              inventoryByBatch,
              and(
                eq(inventoryByBatch.batchId, productBatches.id),
                eq(inventoryByBatch.locationId, warehouse.id),
              ),
            )
            .where(
              and(
                eq(productBatches.productId, pi.productId),
                gt(inventoryByBatch.quantity, 0),
              ),
            )
            .orderBy(asc(productBatches.expirationDate));

          for (const batch of availableBatches) {
            if (remaining <= 0) break;
            const allocQty = Math.min(remaining, batch.centralStock);
            allocations.push({
              productId: pi.productId,
              batchId: batch.batchId,
              quantity: allocQty,
              batchNumber: batch.batchNumber,
              expirationDate: batch.expirationDate,
            });
            remaining -= allocQty;
          }
        }

        allAllocations.push({ ...pi, allocations });
      }

      // 4. Crea ordine in transazione
      const result = await db.transaction(async (tx) => {
        const [order] = await tx
          .insert(orders)
          .values({
            retailerId: ctx.retailerId,
            status: "pending",
            subtotalNet: pricing.subtotalNet,
            vatAmount: pricing.vatAmount,
            totalGross: pricing.totalGross,
            discountPercent: pricing.discountPercent,
            notes: input.notes ?? null,
            notesInternal: `Ordine da portale partner — ${ctx.user.email}`,
            createdBy: ctx.user.id,
          })
          .returning();

        // Insert items con batch FEFO
        const itemValues: Array<{
          orderId: string;
          productId: string;
          quantity: number;
          unitPriceBase: string;
          discountPercent: string;
          unitPriceFinal: string;
          vatRate: string;
          lineTotalNet: string;
          lineTotalGross: string;
          productSku: string;
          productName: string;
          batchId: string | null;
        }> = [];

        for (const pi of allAllocations) {
          if (pi.allocations.length === 0) {
            itemValues.push({
              orderId: order.id,
              productId: pi.productId,
              quantity: pi.quantity,
              unitPriceBase: pi.unitPriceBase,
              discountPercent: pi.discountPercent,
              unitPriceFinal: pi.unitPriceFinal,
              vatRate: pi.vatRate,
              lineTotalNet: pi.lineTotalNet,
              lineTotalGross: pi.lineTotalGross,
              productSku: pi.productSku,
              productName: pi.productName,
              batchId: null,
            });
          } else {
            for (const alloc of pi.allocations) {
              const ratio = alloc.quantity / pi.quantity;
              const lineNet = (parseFloat(pi.lineTotalNet) * ratio).toFixed(2);
              const lineGross = (parseFloat(pi.lineTotalGross) * ratio).toFixed(2);
              itemValues.push({
                orderId: order.id,
                productId: pi.productId,
                quantity: alloc.quantity,
                unitPriceBase: pi.unitPriceBase,
                discountPercent: pi.discountPercent,
                unitPriceFinal: pi.unitPriceFinal,
                vatRate: pi.vatRate,
                lineTotalNet: lineNet,
                lineTotalGross: lineGross,
                productSku: pi.productSku,
                productName: pi.productName,
                batchId: alloc.batchId,
              });
            }
            // Residuo senza lotto
            const allocatedTotal = pi.allocations.reduce((s, a) => s + a.quantity, 0);
            const unallocated = pi.quantity - allocatedTotal;
            if (unallocated > 0) {
              const ratio = unallocated / pi.quantity;
              itemValues.push({
                orderId: order.id,
                productId: pi.productId,
                quantity: unallocated,
                unitPriceBase: pi.unitPriceBase,
                discountPercent: pi.discountPercent,
                unitPriceFinal: pi.unitPriceFinal,
                vatRate: pi.vatRate,
                lineTotalNet: (parseFloat(pi.lineTotalNet) * ratio).toFixed(2),
                lineTotalGross: (parseFloat(pi.lineTotalGross) * ratio).toFixed(2),
                productSku: pi.productSku,
                productName: pi.productName,
                batchId: null,
              });
            }
          }
        }

        if (itemValues.length > 0) {
          await tx.insert(orderItems).values(itemValues);
        }

        return order;
      });

      // 5. Genera proforma FiC (async, non blocca il checkout)
      let ficProformaId: number | null = null;
      let ficProformaNumber: string | null = null;
      try {
        const [retailer] = await db
          .select({
            ficClientId: retailers.ficClientId,
            name: retailers.name,
          })
          .from(retailers)
          .where(eq(retailers.id, ctx.retailerId))
          .limit(1);

        if (retailer?.ficClientId) {
          // Fetch items con batch info per proforma
          const items = await db
            .select({
              productName: orderItems.productName,
              quantity: orderItems.quantity,
              unitPriceFinal: orderItems.unitPriceFinal,
              vatRate: orderItems.vatRate,
              batchId: orderItems.batchId,
              batchNumber: productBatches.batchNumber,
              expirationDate: productBatches.expirationDate,
            })
            .from(orderItems)
            .leftJoin(productBatches, eq(orderItems.batchId, productBatches.id))
            .where(eq(orderItems.orderId, result.id));

          const ficItems = items.map((it) => {
            let description = "";
            if (it.batchId && it.batchNumber) {
              const expDate = it.expirationDate
                ? new Date(it.expirationDate).toLocaleDateString("it-IT")
                : "N/D";
              description = `Lotto: ${it.batchNumber} - Scadenza: ${expDate}`;
            }
            return {
              name: it.productName,
              description,
              qty: it.quantity,
              unitPriceFinal: it.unitPriceFinal,
              vatRate: it.vatRate,
            };
          });

          const proforma = await createFicProforma({
            ficClientId: retailer.ficClientId,
            date: new Date().toISOString().split("T")[0],
            orderNumber: result.orderNumber ?? undefined,
            totalGross: result.totalGross ? parseFloat(result.totalGross) : undefined,
            notesInternal: `Ordine ${result.orderNumber} — portale partner ${retailer.name}`,
            items: ficItems,
          });

          ficProformaId = proforma.id;
          ficProformaNumber = proforma.number;

          // Salva riferimento proforma
          await db
            .update(orders)
            .set({
              ficProformaId: proforma.id,
              ficProformaNumber: proforma.number,
              updatedAt: new Date(),
            })
            .where(eq(orders.id, result.id));
        }
      } catch (err) {
        console.error("[retailerCheckout] Errore generazione proforma FiC:", err);
        // Non blocca il checkout — proforma generabile manualmente dopo
      }

      // 6. Email conferma retailer
      try {
        await sendEmail({
          to: ctx.user.email,
          subject: `Ordine ${result.orderNumber} confermato - SoKeto`,
          html: buildRetailerConfirmationEmail({
            orderNumber: result.orderNumber ?? "N/D",
            items: pricing.items,
            subtotalNet: pricing.subtotalNet,
            vatAmount: pricing.vatAmount,
            totalGross: pricing.totalGross,
            discountPercent: pricing.discountPercent,
            packageName: pricing.packageName,
            ficProformaNumber,
          }),
        });
      } catch (err) {
        console.error("[retailerCheckout] Errore email conferma retailer:", err);
      }

      // 7. Email notifica admin
      try {
        const [retailer] = await db
          .select({ name: retailers.name })
          .from(retailers)
          .where(eq(retailers.id, ctx.retailerId))
          .limit(1);

        await sendEmail({
          to: "alessandro@soketo.it",
          subject: `Nuovo ordine da ${retailer?.name ?? "retailer"} — ${result.orderNumber}`,
          html: buildAdminNotificationEmail({
            orderNumber: result.orderNumber ?? "N/D",
            retailerName: retailer?.name ?? "N/D",
            totalGross: pricing.totalGross,
            itemCount: pricing.items.length,
          }),
        });
      } catch (err) {
        console.error("[retailerCheckout] Errore email notifica admin:", err);
      }

      return {
        orderId: result.id,
        orderNumber: result.orderNumber,
        ficProformaId,
        ficProformaNumber,
      };
    }),
});

// ============= Email Templates =============

function buildRetailerConfirmationEmail(params: {
  orderNumber: string;
  items: Array<{ productName: string; quantity: number; unitPriceFinal: string; lineTotalNet: string }>;
  subtotalNet: string;
  vatAmount: string;
  totalGross: string;
  discountPercent: string;
  packageName: string | null;
  ficProformaNumber: string | null;
}): string {
  const itemRows = params.items
    .map(
      (it) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${it.productName}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;text-align:center;">${it.quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;text-align:right;">&euro;${it.unitPriceFinal}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;text-align:right;">&euro;${it.lineTotalNet}</td>
        </tr>`,
    )
    .join("");

  const discountNote =
    parseFloat(params.discountPercent) > 0
      ? `<p style="margin:0 0 8px;color:#2D5A27;font-size:14px;font-weight:600;">Sconto pacchetto ${params.packageName ?? ""}: ${params.discountPercent}%</p>`
      : "";

  const proformaNote = params.ficProformaNumber
    ? `<p style="margin:16px 0 0;color:#4a4a4a;font-size:14px;">Proforma n. <strong>${params.ficProformaNumber}</strong> generata. La troverai nella sezione Documenti del portale.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:linear-gradient(135deg,#2D5A27 0%,#3a7a32 100%);padding:28px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">SoKeto</h1>
            <p style="margin:6px 0 0;color:#a8d5a2;font-size:13px;">Conferma Ordine</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="margin:0 0 8px;color:#1a1a1a;font-size:18px;">Ordine ${params.orderNumber} confermato</h2>
            <p style="margin:0 0 20px;color:#6a6a6a;font-size:14px;">Grazie per il tuo ordine. Di seguito il riepilogo.</p>
            ${discountNote}
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#f9f9f9;">
                  <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;">Prodotto</th>
                  <th style="padding:10px 12px;text-align:center;font-size:13px;color:#666;">Q.t&agrave;</th>
                  <th style="padding:10px 12px;text-align:right;font-size:13px;color:#666;">Prezzo</th>
                  <th style="padding:10px 12px;text-align:right;font-size:13px;color:#666;">Totale</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
            <table width="100%" style="margin-top:16px;">
              <tr>
                <td style="text-align:right;padding:4px 12px;font-size:14px;color:#666;">Subtotale netto:</td>
                <td style="text-align:right;padding:4px 12px;font-size:14px;width:100px;">&euro;${params.subtotalNet}</td>
              </tr>
              <tr>
                <td style="text-align:right;padding:4px 12px;font-size:14px;color:#666;">IVA:</td>
                <td style="text-align:right;padding:4px 12px;font-size:14px;width:100px;">&euro;${params.vatAmount}</td>
              </tr>
              <tr>
                <td style="text-align:right;padding:4px 12px;font-size:16px;font-weight:700;color:#1a1a1a;">Totale:</td>
                <td style="text-align:right;padding:4px 12px;font-size:16px;font-weight:700;width:100px;">&euro;${params.totalGross}</td>
              </tr>
            </table>
            ${proformaNote}
            <p style="margin:20px 0 0;color:#6a6a6a;font-size:13px;">
              Modalit&agrave; di pagamento: <strong>Bonifico anticipato</strong>.<br/>
              Riceverai i dettagli bancari nella proforma allegata.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#fafafa;padding:20px 40px;border-top:1px solid #eee;text-align:center;">
            <p style="margin:0;color:#7AB648;font-size:13px;font-weight:500;">Be Keto, Be Happy</p>
            <p style="margin:4px 0 0;color:#b0b0b0;font-size:12px;">Il team SoKeto</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildAdminNotificationEmail(params: {
  orderNumber: string;
  retailerName: string;
  totalGross: string;
  itemCount: number;
}): string {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:linear-gradient(135deg,#2D5A27 0%,#3a7a32 100%);padding:24px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">SoKeto — Nuovo Ordine</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:18px;">Ordine ${params.orderNumber}</h2>
            <table width="100%" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">
              <tr style="background:#f9f9f9;">
                <td style="padding:12px 16px;font-size:14px;color:#666;">Rivenditore</td>
                <td style="padding:12px 16px;font-size:14px;font-weight:600;">${params.retailerName}</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;font-size:14px;color:#666;border-top:1px solid #eee;">Prodotti</td>
                <td style="padding:12px 16px;font-size:14px;border-top:1px solid #eee;">${params.itemCount} referenze</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;font-size:14px;color:#666;border-top:1px solid #eee;">Totale lordo</td>
                <td style="padding:12px 16px;font-size:14px;font-weight:600;border-top:1px solid #eee;">&euro;${params.totalGross}</td>
              </tr>
            </table>
            <p style="margin:20px 0 0;color:#6a6a6a;font-size:13px;">
              Accedi al gestionale per visualizzare i dettagli e gestire l'ordine.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#fafafa;padding:16px 40px;border-top:1px solid #eee;text-align:center;">
            <p style="margin:0;color:#b0b0b0;font-size:12px;">Notifica automatica SoKeto Gestionale</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
