import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;
process.env.RESEND_API_KEY = "";

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

const ids = {
  portalUser: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaad",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(condition: () => Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function main() {
  await sql`DELETE FROM legacy_api_calls WHERE "userId" = ${ids.portalUser}`;
  await sql`DELETE FROM users WHERE id = ${ids.portalUser}`;
  await sql`DELETE FROM auth.users WHERE id = ${ids.portalUser}`;
  await seedHotfixM13();

  await sql`INSERT INTO auth.users (id, email) VALUES (${ids.portalUser}, 'legacy-audit@local.invalid')`;
  await sql`
    UPDATE users
    SET name = 'Test Legacy Audit',
        role = 'retailer_admin',
        "retailerId" = ${TEST_IDS.normalRetailer}
    WHERE id = ${ids.portalUser}
  `;

  const context = {
    user: {
      id: ids.portalUser,
      role: "retailer_admin",
      email: "legacy-audit@local.invalid",
      name: "Test Legacy Audit",
      retailerId: TEST_IDS.normalRetailer,
    },
    req: { headers: {} },
    res: {},
  } as any;

  const { catalogPortalRouter } = await import("../server/catalog-portal-router");
  const { retailerCheckoutRouter } = await import("../server/retailer-checkout-router");
  const { retailerOrdersRouter } = await import("../server/retailer-orders-router");

  const catalogCaller = catalogPortalRouter.createCaller(context);
  const checkoutCaller = retailerCheckoutRouter.createCaller(context);
  const ordersCaller = retailerOrdersRouter.createCaller(context);

  // T1: una chiamata in ciascuno dei tre namespace lascia una riga persistente.
  await catalogCaller.categories();
  await checkoutCaller.preview({ items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }] });
  await ordersCaller.list({});

  const expectedProcedures = [
    "catalogPortal.categories",
    "retailerCheckout.preview",
    "retailerOrders.list",
  ];
  await waitFor(async () => {
    const rows = await sql<{ procedure: string }[]>`
      SELECT procedure
      FROM legacy_api_calls
      WHERE "userId" = ${ids.portalUser}
        AND procedure IN (
          ${expectedProcedures[0]},
          ${expectedProcedures[1]},
          ${expectedProcedures[2]}
        )
    `;
    return new Set(rows.map((row) => row.procedure)).size === expectedProcedures.length;
  }, "Ogni namespace legacy deve produrre una riga di audit persistente.");

  const persistedRows = await sql<{ procedure: string; userId: string; retailerId: string }[]>`
    SELECT procedure, "userId" AS "userId", "retailerId" AS "retailerId"
    FROM legacy_api_calls
    WHERE "userId" = ${ids.portalUser}
    ORDER BY procedure
  `;
  assert(persistedRows.length === 3, "Il test deve registrare esattamente tre chiamate legacy iniziali.");
  assert(
    persistedRows.every((row) => row.userId === ids.portalUser && row.retailerId === TEST_IDS.normalRetailer),
    "Ogni audit deve associare correttamente utente e retailer.",
  );

  // T2: un errore nell'INSERT audit viene assorbito; la query retailer resta funzionante.
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION test_legacy_api_calls_fail_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'test legacy audit insert failure';
    END;
    $$;
  `);
  await sql.unsafe(`
    CREATE TRIGGER test_legacy_api_calls_fail_insert_trigger
    BEFORE INSERT ON legacy_api_calls
    FOR EACH ROW EXECUTE FUNCTION test_legacy_api_calls_fail_insert();
  `);

  const categoriesAfterAuditFailure = await catalogCaller.categories();
  assert(Array.isArray(categoriesAfterAuditFailure), "Un errore di audit non deve bloccare catalogPortal.categories.");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const rowsAfterFailure = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM legacy_api_calls
    WHERE "userId" = ${ids.portalUser}
  `;
  assert(rowsAfterFailure[0]?.count === 3, "L'errore best-effort non deve creare una riga parziale di audit.");

  await sql.unsafe("DROP TRIGGER test_legacy_api_calls_fail_insert_trigger ON legacy_api_calls");
  await sql.unsafe("DROP FUNCTION test_legacy_api_calls_fail_insert()");
  await sql`DELETE FROM legacy_api_calls WHERE "userId" = ${ids.portalUser}`;
  await sql`DELETE FROM users WHERE id = ${ids.portalUser}`;
  await sql`DELETE FROM auth.users WHERE id = ${ids.portalUser}`;

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    tests: {
      catalogPortalCallPersisted: "PASS",
      retailerCheckoutCallPersisted: "PASS",
      retailerOrdersCallPersisted: "PASS",
      auditInsertFailureDoesNotBlockProcedure: "PASS",
    },
    raw: {
      persistedRows,
      categoriesAfterAuditFailure,
    },
  }, null, 2));
}

main()
  .then(async () => {
    await sql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
