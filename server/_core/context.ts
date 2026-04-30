import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

// Supabase firma i JWT con ECDSA P-256 (ES256) usando le JWT Signing
// Keys pubblicate via JWKS. Il legacy HS256 secret resta nel progetto
// come "Previous Key" ma i nuovi token sono firmati con la Current
// (asimmetrica), quindi HS256+secret non li verifica più.
// `createRemoteJWKSet` cacha le chiavi in memory e le ri-fetcha solo
// quando incontra un `kid` sconosciuto.
const SUPABASE_ISSUER = `${ENV.supabase.url}/auth/v1`;
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`),
);

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verifica il JWT Supabase nel header Authorization e carica il profilo
 * applicativo da public.users. Se il JWT è valido ma manca la riga in
 * public.users (caso teoricamente impossibile dopo il trigger
 * handle_new_user, ma difensivo), torniamo null e la procedura protetta
 * rifiuterà la richiesta.
 */
export async function createContext(
  opts: CreateExpressContextOptions,
): Promise<TrpcContext> {
  const token = extractBearerToken(opts.req.headers.authorization);
  let user: User | null = null;

  if (token) {
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        algorithms: ["ES256"],
        issuer: SUPABASE_ISSUER,
        audience: "authenticated",
      });
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      if (sub) {
        user = (await db.getUserById(sub)) ?? null;
      }
    } catch (error) {
      // Token invalido o scaduto: lasciamo user null, le procedure protette
      // risponderanno con UNAUTHORIZED.
      if (process.env.NODE_ENV !== "production") {
        const e = error as Error;
        console.warn(`[Auth] JWT verification failed (${e.name}): ${e.message}`);
      }
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
