import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

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
 * Disponibile a qualsiasi utente autenticato (admin/operator/viewer).
 * Le mutation che modificano dati sono comunque vincolate dalle policy RLS
 * lato Supabase per accessi diretti dal client (futuri scenari).
 */
export const protectedProcedure = t.procedure.use(requireUser);

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
export const writerProcedure = t.procedure.use(requireWriter);

export const adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
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
  }),
);

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

export const retailerProcedure = t.procedure.use(requireRetailer);
