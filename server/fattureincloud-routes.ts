/**
 * Fatture in Cloud Express Routes
 * M11.C: Only the per-company SSO callback is active.
 * Legacy per-retailer callback and webhook are deprecated stubs.
 */

import { Router } from "express";
import { completeFicOAuth } from "./fic-integration";

const router = Router();

/**
 * Phase B M3 / M11.C — Per-company OAuth callback (popup flow).
 *
 * The frontend opens a popup to the FiC authorization URL.
 * On success, FiC redirects here with `code` + `state`.
 * State contains the companyId target.
 * completeFicOAuth handles token exchange + storage in ficConnections.
 * On success: closes the popup and notifies the parent via postMessage.
 */
router.get("/fattureincloud/sso/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || typeof code !== "string") {
      return res.status(400).send("Missing authorization code");
    }

    // M11.C: state is validated as a simple marker
    if (state !== "soketo-single-tenant" && !(typeof state === "string" && state.length > 0)) {
      return res.status(400).send("Invalid state");
    }

    const result = await completeFicOAuth(code);

    res.send(`
      <!DOCTYPE html>
      <html><head><title>FiC connesso</title>
      <style>body{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.container{text-align:center;padding:2rem}.success-icon{font-size:4rem;margin-bottom:1rem}h1{color:#10b981;margin-bottom:1rem}p{color:#9ca3af;margin-bottom:2rem}button{background:#10b981;color:#fff;border:0;padding:.75rem 2rem;border-radius:.5rem;font-size:1rem;cursor:pointer}button:hover{background:#059669}</style>
      </head><body>
      <div class="container">
        <div class="success-icon">✓</div>
        <h1>Fatture in Cloud connesso</h1>
        <p>Account: ${result.companyName}<br>Company ID FiC: ${result.companyId}</p>
        <button onclick="window.close()">Chiudi</button>
        <script>
          setTimeout(() => {
            window.opener?.postMessage({ type: 'fic_sso_success', companyId: ${result.companyId} }, '*');
            setTimeout(() => window.close(), 1000);
          }, 1500);
        </script>
      </div></body></html>
    `);
  } catch (err: any) {
    console.error("[fic sso callback] error:", err);
    const msg = (err?.message ?? "errore").toString().replace(/[<>]/g, "");
    res.status(500).send(`
      <!DOCTYPE html>
      <html><head><title>Errore</title>
      <style>body{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.container{text-align:center;padding:2rem}.error-icon{font-size:4rem;margin-bottom:1rem}h1{color:#ef4444}p{color:#9ca3af}</style>
      </head><body><div class="container">
        <div class="error-icon">✗</div>
        <h1>Errore connessione FiC</h1>
        <p>${msg}</p>
      </div></body></html>
    `);
  }
});

/**
 * LEGACY OAuth2 Callback — DEPRECATED by M11.C (per-company flow via /fattureincloud/sso/callback)
 * Kept as stub to avoid 404 if old links are still bookmarked.
 */
router.get("/fattureincloud/callback", async (_req, res) => {
  res.status(410).send("Questo endpoint è deprecato. Usa /settings/integrations per connettere FiC.");
});

/**
 * LEGACY Webhook Handler — DEPRECATED by M11.C.
 * Kept as stub to avoid 404 from FiC webhook pings.
 */
router.post("/fattureincloud/webhook", async (_req, res) => {
  // M11.C: webhook per-retailer non più supportato.
  // Il nuovo flusso non usa webhook FiC (proforma generate on-demand).
  res.status(200).json({ received: true, deprecated: true });
});

export default router;
