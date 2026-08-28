import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { affiliateCommissions, affiliates, orders, retailers, userCompanyAccess } from "../../drizzle/schema";
import { createManualAffiliateCommission } from "./manualAffiliateCommissionService";
import { calculateCommissionForOrder, recalculateCommissionForOrder, voidCommissionForOrder } from "./commissionService";
import { affiliatePortalRouter } from "../affiliate-portal-router";
import { affiliatesRouter } from "../affiliates-router";
import type { TrpcContext } from "../_core/context";

const EKETO_COMPANY_ID = "90000000-0000-0000-0000-000000000001";
const SOKETO_COMPANY_ID = "90000000-0000-0000-0000-000000000002";
const AFFILIATE_ID = "90000000-0000-0000-0000-000000000003";
const ACTOR_ID = "90000000-0000-0000-0000-000000000004";
const AFFILIATE_USER_ID = "90000000-0000-0000-0000-000000000005";
const RETAILER_ID = "90000000-0000-0000-0000-000000000006";
const ORDER_ID = "90000000-0000-0000-0000-000000000007";

function context(user: unknown, activeCompanyId?: string): TrpcContext {
  return {
    req: { headers: activeCompanyId ? { "x-active-company-id": activeCompanyId } : {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: user as TrpcContext["user"],
  };
}

beforeAll(async () => {
  const database = await getDb();
  if (!database) throw new Error("DATABASE_URL isolato obbligatorio per questa suite");
  await database.execute(sql`TRUNCATE TABLE prospect_simulation_items, prospect_simulations, prospect_invitations, affiliate_commissions, orders, retailers, affiliates, "userCompanyAccess", users, companies CASCADE`);
  await database.execute(sql`DO $$ BEGIN CREATE TYPE payment_status_enum AS ENUM ('unpaid', 'paid', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await database.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "paymentStatus" payment_status_enum NOT NULL DEFAULT 'unpaid'::payment_status_enum`);
  await database.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "paymentMethod" varchar(50)`);
  await database.execute(sql`INSERT INTO companies (id, name) VALUES (${EKETO_COMPANY_ID}::uuid, 'E-Keto Food Srls'), (${SOKETO_COMPANY_ID}::uuid, 'SoKeto Srl')`);
  await database.insert(affiliates).values({ id: AFFILIATE_ID, name: "Affiliato test", email: "affiliate@example.test", referralCode: "AFF-TEST", firstOrderRate: "10.00", recurringRate: "5.00" });
  await database.execute(sql`DELETE FROM auth.users WHERE id IN (${ACTOR_ID}::uuid, ${AFFILIATE_USER_ID}::uuid)`);
  await database.execute(sql`INSERT INTO auth.users (id, email) VALUES (${ACTOR_ID}::uuid, 'manual-commission-admin@example.test'), (${AFFILIATE_USER_ID}::uuid, 'manual-commission-affiliate@example.test')`);
  await database.execute(sql`UPDATE users SET role = 'admin' WHERE id = ${ACTOR_ID}::uuid`);
  await database.execute(sql`UPDATE users SET role = 'affiliate_user', "affiliateId" = ${AFFILIATE_ID}::uuid WHERE id = ${AFFILIATE_USER_ID}::uuid`);
  await database.insert(userCompanyAccess).values([
    { userId: ACTOR_ID, companyId: EKETO_COMPANY_ID, isDefault: true },
    { userId: ACTOR_ID, companyId: SOKETO_COMPANY_ID, isDefault: false },
  ]);
  await database.insert(retailers).values({ id: RETAILER_ID, name: "Retailer test", companyId: EKETO_COMPANY_ID, affiliateId: AFFILIATE_ID });
  await database.insert(orders).values({ id: ORDER_ID, retailerId: RETAILER_ID, companyId: EKETO_COMPANY_ID, createdBy: ACTOR_ID, subtotalNet: "100.00", vatAmount: "0", totalGross: "100.00", discountPercent: "0", paymentTerms: "advance_transfer" });
});

describe("provvigioni manuali — PostgreSQL isolato", () => {
  it("T1: l’admin crea una riga manuale nella company attiva e il server calcola l’importo", async () => {
    const adminCaller = affiliatesRouter.createCaller(context({ id: ACTOR_ID, email: "manual-commission-admin@example.test", role: "admin" }, SOKETO_COMPANY_ID));
    const created = await adminCaller.createManualCommission({
      affiliateId: AFFILIATE_ID,
      activityName: "Presentazione negozio",
      commissionDate: "2026-08-15",
      baseAmount: 240,
      commissionRate: 12.5,
      commissionType: "Segnalazione commerciale",
      notes: "Accordo documentato",
    });
    expect(created.origin).toBe("manual");
    expect(created.orderId).toBeNull();
    expect(created.retailerId).toBeNull();
    expect(created.companyId).toBe(SOKETO_COMPANY_ID);
    expect(created.createdBy).toBe(ACTOR_ID);
    expect(created.commissionAmount).toBe("30.00");
  });

  it("T2: la riga manuale è visibile nel portale, nel CSV e nei totali dell’affiliato", async () => {
    const portalCaller = affiliatePortalRouter.createCaller(context({ id: AFFILIATE_USER_ID, email: "manual-commission-affiliate@example.test", role: "affiliate_user", affiliateId: AFFILIATE_ID }));
    const list = await portalCaller.commissionsList({});
    const manual = list.items.find((item) => item.origin === "manual");
    expect(manual).toMatchObject({ activityName: "Presentazione negozio", commissionType: "Segnalazione commerciale", commissionAmount: "30.00", retailerName: null, orderNumber: null });
    expect(list.totalAmount).toBe(30);
    const stats = await portalCaller.dashboardStats();
    expect(stats.totalPending).toBe(30);
    const detail = await portalCaller.commissionsGetById({ commissionId: manual!.id });
    expect(detail).toMatchObject({ origin: "manual", order: null, retailer: null, activityName: "Presentazione negozio" });
    const exported = await portalCaller.commissionsExportCSV();
    expect(exported.csvContent).toContain("Manuale");
    expect(exported.csvContent).toContain("Presentazione negozio");
  });

  it("T3: calcolo, ricalcolo e annullamento automatici non toccano la riga manuale", async () => {
    const database = await getDb();
    const [manual] = await database.select().from(affiliateCommissions).where(eq(affiliateCommissions.origin, "manual"));
    await calculateCommissionForOrder(ORDER_ID);
    await recalculateCommissionForOrder(ORDER_ID);
    await voidCommissionForOrder(ORDER_ID, "Ordine annullato");
    const [unchangedManual] = await database.select().from(affiliateCommissions).where(eq(affiliateCommissions.id, manual.id));
    expect(unchangedManual).toMatchObject({ origin: "manual", status: "pending", commissionAmount: "30.00" });
    const automaticRows = await database.select().from(affiliateCommissions).where(eq(affiliateCommissions.origin, "automatic_order"));
    expect(automaticRows).toHaveLength(2);
    expect(automaticRows.every((row) => row.status === "voided")).toBe(true);
  });

  it("T4: il CHECK blocca una manuale senza dati obbligatori e una automatica senza ordine/retailer", async () => {
    const database = await getDb();
    const expectOriginContract = async (operation: Promise<unknown>) => {
      try {
        await operation;
        throw new Error("Il CHECK reciproco avrebbe dovuto rifiutare la riga");
      } catch (error) {
        expect((error as { cause?: { constraint_name?: string } }).cause?.constraint_name)
          .toBe("affiliate_commissions_origin_contract_check");
      }
    };
    await expectOriginContract(database.execute(sql`
      INSERT INTO affiliate_commissions (origin, "affiliateId", "orderTotal", "commissionRate", "commissionAmount", "companyId")
      VALUES ('manual', ${AFFILIATE_ID}::uuid, 100, 10, 10, ${SOKETO_COMPANY_ID}::uuid)
    `));
    await expectOriginContract(database.execute(sql`
      INSERT INTO affiliate_commissions (origin, "affiliateId", "orderTotal", "commissionRate", "commissionAmount")
      VALUES ('automatic_order', ${AFFILIATE_ID}::uuid, 100, 10, 10)
    `));
  });

  it("T5: il servizio diretto mantiene il contratto manuale e calcola un importo con precisione a due decimali", async () => {
    const database = await getDb();
    const created = await createManualAffiliateCommission(database, {
      affiliateId: AFFILIATE_ID,
      activityName: "Attività diretta",
      commissionDate: "2026-08-16",
      baseAmount: 99.99,
      commissionRate: 7,
      commissionType: "Altro",
      companyId: EKETO_COMPANY_ID,
      createdBy: ACTOR_ID,
    });
    expect(created.commissionAmount).toBe("7.00");
  });

  it("T6: report mensile e conteggio retailer includono la provvigione manuale senza trattarla come retailer", async () => {
    const adminCaller = affiliatesRouter.createCaller(context({ id: ACTOR_ID, email: "manual-commission-admin@example.test", role: "admin" }, SOKETO_COMPANY_ID));
    const report = await adminCaller.monthlyReport({ month: "2026-08" });
    const affiliateReport = report.affiliates.find((row) => row.affiliateId === AFFILIATE_ID);
    expect(affiliateReport?.totalPending).toBe(37);
    const database = await getDb();
    const [{ retailersCount }] = await database.execute(sql`
      SELECT COUNT(DISTINCT "retailerId") FILTER (WHERE "retailerId" IS NOT NULL)::int AS "retailersCount"
      FROM affiliate_commissions
      WHERE "affiliateId" = ${AFFILIATE_ID}::uuid
    `) as unknown as [{ retailersCount: number }];
    expect(retailersCount).toBe(1);
  });

  it("T7: la lista amministrativa espone per una manuale attività, causale e importo base", async () => {
    const adminCaller = affiliatesRouter.createCaller(context({ id: ACTOR_ID, email: "manual-commission-admin@example.test", role: "admin" }, SOKETO_COMPANY_ID));
    const result = await adminCaller.commissionsList({ affiliateId: AFFILIATE_ID });
    const manual = result.items.find((item) => item.origin === "manual" && item.activityName === "Presentazione negozio");
    expect(manual).toMatchObject({
      orderId: null,
      retailerId: null,
      activityName: "Presentazione negozio",
      commissionType: "Segnalazione commerciale",
      baseAmount: "240.00",
    });
  });
});
