/**
 * M11.A + M11.B — Companies Router
 *
 * Procedures:
 * - listMine: company a cui l'utente ha accesso (staff)
 * - getActive: company attiva corrente (staff)
 * - listAll: tutte le company nel sistema (admin)
 * - update: modifica dati company (admin)
 * - listUserAccess: utenti con accesso a una company (admin)
 * - grantUserAccess: concedi accesso utente a company (admin)
 * - revokeUserAccess: revoca accesso utente da company (admin)
 * - setUserDefault: imposta company default per un utente (admin)
 * - listUsers: lista utenti per select (admin)
 */
import { eq, and, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { staffProcedure, adminProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { companies, userCompanyAccess, users } from "../drizzle/schema";
import { uuidSchema } from "../shared/schemas";

export const companiesRouter = router({
  /**
   * Ritorna le company a cui l'utente corrente ha accesso.
   * Output: [{ id, name, isDefault, isActive }]
   */
  listMine: staffProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({
        id: companies.id,
        name: companies.name,
        isDefault: userCompanyAccess.isDefault,
        isActive: companies.isActive,
      })
      .from(userCompanyAccess)
      .innerJoin(companies, eq(companies.id, userCompanyAccess.companyId))
      .where(eq(userCompanyAccess.userId, ctx.user!.id));

    return rows;
  }),

  /**
   * Ritorna la company attiva (risolta dal middleware companyContext).
   * Output: { id, name, isActive }
   */
  getActive: staffProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB non disponibile");

    const [company] = await db
      .select({
        id: companies.id,
        name: companies.name,
        isActive: companies.isActive,
        vatNumber: companies.vatNumber,
        fiscalCode: companies.fiscalCode,
      })
      .from(companies)
      .where(eq(companies.id, ctx.activeCompanyId))
      .limit(1);

    return company ?? null;
  }),

  /**
   * M11.B: Ritorna TUTTE le company nel sistema (admin only).
   * Per la pagina /settings/companies.
   */
  listAll: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({
        id: companies.id,
        name: companies.name,
        vatNumber: companies.vatNumber,
        fiscalCode: companies.fiscalCode,
        isActive: companies.isActive,
        createdAt: companies.createdAt,
      })
      .from(companies)
      .orderBy(companies.name);

    return rows;
  }),

  /**
   * M11.B: Modifica dati di una company (admin only).
   * Verifica che l'admin abbia accesso alla company target.
   */
  update: adminProcedure
    .input(
      z.object({
        id: uuidSchema,
        name: z.string().min(1).optional(),
        vatNumber: z.string().max(20).nullable().optional(),
        fiscalCode: z.string().max(20).nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify admin has access to this company
      const [access] = await db
        .select({ companyId: userCompanyAccess.companyId })
        .from(userCompanyAccess)
        .where(
          and(
            eq(userCompanyAccess.userId, ctx.user!.id),
            eq(userCompanyAccess.companyId, input.id),
          ),
        )
        .limit(1);

      if (!access) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Non hai accesso a questa azienda.",
        });
      }

      const updateData: Record<string, any> = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.vatNumber !== undefined) updateData.vatNumber = input.vatNumber;
      if (input.fiscalCode !== undefined) updateData.fiscalCode = input.fiscalCode;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;

      if (Object.keys(updateData).length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Nessun campo da aggiornare." });
      }

      await db
        .update(companies)
        .set(updateData)
        .where(eq(companies.id, input.id));

      return { success: true };
    }),

  /**
   * M11.B: Lista utenti con accesso a una company (admin only).
   */
  listUserAccess: adminProcedure
    .input(z.object({ companyId: uuidSchema }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];

      const rows = await db
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          isDefault: userCompanyAccess.isDefault,
        })
        .from(userCompanyAccess)
        .innerJoin(users, eq(users.id, userCompanyAccess.userId))
        .where(eq(userCompanyAccess.companyId, input.companyId))
        .orderBy(users.email);

      return rows;
    }),

  /**
   * M11.B: Concedi accesso utente a una company (admin only).
   */
  grantUserAccess: adminProcedure
    .input(
      z.object({
        userId: uuidSchema,
        companyId: uuidSchema,
        isDefault: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify target user exists
      const [targetUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);

      if (!targetUser) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Utente non trovato." });
      }

      // If isDefault=true, unset other defaults for this user
      if (input.isDefault) {
        await db
          .update(userCompanyAccess)
          .set({ isDefault: false })
          .where(
            and(
              eq(userCompanyAccess.userId, input.userId),
              ne(userCompanyAccess.companyId, input.companyId),
            ),
          );
      }

      // Insert access (or update isDefault if already exists)
      await db
        .insert(userCompanyAccess)
        .values({
          userId: input.userId,
          companyId: input.companyId,
          isDefault: input.isDefault,
        })
        .onConflictDoUpdate({
          target: [userCompanyAccess.userId, userCompanyAccess.companyId],
          set: { isDefault: input.isDefault },
        });

      return { success: true };
    }),

  /**
   * M11.B: Revoca accesso utente da una company (admin only).
   * Validazioni:
   * - NON consentire di revocare l'ultimo accesso di un utente
   * - NON consentire di revocare il proprio accesso alla company attiva
   */
  revokeUserAccess: adminProcedure
    .input(
      z.object({
        userId: uuidSchema,
        companyId: uuidSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Guard: cannot revoke own access to currently active company
      if (input.userId === ctx.user!.id && input.companyId === ctx.activeCompanyId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Non puoi revocare il tuo accesso alla company attualmente attiva. Switcha azienda prima.",
        });
      }

      // Guard: cannot revoke last access of a user
      const accessCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userCompanyAccess)
        .where(eq(userCompanyAccess.userId, input.userId));

      if (accessCount[0]?.count <= 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "L'utente perderebbe accesso a tutte le company. Concedi accesso ad un'altra company prima di revocare questa.",
        });
      }

      // Delete the access
      await db
        .delete(userCompanyAccess)
        .where(
          and(
            eq(userCompanyAccess.userId, input.userId),
            eq(userCompanyAccess.companyId, input.companyId),
          ),
        );

      // If the revoked access was the user's default, set another as default
      const [remainingDefault] = await db
        .select({ id: userCompanyAccess.companyId })
        .from(userCompanyAccess)
        .where(
          and(
            eq(userCompanyAccess.userId, input.userId),
            eq(userCompanyAccess.isDefault, true),
          ),
        )
        .limit(1);

      if (!remainingDefault) {
        // No default left — set first remaining as default
        const [firstRemaining] = await db
          .select({ companyId: userCompanyAccess.companyId })
          .from(userCompanyAccess)
          .where(eq(userCompanyAccess.userId, input.userId))
          .limit(1);

        if (firstRemaining) {
          await db
            .update(userCompanyAccess)
            .set({ isDefault: true })
            .where(
              and(
                eq(userCompanyAccess.userId, input.userId),
                eq(userCompanyAccess.companyId, firstRemaining.companyId),
              ),
            );
        }
      }

      return { success: true };
    }),

  /**
   * M11.B: Imposta company default per un utente (admin only).
   * Assicura esattamente un default per utente.
   */
  setUserDefault: adminProcedure
    .input(
      z.object({
        userId: uuidSchema,
        companyId: uuidSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify the user actually has access to this company
      const [access] = await db
        .select({ companyId: userCompanyAccess.companyId })
        .from(userCompanyAccess)
        .where(
          and(
            eq(userCompanyAccess.userId, input.userId),
            eq(userCompanyAccess.companyId, input.companyId),
          ),
        )
        .limit(1);

      if (!access) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "L'utente non ha accesso a questa company.",
        });
      }

      // Unset all defaults for this user
      await db
        .update(userCompanyAccess)
        .set({ isDefault: false })
        .where(eq(userCompanyAccess.userId, input.userId));

      // Set the new default
      await db
        .update(userCompanyAccess)
        .set({ isDefault: true })
        .where(
          and(
            eq(userCompanyAccess.userId, input.userId),
            eq(userCompanyAccess.companyId, input.companyId),
          ),
        );

      return { success: true };
    }),

  /**
   * M11.B: Lista utenti per la select "Aggiungi utente" (admin only).
   * Ritorna tutti gli utenti staff (admin/operator/viewer).
   */
  listUsers: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      })
      .from(users)
      .orderBy(users.email);

    return rows;
  }),
});
