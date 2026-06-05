/**
 * M11.A — Companies Router
 *
 * 2 procedure:
 * 1. companies.listMine — ritorna le company a cui l'utente corrente ha accesso
 * 2. companies.getActive — ritorna la company attiva (da ctx.activeCompanyId)
 */
import { eq } from "drizzle-orm";
import { staffProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { companies, userCompanyAccess } from "../drizzle/schema";

export const companiesRouter = router({
  /**
   * Ritorna le company a cui l'utente corrente ha accesso.
   * Output: [{ id, name, isDefault }]
   */
  listMine: staffProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({
        id: companies.id,
        name: companies.name,
        isDefault: userCompanyAccess.isDefault,
      })
      .from(userCompanyAccess)
      .innerJoin(companies, eq(companies.id, userCompanyAccess.companyId))
      .where(eq(userCompanyAccess.userId, ctx.user!.id));

    return rows;
  }),

  /**
   * Ritorna la company attiva (risolta dal middleware companyContext).
   * Output: { id, name }
   */
  getActive: staffProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB non disponibile");

    const [company] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, ctx.activeCompanyId))
      .limit(1);

    return company ?? null;
  }),
});
