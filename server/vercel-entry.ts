/**
 * Sorgente della serverless function Vercel.
 *
 * Questo file viene bundlato da esbuild (`pnpm build:api`) in
 * `api/index.js`, che è il vero entrypoint deployato. Vivendo fuori da
 * `api/`, evitiamo che Vercel veda due entrypoint con lo stesso nome
 * (sorgente .ts e bundle .js).
 *
 * L'app Express interna mantiene gli stessi path della versione locale
 * (`/api/trpc/*` e `/api/fattureincloud/*`), quindi tRPC/FIC funzionano
 * invariati. Differenze vs `server/_core/index.ts` (dev):
 *  - No `app.listen`: Vercel chiama `app(req, res)` per ogni invocazione.
 *  - No middleware Vite e no static fallback: i file statici sono serviti
 *    direttamente da Vercel (`outputDirectory: dist/public`) e l'SPA
 *    fallback è gestito via rewrite in vercel.json.
 *  - No `loadEnv`: in produzione le env vars sono iniettate dal runtime
 *    Vercel; dotenv serve solo in dev e lo carica `server/_core/index.ts`.
 */
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import { createContext } from "./_core/context";
import fattureInCloudRoutes from "./fattureincloud-routes";
import { appRouter } from "./routers";

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
