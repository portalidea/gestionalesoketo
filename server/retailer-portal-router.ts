/**
 * M6.1 — Retailer Portal Router
 *
 * Procedure admin-only per gestione utenti portale retailer
 * + procedure retailer per dashboard portale partner.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  adminProcedure,
  retailerProcedure,
  router,
} from "./_core/trpc";
import { supabaseAdmin } from "./_core/supabase";
import * as db from "./db";
import { sendEmail } from "./email";

const uuid = z.string().uuid();
const retailerRoleSchema = z.enum(["retailer_admin", "retailer_user"]);

/**
 * Genera l'HTML dell'email di invito al portale partner.
 */
function buildInviteEmailHtml(params: {
  retailerName: string;
  magicLink: string;
  role: string;
}): string {
  const roleLabel = params.role === "retailer_admin" ? "Amministratore" : "Operatore";
  return `
<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2D5A27 0%,#3a7a32 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
              SoKeto
            </h1>
            <p style="margin:8px 0 0;color:#a8d5a2;font-size:14px;">Portale Partner</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:20px;font-weight:600;">
              Sei stato invitato!
            </h2>
            <p style="margin:0 0 12px;color:#4a4a4a;font-size:15px;line-height:1.6;">
              Sei stato invitato come <strong>${roleLabel}</strong> al portale di
              <strong>${params.retailerName}</strong> su SoKeto.
            </p>
            <p style="margin:0 0 28px;color:#4a4a4a;font-size:15px;line-height:1.6;">
              Clicca il bottone qui sotto per accedere al portale e iniziare a gestire
              ordini, magazzino e documenti.
            </p>
            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center">
                <a href="${params.magicLink}"
                   style="display:inline-block;background:#2D5A27;color:#ffffff;font-size:16px;font-weight:600;
                          padding:14px 36px;border-radius:8px;text-decoration:none;
                          box-shadow:0 2px 4px rgba(45,90,39,0.3);">
                  Accedi al portale
                </a>
              </td></tr>
            </table>
            <p style="margin:28px 0 0;color:#9a9a9a;font-size:13px;line-height:1.5;">
              Se non hai richiesto questo invito, puoi ignorare questa email in sicurezza.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#fafafa;padding:24px 40px;border-top:1px solid #eee;text-align:center;">
            <p style="margin:0;color:#7AB648;font-size:13px;font-weight:500;">
              Be Keto, Be Happy
            </p>
            <p style="margin:4px 0 0;color:#b0b0b0;font-size:12px;">
              Il team SoKeto
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export const retailerPortalRouter = router({
  // ============= ADMIN: Gestione utenti portale =============

  /**
   * Lista utenti associati a un retailer.
   *
   * BUGFIX 2026-05-15: aggiunto timeout 5s per chiamata Supabase Auth
   * per evitare che una singola getUserById lenta blocchi l'intero
   * batch httpBatchLink (causa del timeout 60s su /retailers/:id).
   */
  listUsers: adminProcedure
    .input(z.object({ retailerId: uuid }))
    .query(async ({ input }) => {
      const tTotal = Date.now();
      const portalUsers = await db.getUsersByRetailerId(input.retailerId);

      // Arricchisci con last_sign_in_at da Supabase Auth.
      // Ogni chiamata ha timeout 5s via Promise.race + fallback graceful.
      const SUPABASE_AUTH_TIMEOUT_MS = 5_000;
      const enriched = await Promise.all(
        portalUsers.map(async (u) => {
          const tUser = Date.now();
          try {
            const authPromise = supabaseAdmin.auth.admin.getUserById(u.id);
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Timeout ${SUPABASE_AUTH_TIMEOUT_MS}ms`)),
                SUPABASE_AUTH_TIMEOUT_MS,
              ),
            );
            const { data } = await Promise.race([authPromise, timeoutPromise]);
            const ms = Date.now() - tUser;
            if (ms > 500) {
              console.warn(
                `[retailerPortal.listUsers] Supabase Auth slow for user ${u.id}: ${ms}ms`,
              );
            }
            return {
              ...u,
              lastSignInAt: data?.user?.last_sign_in_at ?? null,
              emailConfirmedAt: data?.user?.email_confirmed_at ?? null,
              authStatus: "ok" as const,
            };
          } catch (err) {
            const ms = Date.now() - tUser;
            console.warn(
              `[retailerPortal.listUsers] Supabase Auth unreachable for user ${u.id} after ${ms}ms: ${(err as Error).message}`,
            );
            return {
              ...u,
              lastSignInAt: null,
              emailConfirmedAt: null,
              authStatus: "unknown" as const,
            };
          }
        }),
      );

      const totalMs = Date.now() - tTotal;
      console.log(
        `[retailerPortal.listUsers] total=${totalMs}ms users=${portalUsers.length}`,
      );

      return enriched;
    }),

  /**
   * Invita un utente al portale retailer.
   * Crea l'utente in Supabase Auth + public.users con retailerId.
   */
  createInviteUser: adminProcedure
    .input(
      z.object({
        retailerId: uuid,
        email: z.string().email(),
        role: retailerRoleSchema.default("retailer_user"),
        name: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // 1. Verifica retailer esiste
      const retailer = await db.getRetailerById(input.retailerId);
      if (!retailer) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Rivenditore non trovato.",
        });
      }

      // 2. Check email non già usata
      const existingUsers = await db.getAllUsers();
      const emailTaken = existingUsers.find(
        (u) => u.email.toLowerCase() === input.email.toLowerCase(),
      );
      if (emailTaken) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `L'email ${input.email} è già associata a un utente.`,
        });
      }

      // 3. Crea utente in Supabase Auth con invito
      const { data: authData, error: authError } =
        await supabaseAdmin.auth.admin.inviteUserByEmail(input.email, {
          data: {
            retailer_id: input.retailerId,
            role: input.role,
            name: input.name || null,
          },
        });

      if (authError || !authData.user) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Errore creazione utente Supabase: ${authError?.message ?? "unknown"}`,
        });
      }

      // 4. Crea riga in public.users con retailerId
      // Il trigger handle_new_user potrebbe aver già creato la riga con role default.
      // Facciamo upsert: se esiste, aggiorniamo role e retailerId.
      try {
        await db.createRetailerUser({
          id: authData.user.id,
          email: input.email,
          name: input.name || null,
          role: input.role,
          retailerId: input.retailerId,
        });
      } catch (e: unknown) {
        // Se il trigger ha già creato la riga, aggiorniamo
        const err = e as { code?: string };
        if (err.code === "23505") {
          // unique violation — riga già esiste dal trigger
          const dbInstance = await db.getDb();
          if (dbInstance) {
            const { users: usersTable } = await import("../drizzle/schema");
            const { eq } = await import("drizzle-orm");
            await dbInstance
              .update(usersTable)
              .set({
                role: input.role,
                retailerId: input.retailerId,
                name: input.name || null,
                updatedAt: new Date(),
              })
              .where(eq(usersTable.id, authData.user.id));
          }
        } else {
          throw e;
        }
      }

      // 5. Genera magic link per l'email di invito
      const { data: linkData, error: linkError } =
        await supabaseAdmin.auth.admin.generateLink({
          type: "magiclink",
          email: input.email,
        });

      let magicLink = "";
      if (!linkError && linkData?.properties?.action_link) {
        magicLink = linkData.properties.action_link;
      }

      // 6. Invia email di invito
      if (magicLink) {
        await sendEmail({
          to: input.email,
          subject: `Invito al portale ${retailer.name} — SoKeto`,
          html: buildInviteEmailHtml({
            retailerName: retailer.name,
            magicLink,
            role: input.role,
          }),
        });
      }

      return {
        userId: authData.user.id,
        magicLinkSent: Boolean(magicLink),
      };
    }),

  /**
   * Rinvia invito (genera nuovo magic link e invia email).
   */
  resendInvite: adminProcedure
    .input(z.object({ userId: uuid }))
    .mutation(async ({ input }) => {
      const user = await db.getUserById(input.userId);
      if (!user || !user.retailerId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Utente portale non trovato.",
        });
      }

      const retailer = await db.getRetailerById(user.retailerId);
      if (!retailer) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Rivenditore non trovato.",
        });
      }

      const { data: linkData, error: linkError } =
        await supabaseAdmin.auth.admin.generateLink({
          type: "magiclink",
          email: user.email,
        });

      if (linkError || !linkData?.properties?.action_link) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Errore generazione link: ${linkError?.message ?? "unknown"}`,
        });
      }

      await sendEmail({
        to: user.email,
        subject: `Invito al portale ${retailer.name} — SoKeto`,
        html: buildInviteEmailHtml({
          retailerName: retailer.name,
          magicLink: linkData.properties.action_link,
          role: user.role,
        }),
      });

      return { success: true };
    }),

  /**
   * Revoca accesso utente portale.
   */
  revokeUser: adminProcedure
    .input(z.object({ userId: uuid }))
    .mutation(async ({ input }) => {
      const user = await db.getUserById(input.userId);
      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Utente non trovato.",
        });
      }
      if (user.role !== "retailer_admin" && user.role !== "retailer_user") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "L'utente non è un utente portale retailer.",
        });
      }

      // Rimuovi da Supabase Auth (CASCADE rimuove anche public.users)
      const { error } = await supabaseAdmin.auth.admin.deleteUser(input.userId);
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Errore revoca: ${error.message}`,
        });
      }

      return { success: true };
    }),

  // ============= RETAILER: Dashboard portale partner =============

  /**
   * Dashboard stats per il portale partner.
   */
  dashboardStats: retailerProcedure.query(async ({ ctx }) => {
    return await db.getRetailerDashboardStats(ctx.retailerId);
  }),
});
