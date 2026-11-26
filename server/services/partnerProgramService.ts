/**
 * Programma Partner SoKeto — borsellino promo app (migration 0053).
 *
 * FoodApps4All registra le convalide in negozio (coupon dell'app, acquisti
 * SoKeto Card, buoni Card). Il gestionale:
 *  1. ogni notte ne copia gli eventi (sync idempotente, annullamenti inclusi);
 *  2. a mese chiuso crea un estratto per rivenditore abbinato:
 *       credito    = 50% sconti coupon + buoni Card usati   (IVA inclusa)
 *       contributo = 2,5% sugli acquisti Card registrati     (IVA inclusa)
 *     entrambi scorporati all'aliquota configurata (default 10%);
 *  3. applica l'estratto al primo ordine E-Keto del mese successivo come due
 *     righe di servizio: abbuono (negativo, fino all'imponibile merce) e
 *     contributo (positivo, addebitato una volta sola);
 *  4. a fine mese successivo l'estratto scade: il credito residuo si perde,
 *     il contributo non addebitato resta "da fatturare a parte".
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  orderItems,
  orderServiceLines,
  orders,
  partnerProgramApplications,
  partnerProgramEvents,
  partnerProgramSettings,
  partnerProgramStatements,
  retailers,
} from "../../drizzle/schema";
import { getDb } from "../db";

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

export const PARTNER_PROMO_CREDIT_CODE = "PARTNER_PROMO_CREDIT";
export const PARTNER_CONTRIBUTION_CODE = "PARTNER_PROGRAM_CONTRIBUTION";
const WALLET_SERVICE_CODES = [PARTNER_PROMO_CREDIT_CODE, PARTNER_CONTRIBUTION_CODE];
const ROME = "Europe/Rome";

// ─────────────────────────── Helpers puri ───────────────────────────

const toCents = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 100);
const fromCents = (cents: number) => (cents / 100).toFixed(2);

/** Imponibile da un importo IVA inclusa, arrotondato al centesimo. */
export function grossToNet(gross: string | number, vatRate: string | number): string {
  const g = toCents(gross);
  const rate = Number(vatRate);
  return fromCents(Math.round(g / (1 + rate / 100)));
}

/** Lordo da imponibile (anche negativo), arrotondato al centesimo. */
export function netToGross(net: string | number, vatRate: string | number): string {
  const n = toCents(net);
  const rate = Number(vatRate);
  const gross = Math.sign(n) * Math.round(Math.abs(n) * (1 + rate / 100));
  return fromCents(gross);
}

function romeParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Data odierna a Roma, formato YYYY-MM-DD. */
export function romeToday(now: Date): string {
  const p = romeParts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Primo giorno del mese (Roma) che contiene `now`. */
export function romeMonthStart(now: Date): string {
  const p = romeParts(now);
  return `${p.year}-${pad(p.month)}-01`;
}

/** Aggiunge mesi a una data YYYY-MM-01. */
export function addMonths(monthStart: string, months: number): string {
  const [y, m] = monthStart.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

/** Ultimo giorno del mese successivo al periodo: scadenza del credito. */
export function creditValidUntil(periodMonth: string): string {
  const twoAhead = addMonths(periodMonth, 2);
  const [y, m] = twoAhead.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1, 1) - 86_400_000);
  return `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
}

/** Istante UTC della mezzanotte di Roma per una data YYYY-MM-DD. */
export function romeMidnightUtc(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  for (const offset of [1, 2]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, -offset, 0, 0));
    const hour = new Intl.DateTimeFormat("en-GB", { timeZone: ROME, hour: "2-digit", hourCycle: "h23" }).format(candidate);
    if (romeToday(candidate) === day && Number(hour) === 0) return candidate;
  }
  throw new Error(`Data non valida: ${day}`);
}

export type StatementAmounts = {
  creditGross: string;
  contributionGross: string;
  adjustmentGross: string;
  creditNet: string;
  contributionNet: string;
};

/**
 * Importi di un estratto. Gli annullamenti arrivati dopo una chiusura
 * precedente riducono credito (rettifica esplicita) e contributo.
 */
export function computeStatementAmounts(input: {
  creditGross: string | number;
  contributionGross: string | number;
  lateCancelledCreditGross: string | number;
  lateCancelledContributionGross: string | number;
  creditVatRate: string | number;
  contributionVatRate: string | number;
}): StatementAmounts {
  const credit = toCents(input.creditGross);
  const adjustment = -toCents(input.lateCancelledCreditGross);
  const contribution = Math.max(0, toCents(input.contributionGross) - toCents(input.lateCancelledContributionGross));
  const effectiveCredit = Math.max(0, credit + adjustment);
  return {
    creditGross: fromCents(credit),
    contributionGross: fromCents(contribution),
    adjustmentGross: fromCents(adjustment === 0 ? 0 : adjustment),
    creditNet: grossToNet(fromCents(effectiveCredit), input.creditVatRate),
    contributionNet: grossToNet(fromCents(contribution), input.contributionVatRate),
  };
}

export type WalletStatementState = {
  id: string;
  periodMonth: string;
  creditNet: string;
  creditApplied: string;
  contributionNet: string;
  contributionCharged: string;
  creditVatRate: string;
  contributionVatRate: string;
};

export type WalletPlanLine = {
  statementId: string;
  periodMonth: string;
  creditNet: string;
  contributionNet: string;
  creditVatRate: string;
  contributionVatRate: string;
};

/**
 * Piano di utilizzo: estratti dal più vecchio, credito fino a esaurire
 * l'imponibile merce dell'ordine, contributo residuo sempre addebitato.
 */
export function planWalletApplication(statements: WalletStatementState[], merchandiseNet: string | number): WalletPlanLine[] {
  let capacity = Math.max(0, toCents(merchandiseNet));
  const plan: WalletPlanLine[] = [];
  const sorted = [...statements].sort((a, b) => a.periodMonth.localeCompare(b.periodMonth));
  for (const st of sorted) {
    const creditRemaining = Math.max(0, toCents(st.creditNet) - toCents(st.creditApplied));
    const contributionRemaining = Math.max(0, toCents(st.contributionNet) - toCents(st.contributionCharged));
    const credit = Math.min(creditRemaining, capacity);
    capacity -= credit;
    if (credit === 0 && contributionRemaining === 0) continue;
    plan.push({
      statementId: st.id,
      periodMonth: st.periodMonth,
      creditNet: fromCents(credit),
      contributionNet: fromCents(contributionRemaining),
      creditVatRate: st.creditVatRate,
      contributionVatRate: st.contributionVatRate,
    });
  }
  return plan;
}

const MONTHS_IT = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];
export function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return `${MONTHS_IT[m - 1]} ${y}`;
}

// ─────────────────────────── Export FoodApps4All ───────────────────────────

const moneyString = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "importo non valido" });
    return z.NEVER;
  }
  return n.toFixed(2);
});

const exportEventSchema = z.object({
  source: z.enum(["coupon", "card_purchase", "card_voucher"]),
  source_id: z.coerce.number().int().positive(),
  store_id: z.coerce.number().int().positive(),
  occurred_at: z.string().min(10),
  label: z.string().nullable().optional(),
  campaign_key: z.string().nullable().optional(),
  purchase_gross: moneyString,
  discount_gross: moneyString,
  credit_gross: moneyString,
  contribution_gross: moneyString,
  cancelled_at: z.string().nullable().optional(),
});

export const partnerExportSchema = z.object({
  ok: z.literal(true),
  stores: z.array(z.object({
    store_id: z.coerce.number().int().positive(),
    name: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
  })),
  events: z.array(exportEventSchema),
});
export type PartnerExport = z.infer<typeof partnerExportSchema>;
export type PartnerExportFetcher = (range: { from: string; to: string }) => Promise<unknown>;

function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`EXPORT_INVALID_DATE:${field}`);
  return d;
}

export function exportConfig() {
  const url = process.env.FOODAPPS_PARTNER_EXPORT_URL?.trim();
  const secret = process.env.PARTNER_EXPORT_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

export const defaultExportFetcher: PartnerExportFetcher = async ({ from, to }) => {
  const config = exportConfig();
  if (!config) throw new Error("NOT_CONFIGURED");
  const url = new URL(config.url);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-SoKeto-Partner-Key": config.secret, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
};

/** Elenco punti vendita FoodApps4All (per l'abbinamento nella scheda rivenditore). */
export async function fetchFoodappsStores(fetcher: PartnerExportFetcher = defaultExportFetcher, now = new Date()) {
  const today = romeToday(now);
  const tomorrow = romeToday(new Date(romeMidnightUtc(today).getTime() + 36 * 3_600_000));
  const parsed = partnerExportSchema.parse(await fetcher({ from: today, to: tomorrow }));
  return parsed.stores
    .map((s) => ({ storeId: s.store_id, name: s.name ?? `Negozio ${s.store_id}`, city: s.city ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, "it"));
}

// ─────────────────────────── Settings ───────────────────────────

export async function getPartnerProgramSettings(db: Executor) {
  const [settings] = await db.select().from(partnerProgramSettings).where(eq(partnerProgramSettings.id, 1)).limit(1);
  if (!settings) throw new Error("Impostazioni Programma Partner mancanti (migration 0053)");
  return settings;
}

// ─────────────────────────── Sync ───────────────────────────

export async function syncPartnerProgramEvents(input: {
  now?: Date;
  fetcher?: PartnerExportFetcher;
} = {}) {
  const now = input.now ?? new Date();
  const db = await getDb();
  if (!db) throw new Error("DB non disponibile");
  const settings = await getPartnerProgramSettings(db);
  const fetcher = input.fetcher ?? defaultExportFetcher;

  const previousMonth = addMonths(romeMonthStart(now), -1);
  const from = settings.importStartDate > previousMonth ? settings.importStartDate : previousMonth;
  const to = romeToday(new Date(romeMidnightUtc(romeToday(now)).getTime() + 36 * 3_600_000));

  try {
    const payload = partnerExportSchema.parse(await fetcher({ from, to }));
    const storeNames = new Map(payload.stores.map((s) => [s.store_id, s.name ?? null]));
    const syncedAt = new Date();
    const rows = payload.events.map((e) => ({
      source: e.source,
      sourceId: e.source_id,
      foodappsStoreId: e.store_id,
      storeName: storeNames.get(e.store_id) ?? null,
      occurredAt: parseDate(e.occurred_at, "occurred_at"),
      label: e.label ?? null,
      campaignKey: e.campaign_key ?? null,
      purchaseGross: e.purchase_gross,
      discountGross: e.discount_gross,
      creditGross: e.credit_gross,
      contributionGross: e.contribution_gross,
      cancelledAt: e.cancelled_at ? parseDate(e.cancelled_at, "cancelled_at") : null,
      lastSyncedAt: syncedAt,
    }));

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await db
        .insert(partnerProgramEvents)
        .values(chunk)
        .onConflictDoUpdate({
          target: [partnerProgramEvents.source, partnerProgramEvents.sourceId],
          set: {
            foodappsStoreId: sql`excluded.foodapps_store_id`,
            storeName: sql`excluded.store_name`,
            occurredAt: sql`excluded.occurred_at`,
            label: sql`excluded.label`,
            campaignKey: sql`excluded.campaign_key`,
            purchaseGross: sql`excluded.purchase_gross`,
            discountGross: sql`excluded.discount_gross`,
            // Dopo la chiusura gli importi restano quelli dell'estratto.
            creditGross: sql`CASE WHEN ${partnerProgramEvents.statementId} IS NULL THEN excluded.credit_gross ELSE ${partnerProgramEvents.creditGross} END`,
            contributionGross: sql`CASE WHEN ${partnerProgramEvents.statementId} IS NULL THEN excluded.contribution_gross ELSE ${partnerProgramEvents.contributionGross} END`,
            // Un annullamento non si "disannulla" una volta registrato.
            cancelledAt: sql`COALESCE(${partnerProgramEvents.cancelledAt}, excluded.cancelled_at)`,
            lastSyncedAt: sql`excluded.last_synced_at`,
          },
        });
    }

    await db.update(partnerProgramSettings)
      .set({ lastSyncAt: syncedAt, lastSyncError: null, updatedAt: syncedAt })
      .where(eq(partnerProgramSettings.id, 1));
    return { ok: true as const, from, to, events: rows.length, stores: payload.stores.length };
  } catch (err: any) {
    const message = err instanceof z.ZodError ? "EXPORT_INVALID_PAYLOAD" : String(err?.message ?? err).slice(0, 200);
    await db.update(partnerProgramSettings)
      .set({ lastSyncError: message, updatedAt: new Date() })
      .where(eq(partnerProgramSettings.id, 1));
    return { ok: false as const, from, to, error: message };
  }
}

// ─────────────────────────── Chiusura mese ───────────────────────────

/**
 * Crea gli estratti del mese `periodMonth` (YYYY-MM-01) per i rivenditori
 * abbinati che non ne hanno ancora uno. Idempotente: si può rieseguire ogni
 * giorno, così un abbinamento fatto in ritardo genera l'estratto la notte dopo.
 */
export async function closePartnerProgramMonth(input: { periodMonth: string; now?: Date }) {
  const now = input.now ?? new Date();
  const db = await getDb();
  if (!db) throw new Error("DB non disponibile");
  const currentMonth = romeMonthStart(now);
  if (input.periodMonth >= currentMonth) {
    throw new Error("Si può chiudere solo un mese già concluso");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('partner_program_close'))`);
    const settings = await getPartnerProgramSettings(tx);
    const periodEnd = romeMidnightUtc(addMonths(input.periodMonth, 1));
    const importStart = romeMidnightUtc(settings.importStartDate);

    const mapped = await tx
      .select({ id: retailers.id, storeId: retailers.foodappsStoreId })
      .from(retailers)
      .where(and(isNotNull(retailers.foodappsStoreId), eq(retailers.companyId, settings.billingCompanyId)));

    const created: Array<{ retailerId: string; statementId: string; creditNet: string; contributionNet: string }> = [];
    for (const retailer of mapped) {
      const storeId = retailer.storeId!;
      const [existing] = await tx
        .select({ id: partnerProgramStatements.id })
        .from(partnerProgramStatements)
        .where(and(eq(partnerProgramStatements.retailerId, retailer.id), eq(partnerProgramStatements.periodMonth, input.periodMonth)))
        .limit(1);
      if (existing) continue;

      const monthEvents = await tx
        .select({ id: partnerProgramEvents.id, credit: partnerProgramEvents.creditGross, contribution: partnerProgramEvents.contributionGross })
        .from(partnerProgramEvents)
        .where(and(
          eq(partnerProgramEvents.foodappsStoreId, storeId),
          isNull(partnerProgramEvents.statementId),
          isNull(partnerProgramEvents.cancelledAt),
          gte(partnerProgramEvents.occurredAt, importStart),
          lt(partnerProgramEvents.occurredAt, periodEnd),
        ));
      const lateCancelled = await tx
        .select({ id: partnerProgramEvents.id, credit: partnerProgramEvents.creditGross, contribution: partnerProgramEvents.contributionGross })
        .from(partnerProgramEvents)
        .innerJoin(partnerProgramStatements, eq(partnerProgramStatements.id, partnerProgramEvents.statementId))
        .where(and(
          eq(partnerProgramStatements.retailerId, retailer.id),
          isNotNull(partnerProgramEvents.cancelledAt),
          isNull(partnerProgramEvents.adjustedInStatementId),
        ));
      if (monthEvents.length === 0 && lateCancelled.length === 0) continue;

      const sum = (rows: Array<{ credit: string; contribution: string }>, key: "credit" | "contribution") =>
        fromCents(rows.reduce((acc, r) => acc + toCents(r[key]), 0));
      const amounts = computeStatementAmounts({
        creditGross: sum(monthEvents, "credit"),
        contributionGross: sum(monthEvents, "contribution"),
        lateCancelledCreditGross: sum(lateCancelled, "credit"),
        lateCancelledContributionGross: sum(lateCancelled, "contribution"),
        creditVatRate: settings.creditVatRate,
        contributionVatRate: settings.contributionVatRate,
      });
      const nothingDue = toCents(amounts.creditNet) === 0 && toCents(amounts.contributionNet) === 0;

      const [statement] = await tx
        .insert(partnerProgramStatements)
        .values({
          retailerId: retailer.id,
          billingCompanyId: settings.billingCompanyId,
          periodMonth: input.periodMonth,
          eventCount: monthEvents.length,
          creditGross: amounts.creditGross,
          contributionGross: amounts.contributionGross,
          adjustmentGross: amounts.adjustmentGross,
          creditVatRate: settings.creditVatRate,
          contributionVatRate: settings.contributionVatRate,
          creditNet: amounts.creditNet,
          contributionNet: amounts.contributionNet,
          validUntil: creditValidUntil(input.periodMonth),
          status: nothingDue ? "settled" : "open",
          settledAt: nothingDue ? now : null,
        })
        .returning({ id: partnerProgramStatements.id });

      if (monthEvents.length > 0) {
        await tx.update(partnerProgramEvents)
          .set({ statementId: statement.id })
          .where(inArray(partnerProgramEvents.id, monthEvents.map((e) => e.id)));
      }
      if (lateCancelled.length > 0) {
        await tx.update(partnerProgramEvents)
          .set({ adjustedInStatementId: statement.id })
          .where(inArray(partnerProgramEvents.id, lateCancelled.map((e) => e.id)));
      }
      created.push({ retailerId: retailer.id, statementId: statement.id, creditNet: amounts.creditNet, contributionNet: amounts.contributionNet });
    }
    return { periodMonth: input.periodMonth, created };
  });
}

/** Estratti aperti oltre la scadenza → scaduti. */
export async function expirePartnerProgramStatements(now = new Date()) {
  const db = await getDb();
  if (!db) throw new Error("DB non disponibile");
  const today = romeToday(now);
  const expired = await db.update(partnerProgramStatements)
    .set({ status: "expired", expiredAt: now })
    .where(and(eq(partnerProgramStatements.status, "open"), lt(partnerProgramStatements.validUntil, today)))
    .returning({ id: partnerProgramStatements.id });
  return { expired: expired.length };
}

/** Passo giornaliero del cron: sync, chiusura mese precedente, scadenze. */
export async function runPartnerProgramDaily(input: { now?: Date; fetcher?: PartnerExportFetcher } = {}) {
  const now = input.now ?? new Date();
  const sync = exportConfig() || input.fetcher
    ? await syncPartnerProgramEvents({ now, fetcher: input.fetcher })
    : { ok: false as const, error: "NOT_CONFIGURED" };
  const close = await closePartnerProgramMonth({ periodMonth: addMonths(romeMonthStart(now), -1), now });
  const expire = await expirePartnerProgramStatements(now);
  return { sync, closed: close.created.length, expired: expire.expired };
}

// ─────────────────────────── Borsellino sugli ordini ───────────────────────────

async function loadStatementStates(db: Executor, retailerId: string, today: string, lock: boolean) {
  const base = db
    .select({
      id: partnerProgramStatements.id,
      periodMonth: partnerProgramStatements.periodMonth,
      creditNet: partnerProgramStatements.creditNet,
      contributionNet: partnerProgramStatements.contributionNet,
      creditVatRate: partnerProgramStatements.creditVatRate,
      contributionVatRate: partnerProgramStatements.contributionVatRate,
      validUntil: partnerProgramStatements.validUntil,
      billingCompanyId: partnerProgramStatements.billingCompanyId,
    })
    .from(partnerProgramStatements)
    .where(and(
      eq(partnerProgramStatements.retailerId, retailerId),
      eq(partnerProgramStatements.status, "open"),
      gte(partnerProgramStatements.validUntil, today),
    ))
    .orderBy(asc(partnerProgramStatements.periodMonth));
  const statements = lock ? await base.for("update") : await base;
  if (statements.length === 0) return [];

  const usage = await db
    .select({
      statementId: partnerProgramApplications.statementId,
      credit: sql<string>`COALESCE(SUM(${partnerProgramApplications.creditNetApplied}), 0)`,
      contribution: sql<string>`COALESCE(SUM(${partnerProgramApplications.contributionNetCharged}), 0)`,
    })
    .from(partnerProgramApplications)
    .where(inArray(partnerProgramApplications.statementId, statements.map((s) => s.id)))
    .groupBy(partnerProgramApplications.statementId);
  const usageById = new Map(usage.map((u) => [u.statementId, u]));

  return statements.map((s) => ({
    ...s,
    creditApplied: String(usageById.get(s.id)?.credit ?? "0"),
    contributionCharged: String(usageById.get(s.id)?.contribution ?? "0"),
  }));
}

async function adjustOrderTotals(tx: Executor, orderId: string, netCents: number, vatCents: number) {
  if (netCents === 0 && vatCents === 0) return;
  const net = fromCents(netCents);
  const vat = fromCents(vatCents);
  const gross = fromCents(netCents + vatCents);
  await tx.update(orders).set({
    subtotalNet: sql`${orders.subtotalNet} + ${net}::numeric`,
    vatAmount: sql`${orders.vatAmount} + ${vat}::numeric`,
    totalGross: sql`${orders.totalGross} + ${gross}::numeric`,
    updatedAt: new Date(),
  }).where(eq(orders.id, orderId));
}

/**
 * Applica il borsellino all'ordine. Da chiamare nella transazione che crea o
 * modifica l'ordine, DOPO l'inserimento delle righe e l'aggiornamento totali.
 */
export async function applyPartnerWalletToOrder(
  tx: Executor,
  input: { orderId: string; actorUserId: string | null; now?: Date },
) {
  const now = input.now ?? new Date();
  const [order] = await tx
    .select({ id: orders.id, retailerId: orders.retailerId, companyId: orders.companyId, status: orders.status, eventType: orders.eventType })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order || !order.retailerId || order.eventType || order.status === "cancelled") return { applied: [] as WalletPlanLine[] };

  const [settings] = await tx.select().from(partnerProgramSettings).where(eq(partnerProgramSettings.id, 1)).limit(1);
  if (!settings || order.companyId !== settings.billingCompanyId) return { applied: [] as WalletPlanLine[] };

  const [already] = await tx
    .select({ id: orderServiceLines.id })
    .from(orderServiceLines)
    .where(and(eq(orderServiceLines.orderId, order.id), inArray(orderServiceLines.serviceCode, WALLET_SERVICE_CODES)))
    .limit(1);
  if (already) return { applied: [] as WalletPlanLine[] };

  const states = await loadStatementStates(tx, order.retailerId, romeToday(now), true);
  if (states.length === 0) return { applied: [] as WalletPlanLine[] };

  const [merch] = await tx
    .select({ net: sql<string>`COALESCE(SUM(${orderItems.lineTotalNet}), 0)` })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const plan = planWalletApplication(states, merch?.net ?? "0");

  let netCents = 0;
  let vatCents = 0;
  for (const line of plan) {
    await tx.insert(partnerProgramApplications).values({
      statementId: line.statementId,
      orderId: order.id,
      entryType: "apply",
      creditNetApplied: line.creditNet,
      contributionNetCharged: line.contributionNet,
      createdBy: input.actorUserId,
    });
    const label = monthLabel(line.periodMonth);
    if (toCents(line.creditNet) > 0) {
      const net = fromCents(-toCents(line.creditNet));
      const gross = netToGross(net, line.creditVatRate);
      await tx.insert(orderServiceLines).values({
        orderId: order.id,
        companyId: order.companyId!,
        serviceCode: PARTNER_PROMO_CREDIT_CODE,
        serviceName: `Abbuono promo app SoKeto ${label}`,
        quantity: "1.000",
        unitPriceNet: net,
        vatRate: line.creditVatRate,
        lineTotalNet: net,
        lineTotalGross: gross,
        partnerProgramStatementId: line.statementId,
      });
      netCents += toCents(net);
      vatCents += toCents(gross) - toCents(net);
    }
    if (toCents(line.contributionNet) > 0) {
      const net = line.contributionNet;
      const gross = netToGross(net, line.contributionVatRate);
      await tx.insert(orderServiceLines).values({
        orderId: order.id,
        companyId: order.companyId!,
        serviceCode: PARTNER_CONTRIBUTION_CODE,
        serviceName: `Contributo Programma Partner SoKeto ${label}`,
        quantity: "1.000",
        unitPriceNet: net,
        vatRate: line.contributionVatRate,
        lineTotalNet: net,
        lineTotalGross: gross,
        partnerProgramStatementId: line.statementId,
      });
      netCents += toCents(net);
      vatCents += toCents(gross) - toCents(net);
    }
    const state = states.find((s) => s.id === line.statementId)!;
    const fullyUsed =
      toCents(state.creditApplied) + toCents(line.creditNet) >= toCents(state.creditNet) &&
      toCents(state.contributionCharged) + toCents(line.contributionNet) >= toCents(state.contributionNet);
    if (fullyUsed) {
      await tx.update(partnerProgramStatements)
        .set({ status: "settled", settledAt: now })
        .where(eq(partnerProgramStatements.id, line.statementId));
    }
  }
  await adjustOrderTotals(tx, order.id, netCents, vatCents);
  return { applied: plan };
}

/**
 * Restituisce al borsellino quanto usato dall'ordine (modifica o annullamento):
 * reversal nel ledger, rimozione delle righe e dei loro importi dai totali,
 * riapertura degli estratti ancora validi.
 */
export async function releasePartnerWalletForOrder(
  tx: Executor,
  input: { orderId: string; actorUserId: string | null; reason: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const active = await tx
    .select({
      id: partnerProgramApplications.id,
      statementId: partnerProgramApplications.statementId,
      credit: partnerProgramApplications.creditNetApplied,
      contribution: partnerProgramApplications.contributionNetCharged,
    })
    .from(partnerProgramApplications)
    .where(and(
      eq(partnerProgramApplications.orderId, input.orderId),
      eq(partnerProgramApplications.entryType, "apply"),
      sql`NOT EXISTS (SELECT 1 FROM partner_program_applications r WHERE r.reverses_application_id = ${partnerProgramApplications.id})`,
    ));

  for (const app of active) {
    await tx.insert(partnerProgramApplications).values({
      statementId: app.statementId,
      orderId: input.orderId,
      entryType: "reversal",
      reversesApplicationId: app.id,
      creditNetApplied: fromCents(-toCents(app.credit)),
      contributionNetCharged: fromCents(-toCents(app.contribution)),
      reversalReason: input.reason,
      createdBy: input.actorUserId,
    });
  }

  const lines = await tx
    .select({ id: orderServiceLines.id, net: orderServiceLines.lineTotalNet, gross: orderServiceLines.lineTotalGross })
    .from(orderServiceLines)
    .where(and(eq(orderServiceLines.orderId, input.orderId), inArray(orderServiceLines.serviceCode, WALLET_SERVICE_CODES)));
  if (lines.length > 0) {
    await tx.delete(orderServiceLines).where(inArray(orderServiceLines.id, lines.map((l) => l.id)));
    const netCents = lines.reduce((acc, l) => acc + toCents(l.net), 0);
    const grossCents = lines.reduce((acc, l) => acc + toCents(l.gross), 0);
    await adjustOrderTotals(tx, input.orderId, -netCents, -(grossCents - netCents));
  }

  const statementIds = Array.from(new Set(active.map((a) => a.statementId)));
  if (statementIds.length > 0) {
    const today = romeToday(now);
    await tx.update(partnerProgramStatements)
      .set({ status: "open", settledAt: null })
      .where(and(
        inArray(partnerProgramStatements.id, statementIds),
        eq(partnerProgramStatements.status, "settled"),
        gte(partnerProgramStatements.validUntil, today),
      ));
    await tx.update(partnerProgramStatements)
      .set({ status: "expired", settledAt: null, expiredAt: now })
      .where(and(
        inArray(partnerProgramStatements.id, statementIds),
        eq(partnerProgramStatements.status, "settled"),
        lt(partnerProgramStatements.validUntil, today),
      ));
  }
  return { reversed: active.length };
}

// ─────────────────────────── Letture ───────────────────────────

type StatementRow = typeof partnerProgramStatements.$inferSelect;

async function statementsWithUsage(db: Executor, where: ReturnType<typeof and>) {
  const rows: StatementRow[] = await db.select().from(partnerProgramStatements).where(where)
    .orderBy(sql`${partnerProgramStatements.periodMonth} DESC`);
  if (rows.length === 0) return [];
  const apps = await db
    .select({
      statementId: partnerProgramApplications.statementId,
      orderId: partnerProgramApplications.orderId,
      orderNumber: orders.orderNumber,
      credit: partnerProgramApplications.creditNetApplied,
      contribution: partnerProgramApplications.contributionNetCharged,
    })
    .from(partnerProgramApplications)
    .innerJoin(orders, eq(orders.id, partnerProgramApplications.orderId))
    .where(inArray(partnerProgramApplications.statementId, rows.map((r) => r.id)));

  return rows.map((r) => {
    const own = apps.filter((a) => a.statementId === r.id);
    const creditApplied = own.reduce((acc, a) => acc + toCents(a.credit), 0);
    const contributionCharged = own.reduce((acc, a) => acc + toCents(a.contribution), 0);
    const byOrder = new Map<string, { orderId: string; orderNumber: string; credit: number; contribution: number }>();
    for (const a of own) {
      const cur = byOrder.get(a.orderId) ?? { orderId: a.orderId, orderNumber: a.orderNumber, credit: 0, contribution: 0 };
      cur.credit += toCents(a.credit);
      cur.contribution += toCents(a.contribution);
      byOrder.set(a.orderId, cur);
    }
    const creditRemaining = Math.max(0, toCents(r.creditNet) - creditApplied);
    const contributionRemaining = Math.max(0, toCents(r.contributionNet) - contributionCharged);
    return {
      id: r.id,
      retailerId: r.retailerId,
      periodMonth: r.periodMonth,
      periodLabel: monthLabel(r.periodMonth),
      eventCount: r.eventCount,
      creditGross: r.creditGross,
      adjustmentGross: r.adjustmentGross,
      contributionGross: r.contributionGross,
      creditNet: r.creditNet,
      contributionNet: r.contributionNet,
      creditVatRate: r.creditVatRate,
      contributionVatRate: r.contributionVatRate,
      creditApplied: fromCents(creditApplied),
      contributionCharged: fromCents(contributionCharged),
      creditRemaining: fromCents(creditRemaining),
      contributionRemaining: fromCents(contributionRemaining),
      validUntil: r.validUntil,
      status: r.status as "open" | "settled" | "expired",
      orders: Array.from(byOrder.values())
        .filter((o) => o.credit !== 0 || o.contribution !== 0)
        .map((o) => ({ orderId: o.orderId, orderNumber: o.orderNumber, creditNet: fromCents(o.credit), contributionNet: fromCents(o.contribution) })),
    };
  });
}

/** Riepilogo per la pagina "Promo e Card" del rivenditore. */
export async function getRetailerPartnerProgramOverview(db: Executor, retailerId: string, now = new Date()) {
  const [retailer] = await db
    .select({ id: retailers.id, storeId: retailers.foodappsStoreId, companyId: retailers.companyId })
    .from(retailers)
    .where(eq(retailers.id, retailerId))
    .limit(1);
  if (!retailer) throw new Error("Rivenditore non trovato");
  const settings = await getPartnerProgramSettings(db);
  const statements = await statementsWithUsage(db, and(eq(partnerProgramStatements.retailerId, retailerId)));

  const today = romeToday(now);
  const available = statements.filter((s) => s.status === "open" && s.validUntil >= today);
  const walletCreditNet = available.reduce((acc, s) => acc + toCents(s.creditRemaining), 0);
  const walletContributionNet = available.reduce((acc, s) => acc + toCents(s.contributionRemaining), 0);
  const nextExpiry = available.filter((s) => toCents(s.creditRemaining) > 0).map((s) => s.validUntil).sort()[0] ?? null;

  // Mese in corso (e eventi sincronizzati ma non ancora in un estratto)
  let accruing = { from: romeMonthStart(now), events: 0, creditGross: "0.00", contributionGross: "0.00", purchaseGross: "0.00" };
  if (retailer.storeId) {
    const [row] = await db
      .select({
        events: sql<number>`COUNT(*)::int`,
        credit: sql<string>`COALESCE(SUM(${partnerProgramEvents.creditGross}), 0)`,
        contribution: sql<string>`COALESCE(SUM(${partnerProgramEvents.contributionGross}), 0)`,
        purchase: sql<string>`COALESCE(SUM(${partnerProgramEvents.purchaseGross}), 0)`,
      })
      .from(partnerProgramEvents)
      .where(and(
        eq(partnerProgramEvents.foodappsStoreId, retailer.storeId),
        isNull(partnerProgramEvents.statementId),
        isNull(partnerProgramEvents.cancelledAt),
        gte(partnerProgramEvents.occurredAt, romeMidnightUtc(settings.importStartDate)),
      ));
    accruing = {
      from: romeMonthStart(now),
      events: Number(row?.events ?? 0),
      creditGross: Number(row?.credit ?? 0).toFixed(2),
      contributionGross: Number(row?.contribution ?? 0).toFixed(2),
      purchaseGross: Number(row?.purchase ?? 0).toFixed(2),
    };
  }

  return {
    enrolled: retailer.storeId != null && retailer.companyId === settings.billingCompanyId,
    storeId: retailer.storeId,
    isBillingCompany: retailer.companyId === settings.billingCompanyId,
    wallet: {
      creditNet: fromCents(walletCreditNet),
      contributionNet: fromCents(walletContributionNet),
      nextExpiry,
    },
    accruing,
    statements,
    lastSyncAt: settings.lastSyncAt,
  };
}

/** Dettaglio convalide di un mese (estratto chiuso o mese in corso). */
export async function getRetailerPartnerProgramEvents(db: Executor, retailerId: string, input: { statementId?: string; now?: Date }) {
  const [retailer] = await db
    .select({ storeId: retailers.foodappsStoreId })
    .from(retailers)
    .where(eq(retailers.id, retailerId))
    .limit(1);
  if (!retailer?.storeId) return [];
  const settings = await getPartnerProgramSettings(db);
  let where;
  if (input.statementId) {
    const [st] = await db.select({ id: partnerProgramStatements.id }).from(partnerProgramStatements)
      .where(and(eq(partnerProgramStatements.id, input.statementId), eq(partnerProgramStatements.retailerId, retailerId))).limit(1);
    if (!st) return [];
    where = eq(partnerProgramEvents.statementId, st.id);
  } else {
    where = and(
      eq(partnerProgramEvents.foodappsStoreId, retailer.storeId),
      isNull(partnerProgramEvents.statementId),
      gte(partnerProgramEvents.occurredAt, romeMidnightUtc(settings.importStartDate)),
    );
  }
  const rows = await db.select({
    id: partnerProgramEvents.id,
    source: partnerProgramEvents.source,
    occurredAt: partnerProgramEvents.occurredAt,
    label: partnerProgramEvents.label,
    campaignKey: partnerProgramEvents.campaignKey,
    purchaseGross: partnerProgramEvents.purchaseGross,
    discountGross: partnerProgramEvents.discountGross,
    creditGross: partnerProgramEvents.creditGross,
    contributionGross: partnerProgramEvents.contributionGross,
    cancelledAt: partnerProgramEvents.cancelledAt,
  }).from(partnerProgramEvents).where(where).orderBy(sql`${partnerProgramEvents.occurredAt} DESC`).limit(1000);
  return rows;
}

/** Riepilogo amministrativo: tutti i rivenditori abbinati + negozi non abbinati. */
export async function getPartnerProgramAdminOverview(db: Executor, now = new Date()) {
  const settings = await getPartnerProgramSettings(db);
  const today = romeToday(now);
  const mapped = await db
    .select({ id: retailers.id, name: retailers.name, storeId: retailers.foodappsStoreId, companyId: retailers.companyId })
    .from(retailers)
    .where(isNotNull(retailers.foodappsStoreId))
    .orderBy(asc(retailers.name));

  const statements = await statementsWithUsage(db, and(sql`TRUE`));
  const accruingRows = await db
    .select({
      storeId: partnerProgramEvents.foodappsStoreId,
      storeName: sql<string | null>`MAX(${partnerProgramEvents.storeName})`,
      events: sql<number>`COUNT(*)::int`,
      credit: sql<string>`COALESCE(SUM(${partnerProgramEvents.creditGross}), 0)`,
      contribution: sql<string>`COALESCE(SUM(${partnerProgramEvents.contributionGross}), 0)`,
    })
    .from(partnerProgramEvents)
    .where(and(
      isNull(partnerProgramEvents.statementId),
      isNull(partnerProgramEvents.cancelledAt),
      gte(partnerProgramEvents.occurredAt, romeMidnightUtc(settings.importStartDate)),
    ))
    .groupBy(partnerProgramEvents.foodappsStoreId);
  const accruingByStore = new Map(accruingRows.map((r) => [r.storeId, r]));
  const mappedStoreIds = new Set(mapped.map((m) => m.storeId));

  const rows = mapped.map((m) => {
    const own = statements.filter((s) => s.retailerId === m.id);
    const open = own.filter((s) => s.status === "open" && s.validUntil >= today);
    const acc = accruingByStore.get(m.storeId!);
    return {
      retailerId: m.id,
      retailerName: m.name,
      storeId: m.storeId!,
      storeName: acc?.storeName ?? null,
      wrongCompany: m.companyId !== settings.billingCompanyId,
      accruingEvents: Number(acc?.events ?? 0),
      accruingCreditGross: Number(acc?.credit ?? 0).toFixed(2),
      accruingContributionGross: Number(acc?.contribution ?? 0).toFixed(2),
      walletCreditNet: fromCents(open.reduce((a, s) => a + toCents(s.creditRemaining), 0)),
      walletContributionNet: fromCents(open.reduce((a, s) => a + toCents(s.contributionRemaining), 0)),
      contributionToInvoiceNet: fromCents(own
        .filter((s) => s.status === "expired")
        .reduce((a, s) => a + toCents(s.contributionRemaining), 0)),
    };
  });

  const unmappedStores = accruingRows
    .filter((r) => !mappedStoreIds.has(r.storeId))
    .map((r) => ({
      storeId: r.storeId,
      storeName: r.storeName,
      events: Number(r.events),
      creditGross: Number(r.credit).toFixed(2),
      contributionGross: Number(r.contribution).toFixed(2),
    }));

  return {
    settings: {
      creditVatRate: settings.creditVatRate,
      contributionVatRate: settings.contributionVatRate,
      importStartDate: settings.importStartDate,
      lastSyncAt: settings.lastSyncAt,
      lastSyncError: settings.lastSyncError,
      exportConfigured: exportConfig() != null,
    },
    rows,
    unmappedStores,
  };
}

