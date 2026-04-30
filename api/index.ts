/**
 * Single serverless function entrypoint for Vercel.
 *
 * Vercel mappa tutto `/api/*` su questa funzione (vedi `vercel.json`).
 *
 * Self-diagnostic: tutti gli import dei moduli applicativi sono dinamici
 * dentro un try/catch. Se il boot fallisce (es. ERR_MODULE_NOT_FOUND), la
 * function restituisce JSON con name/message/stack invece del generico
 * `FUNCTION_INVOCATION_FAILED` di Vercel.
 */
import express from "express";
import type { Express, Request, Response } from "express";

let cachedApp: Express | null = null;
let bootError: Error | null = null;

try {
  const [
    trpcAdapter,
    contextMod,
    ficRoutesMod,
    routersMod,
  ] = await Promise.all([
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
  console.error("[api/index] boot failed:", err);
}

export default function handler(req: Request, res: Response) {
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
