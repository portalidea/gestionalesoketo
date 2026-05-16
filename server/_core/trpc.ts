import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * M6.1.3: Timeout middleware globale (rete di sicurezza).
 * Previene FUNCTION_INVOCATION_TIMEOUT (60s) su Vercel limitando
 * ogni procedura a 8s. Se scatta, logga QUALE procedura ha sforato.
 */
const PROCEDURE_TIMEOUT_MS = 8_000;

const withTimeout = t.middleware(async ({ next, path, type }) => {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new TRPCError({
            code: "TIMEOUT",
            message: `Procedure ${path} (${type}) exceeded ${PROCEDURE_TIMEOUT_MS}ms`,
          }),
        ),
      PROCEDURE_TIMEOUT_MS,
    ),
  );
  return Promise.race([next(), timeoutPromise]);
});

// ═══════════════════════════════════════════════════════════
// Base procedures — ALL include timeout middleware
// ═══════════════════════════════════════════════════════════

export const publicProcedure = t.procedure.use(withTimeout);

const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/**
 * Disponibile a qualsiasi utente autenticato (admin/operator/viewer/retailer).
 */
export const protectedProcedure = t.procedure.use(withTimeout).use(requireUser);

const requireWriter = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  if (ctx.user.role === "viewer") {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/**
 * Per mutazioni che richiedono ruolo admin o operator (esclude viewer).
 */
export const writerProcedure = t.procedure.use(withTimeout).use(requireWriter);

const requireAdmin = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const adminProcedure = t.procedure.use(withTimeout).use(requireAdmin);

/**
 * M6.1: Per utenti retailer (retailer_admin o retailer_user).
 * Inietta ctx.retailerId dal profilo utente.
 */
const requireRetailer = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  if (ctx.user.role !== "retailer_admin" && ctx.user.role !== "retailer_user") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Accesso riservato agli utenti del portale partner.",
    });
  }
  if (!ctx.user.retailerId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Utente retailer senza retailerId associato.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      retailerId: ctx.user.retailerId,
    },
  });
});

export const retailerProcedure = t.procedure.use(withTimeout).use(requireRetailer);

/**
 * M6.1.1: Per procedure accessibili solo allo staff interno (admin, operator, viewer).
 * Blocca retailer_admin e retailer_user.
 */
const requireStaff = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  const staffRoles = ["admin", "operator", "viewer"];
  if (!staffRoles.includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Accesso riservato allo staff interno.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const staffProcedure = t.procedure.use(withTimeout).use(requireStaff);
