import type { Express } from "express";

/**
 * Espone gli asset persistenti caricati per il progetto senza inserire file binari
 * nel repository. Il percorso pubblico non rivela né restituisce credenziali Forge.
 */
export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string | undefined>)["0"];
    const forgeApiUrl = process.env.BUILT_IN_FORGE_API_URL;
    const forgeApiKey = process.env.BUILT_IN_FORGE_API_KEY;

    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!forgeApiUrl || !forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      const forgeUrl = new URL("v1/storage/presign/get", `${forgeApiUrl.replace(/\/+$/, "")}/`);
      forgeUrl.searchParams.set("path", key);
      const forgeResponse = await fetch(forgeUrl, { headers: { Authorization: `Bearer ${forgeApiKey}` } });
      if (!forgeResponse.ok) {
        console.error(`[StorageProxy] forge error: ${forgeResponse.status}`);
        res.status(502).send("Storage backend error");
        return;
      }

      const payload = await forgeResponse.json() as { url?: string };
      if (!payload.url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      res.set("Cache-Control", "no-store");
      res.redirect(307, payload.url);
    } catch (error) {
      console.error("[StorageProxy] failed", error);
      res.status(502).send("Storage proxy error");
    }
  });
}
