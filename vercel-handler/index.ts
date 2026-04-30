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
  // Fast-path: /api/health risponde senza richiedere il boot completo.
  // Serve come liveness probe e diagnostico: ci dice quali env sono
  // visibili nel runtime Vercel e se il boot è stato già tentato.
  // Vercel può modificare req.url dopo il rewrite in vercel.json (la
  // destination "/api" droppa il path catturato), ma originalUrl
  // preserva la richiesta originale. Match su entrambi, tollera query
  // string e trailing slash.
  const rawPath = (req.originalUrl ?? req.url ?? "").split("?")[0];
  const path = rawPath.replace(/\/+$/, "");
  if (path === "/api/health" || path === "/api/ping") {
    const envSummary = {
      DATABASE_URL: process.env.DATABASE_URL ? "set" : "missing",
      SUPABASE_URL: process.env.SUPABASE_URL ? "set" : "missing",
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? "set" : "missing",
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing",
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ? "set" : "missing",
      OWNER_EMAIL: process.env.OWNER_EMAIL ? "set" : "missing",
      FATTUREINCLOUD_CLIENT_ID: process.env.FATTUREINCLOUD_CLIENT_ID ? "set" : "missing",
      FATTUREINCLOUD_CLIENT_SECRET: process.env.FATTUREINCLOUD_CLIENT_SECRET ? "set" : "missing",
      FATTUREINCLOUD_REDIRECT_URI: process.env.FATTUREINCLOUD_REDIRECT_URI ?? "missing",
      VERCEL: process.env.VERCEL ?? "missing",
      VERCEL_ENV: process.env.VERCEL_ENV ?? "missing",
      VERCEL_REGION: process.env.VERCEL_REGION ?? "missing",
      NODE_ENV: process.env.NODE_ENV ?? "missing",
    };
    res.status(200).setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        {
          ok: true,
          marker: "vercel-handler-alive",
          url: req.url,
          method: req.method,
          bootStarted: !!bootPromise,
          bootError: bootError ? { name: bootError.name, message: bootError.message } : null,
          nodeVersion: process.version,
          env: envSummary,
        },
        null,
        2,
      ),
    );
    return;
  }

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
