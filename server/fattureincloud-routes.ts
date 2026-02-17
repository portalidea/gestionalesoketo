/**
 * Fatture in Cloud Express Routes
 * Gestisce OAuth callback e webhook
 */

import { Router } from "express";
import { exchangeCodeForTokens, getOAuthConfig } from "./fattureincloud-oauth";
import { syncRetailerData } from "./fattureincloud-sync";
import * as db from "./db";

const router = Router();

/**
 * OAuth2 Callback - Riceve authorization code e completa autenticazione
 */
router.get("/fattureincloud/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || typeof code !== "string") {
      return res.status(400).send("Missing authorization code");
    }

    if (!state || typeof state !== "string") {
      return res.status(400).send("Missing state parameter");
    }

    // Parse state per ottenere retailerId
    let retailerId: number;
    try {
      const stateData = JSON.parse(state);
      retailerId = stateData.retailerId;
    } catch (error) {
      return res.status(400).send("Invalid state parameter");
    }

    // Verifica che il rivenditore esista
    const retailer = await db.getRetailerById(retailerId);
    if (!retailer) {
      return res.status(404).send("Retailer not found");
    }

    // Ottieni configurazione OAuth
    const config = getOAuthConfig();
    if (!config) {
      return res.status(500).send("OAuth configuration not available");
    }

    // Scambia code con tokens
    const tokens = await exchangeCodeForTokens(config, code);

    // Calcola scadenza token
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokens.expires_in);

    // Salva tokens nel database
    await db.updateRetailer(retailerId, {
      fattureInCloudAccessToken: tokens.access_token,
      fattureInCloudRefreshToken: tokens.refresh_token,
      fattureInCloudTokenExpiresAt: expiresAt,
      syncEnabled: 1,
    });

    // Avvia sincronizzazione iniziale in background
    syncRetailerData(retailerId).catch((error) => {
      console.error(`[OAuth Callback] Initial sync failed for retailer ${retailerId}:`, error);
    });

    // Redirect al frontend con successo
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Connessione Completata</title>
        <style>
          body {
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #0a0a0a;
            color: #fff;
          }
          .container {
            text-align: center;
            padding: 2rem;
          }
          .success-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
          }
          h1 {
            color: #10b981;
            margin-bottom: 1rem;
          }
          p {
            color: #9ca3af;
            margin-bottom: 2rem;
          }
          button {
            background: #10b981;
            color: white;
            border: none;
            padding: 0.75rem 2rem;
            border-radius: 0.5rem;
            font-size: 1rem;
            cursor: pointer;
          }
          button:hover {
            background: #059669;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-icon">✓</div>
          <h1>Connessione Completata!</h1>
          <p>Il tuo account Fatture in Cloud è stato collegato con successo.<br>La sincronizzazione iniziale è in corso.</p>
          <button onclick="window.close()">Chiudi questa finestra</button>
          <script>
            setTimeout(() => {
              window.opener?.postMessage({ type: 'oauth_success', retailerId: ${retailerId} }, '*');
              setTimeout(() => window.close(), 1000);
            }, 2000);
          </script>
        </div>
      </body>
      </html>
    `);
  } catch (error: any) {
    console.error("[OAuth Callback] Error:", error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Errore Connessione</title>
        <style>
          body {
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #0a0a0a;
            color: #fff;
          }
          .container {
            text-align: center;
            padding: 2rem;
          }
          .error-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
          }
          h1 {
            color: #ef4444;
            margin-bottom: 1rem;
          }
          p {
            color: #9ca3af;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error-icon">✗</div>
          <h1>Errore di Connessione</h1>
          <p>${error.message}</p>
        </div>
      </body>
      </html>
    `);
  }
});

/**
 * Webhook - Riceve notifiche da Fatture in Cloud
 * Nota: Fatture in Cloud supporta webhook per eventi come creazione/modifica documenti
 */
router.post("/fattureincloud/webhook", async (req, res) => {
  try {
    const { event, company_id, data } = req.body;

    console.log("[Webhook] Received event:", { event, company_id });

    // Trova rivenditore per company_id
    const retailers = await db.getAllRetailers();
    const retailer = retailers.find(
      (r) => r.fattureInCloudCompanyId === company_id?.toString()
    );

    if (!retailer) {
      console.warn(`[Webhook] No retailer found for company_id ${company_id}`);
      return res.status(404).json({ error: "Retailer not found" });
    }

    // Gestisci eventi specifici
    switch (event) {
      case "issued_document.created":
      case "issued_document.updated":
      case "issued_document.deleted":
        // Avvia sincronizzazione movimenti in background
        syncRetailerData(retailer.id).catch((error) => {
          console.error(`[Webhook] Sync failed for retailer ${retailer.id}:`, error);
        });
        break;

      case "product.created":
      case "product.updated":
      case "product.deleted":
        // Avvia sincronizzazione prodotti in background
        syncRetailerData(retailer.id).catch((error) => {
          console.error(`[Webhook] Sync failed for retailer ${retailer.id}:`, error);
        });
        break;

      default:
        console.log(`[Webhook] Unhandled event type: ${event}`);
    }

    // Rispondi sempre 200 OK per confermare ricezione
    res.status(200).json({ received: true });
  } catch (error: any) {
    console.error("[Webhook] Error processing webhook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
