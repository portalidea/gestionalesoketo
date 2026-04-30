/**
 * Source per la serverless function Vercel.
 *
 * Pre-bundlato con esbuild (`pnpm build:api`) → `api/index.js` (gitignored).
 * CJS, no top-level await, boot lazy alla prima richiesta.
 */
import express from "express";
import type { Express, Request, Response } from "express";

let cachedApp: Express | null = null;
let bootError: Error | null = null;
let bootPromise: Promise<void> | null = null;

function bootOnce(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      const [trpcAdapter, contextMod, ficRoutesMod, routersMod] = await Promise.all([
        import("@trpc/server/adapters/express"),
        import("../server/_core/context"),
        import("../server/fattureincloud-routes"),
        import("../server/routers"),
      ]);

      const app = express();
      app.use(express.json({ limit: "50mb" }));
      app.use(express.urlencoded({ limit: "50mb", extended: true }));
      app.use("/api", ficRoutesMod.default);
      app.use(
        "/api/trpc",
        trpcAdapter.createExpressMiddleware({
          router: routersMod.appRouter,
          createContext: contextMod.createContext,
        }),
      );
      cachedApp = app;
    } catch (err) {
      bootError = err as Error;
      console.error("[vercel-handler] boot failed:", err);
    }
  })();
  return bootPromise;
}

export default async function handler(req: Request, res: Response) {
  // Fast-path /api/health: liveness probe minimal, no DB, no boot.
  // Vercel rewrite può sostituire req.url; originalUrl preserva l'originale.
  const rawPath = (req.originalUrl ?? req.url ?? "").split("?")[0];
  const path = rawPath.replace(/\/+$/, "");
  if (path === "/api/health") {
    res.status(200).setHeader("content-type", "application/json");
    res.end('{"ok":true}');
    return;
  }

  await bootOnce();
  if (bootError) {
    // Boot fallito: log dettagliato per Vercel runtime logs, risposta generica.
    res.status(500).setHeader("content-type", "application/json");
    res.end('{"error":"Service unavailable"}');
    return;
  }
  try {
    return cachedApp!(req, res);
  } catch (err) {
    console.error("[vercel-handler] request error:", err);
    res.status(500).setHeader("content-type", "application/json");
    res.end('{"error":"Internal server error"}');
  }
}
