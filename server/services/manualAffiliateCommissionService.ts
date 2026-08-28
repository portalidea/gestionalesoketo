import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { affiliateCommissions, affiliates } from "../../drizzle/schema";

type Database = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;

export type CreateManualAffiliateCommissionInput = {
  affiliateId: string;
  activityName: string;
  commissionDate: string;
  baseAmount: number;
  commissionRate: number;
  commissionType: string;
  notes?: string;
  companyId: string;
  createdBy: string;
};

/**
 * Crea una commissione indipendente da un ordine.
 * `orderTotal` conserva il valore imponibile anche per compatibilità con i
 * totali e le interfacce esistenti; per le righe manuali coincide con baseAmount.
 */
export async function createManualAffiliateCommission(
  database: Database,
  input: CreateManualAffiliateCommissionInput,
) {
  const [affiliate] = await database
    .select({ id: affiliates.id })
    .from(affiliates)
    .where(eq(affiliates.id, input.affiliateId))
    .limit(1);

  if (!affiliate) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Affiliato non trovato" });
  }

  const commissionAmount = Number((input.baseAmount * input.commissionRate / 100).toFixed(2));
  const [created] = await database
    .insert(affiliateCommissions)
    .values({
      origin: "manual",
      affiliateId: input.affiliateId,
      orderId: null,
      retailerId: null,
      orderTotal: input.baseAmount.toFixed(2),
      activityName: input.activityName.trim(),
      commissionDate: input.commissionDate,
      baseAmount: input.baseAmount.toFixed(2),
      commissionRate: input.commissionRate.toFixed(2),
      commissionAmount: commissionAmount.toFixed(2),
      commissionType: input.commissionType.trim(),
      notes: input.notes?.trim() || null,
      companyId: input.companyId,
      createdBy: input.createdBy,
      isFirstOrder: false,
      status: "pending",
      pendingAt: new Date(`${input.commissionDate}T12:00:00.000Z`),
    })
    .returning();

  return created;
}
