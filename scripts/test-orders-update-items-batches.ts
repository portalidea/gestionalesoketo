import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  await seedHotfixM13();
  await sql`
    INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
    VALUES (${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, true)
    ON CONFLICT ("userId", "companyId")
    DO UPDATE SET "isDefault" = true
  `;

  const { ordersRouter } = await import("../server/orders-router");
  const caller = ordersRouter.createCaller({
    user: {
      id: TEST_IDS.adminUser,
      role: "admin",
      email: "test-admin@local.invalid",
      name: "Test Admin",
    },
    req: { headers: { "x-active-company-id": TEST_IDS.originCompany } },
    res: {},
  } as any);

  const before = await sql`
    SELECT id, "productId", "batchId", quantity, "lineTotalNet", "lineTotalGross"
    FROM "orderItems"
    WHERE "orderId" = ${TEST_IDS.orderIntact}
    ORDER BY id
  `;

  const result = await caller.updateItems({
    orderId: TEST_IDS.orderIntact,
    items: [{ productId: TEST_IDS.productBoxes, quantity: 15 }],
  });

  const after = await sql`
    SELECT id, "productId", "batchId", quantity, "lineTotalNet", "lineTotalGross"
    FROM "orderItems"
    WHERE "orderId" = ${TEST_IDS.orderIntact}
    ORDER BY "batchId" NULLS LAST
  `;

  const assigned = after.filter((row) => row.batchId !== null);
  const totalQuantity = after.reduce((sum, row) => sum + Number(row.quantity), 0);
  assert(after.length === 2, "15 confezioni devono essere suddivise su due lotti FEFO disponibili.");
  assert(assigned.length === 2, "Nessuna riga allocata deve perdere batchId durante updateItems.");
  assert(
    assigned.some((row) => row.batchId === TEST_IDS.batchSoon) &&
      assigned.some((row) => row.batchId === TEST_IDS.batchFourMonths),
    "Le righe devono usare entrambi i batch della company attiva in ordine FEFO.",
  );
  assert(totalQuantity === 15, "La quantità totale deve restare invariata dopo lo split FEFO.");
  assert(result.warnings.length === 0, "Lo stock fixture deve coprire la modifica senza righe non assegnate.");

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    test: "orders.updateItems preserves FEFO batch assignments",
    result,
    raw: { before, after },
  }, null, 2));
}

main().finally(() => sql.end({ timeout: 5 }));
