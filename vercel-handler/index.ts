/**
 * Source per la serverless function Vercel.
 *
 * Pre-bundlato con esbuild dallo script `build:api` (package.json), output
 * `api/index.js` (gitignored). Vercel vede il `.js` già completo e lo
 * deploya as-is — bypassando il bundling di @vercel/node che lasciava i
 * relative path verso `../server/*` non risolti a runtime
 * (ERR_MODULE_NOT_FOUND).
 *
 * Format: CJS (vedi `api/package.json` con type:commonjs). No top-level
 * await: il boot avviene lazy alla prima richiesta.
 *
 * Self-diagnostic: gli import dei moduli applicativi sono dinamici dentro
 * un try/catch nel boot. Se fallisce, la function risponde JSON con
 * name/message/stack invece del generico FUNCTION_INVOCATION_FAILED.
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
  await bootOnce();
  if (bootError) {
    res.status(500).setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        {
          error: true,
          phase: "boot",
          name: bootError.name,
          message: bootError.message,
          stack: bootError.stack,
          cause: bootError.cause ? String(bootError.cause) : undefined,
          nodeVersion: process.version,
        },
        null,
        2,
      ),
    );
    return;
  }
  try {
    return cachedApp!(req, res);
  } catch (err) {
    const e = err as Error;
    res.status(500).setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        {
          error: true,
          phase: "request",
          name: e.name,
          message: e.message,
          stack: e.stack,
        },
        null,
        2,
      ),
    );
  }
}
