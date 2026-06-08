/**
 * M11.E — Multi-company access helper.
 *
 * Provides utilities to check which companies a user has access to.
 * Used by the aggregated warehouse view (cross-company stock).
 *
 * SECURITY NOTE: This is the ONLY approved way to get cross-company access
 * for a user. All aggregated views MUST use this helper to determine
 * authorized companies before querying cross-company data.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { userCompanyAccess, companies } from "../../drizzle/schema";

export interface UserCompanyInfo {
  companyId: string;
  companyName: string;
}

/**
 * Get all company IDs a user has access to.
 */
export async function getUserCompanyIds(userId: string): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ companyId: userCompanyAccess.companyId })
    .from(userCompanyAccess)
    .where(eq(userCompanyAccess.userId, userId));
  return rows.map((r) => r.companyId);
}

/**
 * Get all companies (id + name) a user has access to.
 */
export async function getUserCompanies(userId: string): Promise<UserCompanyInfo[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      companyId: userCompanyAccess.companyId,
      companyName: companies.name,
    })
    .from(userCompanyAccess)
    .innerJoin(companies, eq(companies.id, userCompanyAccess.companyId))
    .where(eq(userCompanyAccess.userId, userId));
  return rows.map((r) => ({ companyId: r.companyId, companyName: r.companyName }));
}

/**
 * Check if user has access to 2+ companies (required for aggregated view).
 */
export async function hasMultiCompanyAccess(userId: string): Promise<boolean> {
  const ids = await getUserCompanyIds(userId);
  return ids.length >= 2;
}
