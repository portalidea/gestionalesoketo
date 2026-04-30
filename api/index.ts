/**
 * Single serverless function entrypoint for Vercel.
 *
 * Vercel mappa tutto `/api/*` su questa funzione (vedi `vercel.json`).
 *
 * Static imports (gli stessi del dev) per forzare ncc/esbuild di Vercel a
 * bundlare tutto il grafo server/* dentro l'output. Se gli import falliscono
 * a livello di modulo, la function non parte e Vercel ritorna
 * `FUNCTION_INVOCATION_FAILED`. Per gli errori che arrivano dopo l'import
 * (es. env validation, db init lazy) la response è il JSON diagnostico in
 * coda al file.
 */
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import type { Express, Request, Response } from "express";
import { createContext } from "../server/_core/context";
import fattureInCloudRoutes from "../server/fattureincloud-routes";
import { appRouter } from "../server/routers";

let cachedApp: Express | null = null;
let bootError: Error | null = null;

try {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use("/api", fattureInCloudRoutes);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
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
