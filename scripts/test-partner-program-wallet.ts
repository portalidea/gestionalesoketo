/**
 * Test locale end-to-end del Programma Partner (0053): sync convalide,
 * chiusura mese, borsellino su checkout/modifica/annullamento, rettifiche
 * tardive e scadenze. Esclusivamente su database locale effimero.
 */
import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;
process.env.RESEND_API_KEY = "";

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

const ids = {
  premiumPackage: "11111111-1111-1111-1111-111111111a53",
  portalUser: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa053",
} as const;
const STORE = 9001;
const OTHER_STORE = 9002;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function orderSnapshot(orderId: string) {
  const [order] = await sql<{ subtotal: string; vat: string; total: string; status: string }[]>`
    SELECT "subtotalNet"::text AS subtotal, "vatAmount"::text AS vat, "totalGross"::text AS total, status::text
    FROM orders WHERE id = ${orderId}`;
  const lines = await sql<{ code: string; net: string; gross: string; rate: string }[]>`
    SELECT service_code AS code, line_total_net::text AS net, line_total_gross::text AS gross, vat_rate::text AS rate
    FROM order_service_lines WHERE "orderId" = ${orderId} ORDER BY service_code`;
  const [items] = await sql<{ net: string; gross: string }[]>`
    SELECT COALESCE(SUM("lineTotalNet"),0)::text AS net, COALESCE(SUM("lineTotalGross"),0)::text AS gross
    FROM "orderItems" WHERE "orderId" = ${orderId}`;
  return { order, lines, items };
}

const cents = (v: string | number) => Math.round(Number(v) * 100);

function assertTotalsConsistent(s: Awaited<ReturnType<typeof orderSnapshot>>, label: string) {
  const net = cents(s.items.net) + s.lines.reduce((a, l) => a + cents(l.net), 0);
  const gross = cents(s.items.gross) + s.lines.reduce((a, l) => a + cents(l.gross), 0);
  assert(cents(s.order.subtotal) === net, `${label}: imponibile ordine ${s.order.subtotal} ≠ righe ${net / 100}`);
  assert(cents(s.order.total) === gross, `${label}: totale ordine ${s.order.total} ≠ righe ${gross / 100}`);
  assert(cents(s.order.subtotal) + cents(s.order.vat) === cents(s.order.total), `${label}: imponibile + IVA ≠ totale`);
}

async function main() {
  await sql`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS "paymentStatus" varchar(20) DEFAULT 'unpaid',
      ADD COLUMN IF NOT EXISTS "paymentMethod" varchar(50),
      ADD COLUMN IF NOT EXISTS "paidAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "approvedForShippingAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "transferringAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "shippedAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "deliveredAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "cancelledAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "cancelledReason" text
  `;
  // Pulizia idempotente
  await sql`DELETE FROM order_service_lines WHERE partner_program_statement_id IS NOT NULL`;
  await sql`DELETE FROM partner_program_applications`;
  await sql`UPDATE partner_program_events SET statement_id = NULL, adjusted_in_statement_id = NULL`;
  await sql`DELETE FROM partner_program_events`;
  await sql`DELETE FROM partner_program_statements`;
  await sql`DELETE FROM order_status_events WHERE "orderId" IN (SELECT id FROM orders WHERE "createdBy" = ${ids.portalUser})`;
  await sql`DELETE FROM "orderItems" WHERE "orderId" IN (SELECT id FROM orders WHERE "createdBy" = ${ids.portalUser})`;
  await sql`DELETE FROM orders WHERE "createdBy" = ${ids.portalUser}`;
  await sql`DELETE FROM users WHERE id = ${ids.portalUser}`;
  await sql`DELETE FROM auth.users WHERE id = ${ids.portalUser}`;
  await seedHotfixM13();

  await sql`
    INSERT INTO "pricingPackages" (id, name, "discountPercent", "sortOrder", "isAssignableToNewRetailers")
    VALUES (${ids.premiumPackage}, 'Premium Test Partner', 44.05, 3, true)
    ON CONFLICT (id) DO UPDATE SET "discountPercent" = EXCLUDED."discountPercent"`;
  await sql`
    UPDATE retailers SET "pricingPackageId" = ${ids.premiumPackage}, "pricingModel" = 'tier_discount', foodapps_store_id = ${STORE}
    WHERE id = ${TEST_IDS.normalRetailer}`;
  // Altri test locali possono troncare in cascata: la riga unica va garantita.
  await sql`INSERT INTO partner_program_settings (id, billing_company_id) VALUES (1, ${TEST_IDS.originCompany}) ON CONFLICT (id) DO NOTHING`;
  await sql`UPDATE partner_program_settings SET import_start_date = '2026-09-01', credit_vat_rate = 10, contribution_vat_rate = 10 WHERE id = 1`;
  await sql`INSERT INTO auth.users (id, email) VALUES (${ids.portalUser}, 'partner-wallet@local.invalid')`;
  await sql`UPDATE users SET name = 'Test Partner', role = 'retailer_admin', "retailerId" = ${TEST_IDS.normalRetailer} WHERE id = ${ids.portalUser}`;

  const svc = await import("../server/services/partnerProgramService");
  const { retailerSelfServiceRouter } = await import("../server/retailer-selfservice-router");
  const { partnerProgramRouter } = await import("../server/partner-program-router");
  const { getDb } = await import("../server/db");
  const db = (await getDb())!;

  const ctx = {
    user: { id: ids.portalUser, role: "retailer_admin", email: "partner-wallet@local.invalid", name: "Test Partner", retailerId: TEST_IDS.normalRetailer },
    activeCompanyId: TEST_IDS.originCompany,
    req: { headers: {} }, res: {},
  } as any;
  const partner = retailerSelfServiceRouter.createCaller(ctx);
  const partnerProgram = partnerProgramRouter.createCaller(ctx);

  // ── T1: sync idempotente ──
  const ev = (o: Record<string, unknown>): Record<string, unknown> => ({
    label: null, campaign_key: null, purchase_gross: "0", discount_gross: "0", credit_gross: "0", contribution_gross: "0", cancelled_at: null, ...o,
  });
  const octEvents = [
    ev({ source: "coupon", source_id: 1, store_id: STORE, occurred_at: "2026-10-10T10:00:00+02:00", label: "BF30", purchase_gross: "100", discount_gross: "30", credit_gross: "15" }),
    ev({ source: "card_purchase", source_id: 10, store_id: STORE, occurred_at: "2026-10-11T10:00:00+02:00", purchase_gross: "100", contribution_gross: "2.50" }),
    ev({ source: "card_voucher", source_id: 11, store_id: STORE, occurred_at: "2026-10-31T23:30:00+01:00", discount_gross: "5", credit_gross: "5" }),
    ev({ source: "coupon", source_id: 2, store_id: STORE, occurred_at: "2026-10-12T10:00:00+02:00", purchase_gross: "50", discount_gross: "10", credit_gross: "5", cancelled_at: "2026-10-12T11:00:00+02:00" }),
    ev({ source: "coupon", source_id: 3, store_id: OTHER_STORE, occurred_at: "2026-10-13T10:00:00+02:00", purchase_gross: "40", discount_gross: "8", credit_gross: "4" }),
    ev({ source: "coupon", source_id: 4, store_id: STORE, occurred_at: "2026-11-01T00:30:00+01:00", purchase_gross: "20", discount_gross: "6", credit_gross: "3" }),
    ev({ source: "coupon", source_id: 5, store_id: STORE, occurred_at: "2026-09-15T10:00:00+02:00", purchase_gross: "60", discount_gross: "12", credit_gross: "6" }),
  ];
  const payload = { ok: true, stores: [{ store_id: STORE, name: "Point Test" }, { store_id: OTHER_STORE, name: "Altro negozio" }], events: octEvents };
  const fetcher = async () => payload;
  const s1 = await svc.syncPartnerProgramEvents({ fetcher });
  const s2 = await svc.syncPartnerProgramEvents({ fetcher });
  assert(s1.ok && s2.ok, "La sync deve riuscire");
  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM partner_program_events`;
  assert(n === octEvents.length, `Sync non idempotente: ${n} eventi`);

  // ── T2: chiusura ottobre (il 31/10 23:30 a Roma è ottobre) ──
  // Settembre viene chiuso dopo, per esercitare la rettifica tardiva.
  const closeOct = await svc.closePartnerProgramMonth({ periodMonth: "2026-10-01" });
  assert(closeOct.created.length === 1, "Un solo estratto atteso (negozio abbinato)");
  const [oct] = await sql<any[]>`SELECT * FROM partner_program_statements WHERE period_month = '2026-10-01'`;
  // Ottobre include anche l'evento di settembre (non ancora assegnato) e il buono del 31/10.
  assert(oct.credit_gross === "26.00", `Credito lordo atteso 26,00 (15+5+6), trovato ${oct.credit_gross}`);
  assert(oct.contribution_gross === "2.50" && oct.contribution_net === "2.27", "Contributo 2,50 → 2,27 imponibile");
  assert(oct.credit_net === "23.64", `Credito netto atteso 23,64, trovato ${oct.credit_net}`);
  assert(oct.valid_until.toISOString?.().slice(0, 10) === "2026-11-30" || String(oct.valid_until).startsWith("2026-11-30") || oct.valid_until === "2026-11-30", "Scadenza 30/11");
  const reclose = await svc.closePartnerProgramMonth({ periodMonth: "2026-10-01" });
  assert(reclose.created.length === 0, "La chiusura deve essere idempotente");
  const [{ nov }] = await sql<{ nov: number }[]>`SELECT COUNT(*)::int AS nov FROM partner_program_events WHERE source_id = 4 AND statement_id IS NULL`;
  assert(nov === 1, "L'evento del 1/11 resta in maturazione");

  // ── T3: checkout scala credito fino all'imponibile + contributo ──
  const created = await partner.cartCheckout({ items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }], notes: "TEST partner wallet" });
  let snap = await orderSnapshot(created.orderId);
  const credit1 = snap.lines.find((l) => l.code === "PARTNER_PROMO_CREDIT");
  const contrib1 = snap.lines.find((l) => l.code === "PARTNER_PROGRAM_CONTRIBUTION");
  assert(credit1 && cents(credit1.net) === -cents(snap.items.net), `Abbuono pari all'imponibile merce (${snap.items.net}), trovato ${credit1?.net}`);
  assert(contrib1 && contrib1.net === "2.27" && contrib1.rate === "10.00", "Contributo 2,27 al 10%");
  assertTotalsConsistent(snap, "checkout");

  let overview = await partnerProgram.myOverview();
  assert(cents(overview.wallet.creditNet) === 2364 - cents(snap.items.net), "Residuo borsellino errato dopo il checkout");
  assert(overview.wallet.contributionNet === "0.00", "Contributo già addebitato");

  // ── T4: modifica → storno e riapplicazione senza doppioni ──
  await partner.ordersModifyItems({ orderId: created.orderId, items: [{ productId: TEST_IDS.productBoxes, quantity: 3 }] });
  snap = await orderSnapshot(created.orderId);
  assert(snap.lines.filter((l) => l.code === "PARTNER_PROMO_CREDIT").length === 1, "Una sola riga abbuono dopo la modifica");
  assert(snap.lines.filter((l) => l.code === "PARTNER_PROGRAM_CONTRIBUTION").length === 1, "Una sola riga contributo dopo la modifica");
  assertTotalsConsistent(snap, "modifica");
  const [{ applied }] = await sql<{ applied: string }[]>`SELECT COALESCE(SUM(credit_net_applied),0)::text AS applied FROM partner_program_applications WHERE statement_id = ${oct.id}`;
  assert(cents(applied) === Math.min(2364, cents(snap.items.net)), `Credito applicato netto errato: ${applied}`);

  // ── T5: annullamento → credito restituito ──
  await partner.ordersCancel({ orderId: created.orderId, reason: "TEST storno wallet" });
  overview = await partnerProgram.myOverview();
  assert(overview.wallet.creditNet === "23.64" && overview.wallet.contributionNet === "2.27", "Dopo l'annullamento il borsellino torna pieno");
  const [st1] = await sql<{ status: string }[]>`SELECT status FROM partner_program_statements WHERE id = ${oct.id}`;
  assert(st1.status === "open", "Estratto riaperto");

  // ── T6: ordine grande → estratto esaurito (settled) ──
  const big = await partner.cartCheckout({ items: [{ productId: TEST_IDS.productBoxes, quantity: 10 }] });
  snap = await orderSnapshot(big.orderId);
  assertTotalsConsistent(snap, "ordine grande");
  const bigCredit = snap.lines.find((l) => l.code === "PARTNER_PROMO_CREDIT");
  assert(bigCredit?.net === "-23.64" && bigCredit.gross === "-26.00", `Abbuono pieno -23,64 / -26,00 IVA incl., trovato ${bigCredit?.net}/${bigCredit?.gross}`);
  const [st2] = await sql<{ status: string }[]>`SELECT status FROM partner_program_statements WHERE id = ${oct.id}`;
  assert(st2.status === "settled", "Estratto esaurito");
  const again = await partner.cartCheckout({ items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }] });
  snap = await orderSnapshot(again.orderId);
  assert(snap.lines.length === 0, "Nessuna riga borsellino su un ordine successivo");

  // ── T7: annullamento tardivo → rettifica nel prossimo estratto ──
  octEvents[0].cancelled_at = "2026-11-20T10:00:00+01:00";
  await svc.syncPartnerProgramEvents({ fetcher });
  const [late] = await sql<{ cancelled: boolean; kept: boolean }[]>`
    SELECT cancelled_at IS NOT NULL AS cancelled, statement_id IS NOT NULL AS kept FROM partner_program_events WHERE source = 'coupon' AND source_id = 1`;
  assert(late.cancelled && late.kept, "L'annullamento tardivo resta legato all'estratto chiuso");
  const closeSep = await svc.closePartnerProgramMonth({ periodMonth: "2026-09-01" });
  assert(closeSep.created.length === 1, "Estratto di rettifica creato");
  const [sep] = await sql<any[]>`SELECT * FROM partner_program_statements WHERE period_month = '2026-09-01'`;
  assert(sep.adjustment_gross === "-15.00" && sep.credit_net === "0.00" && sep.status === "settled", `Rettifica -15 senza credito, trovato ${sep.adjustment_gross}/${sep.credit_net}/${sep.status}`);

  // ── T8: mese corrente non chiudibile, scadenze ──
  let currentRejected = false;
  try { await svc.closePartnerProgramMonth({ periodMonth: svc.romeMonthStart(new Date()) }); } catch { currentRejected = true; }
  assert(currentRejected, "Il mese in corso non si può chiudere");
  await sql`UPDATE partner_program_statements SET status = 'open' WHERE id = ${oct.id}`;
  const exp = await svc.expirePartnerProgramStatements(new Date("2026-12-01T08:00:00Z"));
  assert(exp.expired >= 1, "Estratto scaduto dopo il 30/11");

  // ── T9: riepilogo admin e negozio non abbinato ──
  const admin = await svc.getPartnerProgramAdminOverview(db);
  assert(admin.unmappedStores.some((s) => s.storeId === OTHER_STORE), "Negozio non abbinato segnalato");
  assert(admin.rows.some((r) => r.retailerId === TEST_IDS.normalRetailer), "Rivenditore abbinato in elenco");
  const events = await partnerProgram.myEvents({ statementId: oct.id });
  assert(events.length === 4, `Dettaglio ottobre: 4 convalide attese (incluso settembre non assegnato), trovate ${events.length}`);

  // ── T10: percorsi admin (create, updateItems, modifyOrderItems) ──
  await sql`UPDATE partner_program_statements SET status = 'open', valid_until = '2099-12-31', expired_at = NULL WHERE id = ${oct.id}`;
  await sql`DELETE FROM order_service_lines WHERE "orderId" = ${big.orderId}`;
  await sql`INSERT INTO partner_program_applications (statement_id, order_id, entry_type, reverses_application_id, credit_net_applied, contribution_net_charged, reversal_reason)
    SELECT statement_id, order_id, 'reversal', id, -credit_net_applied, -contribution_net_charged, 'TEST reset'
    FROM partner_program_applications a WHERE a.order_id = ${big.orderId} AND a.entry_type = 'apply'
      AND NOT EXISTS (SELECT 1 FROM partner_program_applications r WHERE r.reverses_application_id = a.id)`;
  await sql`
    INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
    VALUES (${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, true)
    ON CONFLICT ("userId", "companyId") DO UPDATE SET "isDefault" = true`;
  const { ordersRouter } = await import("../server/orders-router");
  const adminCaller = ordersRouter.createCaller({
    user: { id: TEST_IDS.adminUser, role: "admin", email: "test-admin@local.invalid", name: "Test Admin" },
    activeCompanyId: TEST_IDS.originCompany,
    req: { headers: {} }, res: {},
  } as any);
  const adminOrder = await adminCaller.create({ retailerId: TEST_IDS.normalRetailer, items: [{ productId: TEST_IDS.productBoxes, quantity: 2 }] });
  await sql`UPDATE orders SET "createdBy" = ${ids.portalUser} WHERE id = ${adminOrder.id}`;
  snap = await orderSnapshot(adminOrder.id);
  assert(snap.lines.length === 2, "Admin create: abbuono + contributo");
  assertTotalsConsistent(snap, "admin create");
  await adminCaller.updateItems({ orderId: adminOrder.id, items: [{ productId: TEST_IDS.productBoxes, quantity: 4 }] });
  snap = await orderSnapshot(adminOrder.id);
  assert(snap.lines.length === 2, "Admin updateItems: righe borsellino ricreate una volta");
  assertTotalsConsistent(snap, "admin updateItems");
  await adminCaller.modifyOrderItems({ orderId: adminOrder.id, items: [{ productId: TEST_IDS.productBoxes, quantity: 1 }] });
  snap = await orderSnapshot(adminOrder.id);
  assert(snap.lines.length === 2, "Admin modifyOrderItems: righe borsellino ricreate una volta");
  assertTotalsConsistent(snap, "admin modifyOrderItems");
  const [{ netApplied }] = await sql<{ netApplied: string }[]>`
    SELECT COALESCE(SUM(credit_net_applied),0)::text AS "netApplied" FROM partner_program_applications WHERE order_id = ${adminOrder.id}`;
  assert(cents(netApplied) === cents(snap.items.net), `Ledger netto dopo tre modifiche = imponibile merce (${netApplied} vs ${snap.items.net})`);

  // Teardown: gli script successivi ricreano gli stessi ordini di test.
  await sql`DELETE FROM order_service_lines WHERE partner_program_statement_id IS NOT NULL`;
  await sql`DELETE FROM partner_program_applications`;
  await sql`UPDATE partner_program_events SET statement_id = NULL, adjusted_in_statement_id = NULL`;
  await sql`DELETE FROM partner_program_events`;
  await sql`DELETE FROM partner_program_statements`;
  await sql`DELETE FROM order_status_events WHERE "orderId" IN (SELECT id FROM orders WHERE "createdBy" = ${ids.portalUser})`;
  await sql`DELETE FROM "orderItems" WHERE "orderId" IN (SELECT id FROM orders WHERE "createdBy" = ${ids.portalUser})`;
  await sql`DELETE FROM orders WHERE "createdBy" = ${ids.portalUser}`;
  await sql`UPDATE retailers SET foodapps_store_id = NULL WHERE id = ${TEST_IDS.normalRetailer}`;

  await sql.end();
  console.log("TESTDB_PARTNER_PROGRAM=PASS");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
