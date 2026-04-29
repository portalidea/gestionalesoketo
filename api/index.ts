/**
 * Single serverless function entrypoint for Vercel.
 *
 * Vercel mappa tutto `/api/*` su questa funzione (vedi `vercel.json`).
 * L'app Express interna mantiene gli stessi path della versione locale
 * (`/api/trpc/*` e `/api/fattureincloud/*`), quindi il codice di
 * tRPC/FIC funziona invariato.
 *
 * Differenze vs `server/_core/index.ts` (dev locale):
 *  - Non istanzia un HTTP server (no `app.listen`): Vercel chiama
 *    `app(req, res)` direttamente per ogni invocazione.
 *  - Niente Vite middleware: Vercel serve direttamente i file statici
 *    da `dist/public` (vedi `outputDirectory` in vercel.json).
 *  - Niente static fallback: gestito da Vercel via rewrite SPA.
 *  - Niente import di `server/_core/loadEnv`: Vercel inietta le env
 *    vars dal pannello Project Settings; dotenv serve solo in dev e
 *    viene caricato da `server/_core/index.ts`.
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
