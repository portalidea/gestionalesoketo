/**
 * M11.A — Company Context Middleware
 *
 * Reads `x-active-company-id` from request headers.
 * If absent, falls back to the user's default company (isDefault=true in userCompanyAccess).
 * Verifies the user has access to the resolved company.
 * Injects `ctx.activeCompanyId` for downstream procedures.
 */
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db";
import { userCompanyAccess } from "../../drizzle/schema";
import { initTRPC } from "@trpc/server";
import type { TrpcContext } from "./context";

// We need access to the t instance from trpc.ts, so we export a factory
// that takes the middleware builder from the existing t instance.

/**
 * Resolves the active company for the current user.
 * Called by the middleware — separated for testability.
 */
export async function resolveActiveCompanyId(
  userId: string,
  headerCompanyId: string | undefined,
): Promise<string> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB non disponibile" });

  if (headerCompanyId) {
    // Verify user has access to this company
    const [access] = await db
      .select({ companyId: userCompanyAccess.companyId })
      .from(userCompanyAccess)
      .where(
        and(
          eq(userCompanyAccess.userId, userId),
          eq(userCompanyAccess.companyId, headerCompanyId),
        ),
      )
      .limit(1);

    if (!access) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `User has no access to company ${headerCompanyId}`,
      });
    }
    return headerCompanyId;
  }

  // No header — use default company
  const [defaultAccess] = await db
    .select({ companyId: userCompanyAccess.companyId })
    .from(userCompanyAccess)
    .where(
      and(
        eq(userCompanyAccess.userId, userId),
        eq(userCompanyAccess.isDefault, true),
      ),
    )
    .limit(1);

  if (!defaultAccess) {
    // Fallback: pick first available company
    const [anyAccess] = await db
      .select({ companyId: userCompanyAccess.companyId })
      .from(userCompanyAccess)
      .where(eq(userCompanyAccess.userId, userId))
      .limit(1);

    if (!anyAccess) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Utente senza accesso a nessuna company, contatta admin.",
      });
    }
    return anyAccess.companyId;
  }

  return defaultAccess.companyId;
}
