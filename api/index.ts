/**
 * Single serverless function entrypoint for Vercel.
 *
 * Vercel mappa tutto `/api/*` su questa funzione (vedi `vercel.json`).
 * @vercel/node compila questo file con esbuild e lo deploya: per portarsi
 * appresso il codice in `server/`, `shared/`, `drizzle/` (importato in modo
 * transitivo) usiamo `includeFiles` in `vercel.json` (vedi commento lì).
 *
 * Differenze vs `server/_core/index.ts` (dev locale):
 *  - No `app.listen`: Vercel chiama `app(req, res)` per ogni invocazione.
 *  - No middleware Vite, no static fallback: i file statici sono serviti
 *    direttamente da Vercel (`outputDirectory: dist/public`); l'SPA
 *    fallback è gestito via rewrite in vercel.json.
 *  - No `loadEnv`: in produzione le env vars sono iniettate dal runtime
 *    Vercel; dotenv serve solo in dev (lo carica `server/_core/index.ts`).
 */
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import { createContext } from "../server/_core/context";
import fattureInCloudRoutes from "../server/fattureincloud-routes";
import { appRouter } from "../server/routers";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Fatture in Cloud: OAuth callback + webhook (path /api/fattureincloud/*)
app.use("/api", fattureInCloudRoutes);

// tRPC: tutte le procedure sotto /api/trpc/*
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

export default app;
