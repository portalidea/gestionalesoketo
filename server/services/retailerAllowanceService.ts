import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  orderPromotionBonuses,
  pricingPackages,
  retailerAllowanceConsumptions,
  retailerAllowances,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  calculateOrderPricing,
  type PricingDatabase,
  type PricingItemInput,
  type PricingItemOutput,
  type PricingResult,
} from "../pricing";

type Database = PricingDatabase;

export const EKETO_COMPANY_ID = "00000000-0000-0000-0000-000000000001";
export const SOKETO_COMPANY_ID = "00000000-0000-0000-0000-000000000002";

export type AllowanceType = "restaurant_package" | "investor_benefit" | "promo_bonus";

export type AllowanceActivationInput = {
  retailerId: string;
  companyId: string;
  allowanceType: AllowanceType;
  sourceAmount: number;
  sourceReference: string;
  sourceReceivedAt: Date | null;
  activatedAt: Date;
  packageInvoiceReference?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  initialAmountOverride?: number;
  valuationDiscountPercentOverride?: number;
  postExhaustionPricingPackageIdOverride?: string;
};

export type AllowancePricingLine = PricingItemOutput & {
  allowanceCovered: boolean;
  allowanceConsumptionAmount: string | null;
  /** Plafond che finanzia la riga gratuita, mai dedotto a posteriori. */
  allowanceId: string | null;
  allowanceValuationDiscountPercent: string | null;
};

export type AllowanceConsumptionPlan = {
  /** Chiave deterministica scelta durante il pricing e scritta nel ledger. */
  allowanceId: string;
  /** Indice della riga pricing generata nello stesso passaggio del piano. */
  pricingLineIndex: number;
  productId: string;
  quantity: number;
  listUnitPrice: string;
  valuationDiscountPercent: string;
  consumptionAmount: string;
};

export type AllowancePricingAllowance = {
  id: string;
  initialAmount: string;
  consumedAmount: string;
  remainingBefore: string;
  remainingAfter: string;
  valuationDiscountPercent: string;
  postExhaustionPackageName: string;
};

export type AllowancePricingResult = Omit<PricingResult, "items" | "subtotalNet" | "vatAmount" | "totalGross"> & {
  items: AllowancePricingLine[];
  subtotalNet: string;
  vatAmount: string;
  totalGross: string;
  /** Compatibilità con i chiamanti monoplafond: è il primo plafond in priorità. */
  allowance: AllowancePricingAllowance | null;
  /** Tutti i plafond eleggibili, nell'ordine effettivo di consumo. */
  allowances: AllowancePricingAllowance[];
  /** Piano autorevole di scrittura del ledger; non viene ricostruito dalle righe ordine. */
  allowanceConsumptionPlan: AllowanceConsumptionPlan[];
};

export type PersistedAllowanceConsumption = {
  allowanceId: string;
  orderId: string;
  createdBy: string;
  productId: string;
  quantity: number;
  listUnitPrice: string;
  valuationDiscountPercent: string;
  consumptionAmount: string;
};

type AllowanceRecord = {
  id: string;
  initialAmount: string;
  valuationDiscountPercent: string;
  postExhaustionPricingPackageId: string;
  postExhaustionPackageName: string;
  allowanceType: string;
  sourceAmount: string;
  sourceReference: string;
  sourceReceivedAt: Date;
  activatedAt: Date;
  status: string;
};

export type AllowanceSummary = {
  id: string;
  status: string;
  initialAmount: string;
  consumedAmount: string;
  remainingAmount: string;
  valuationDiscountPercent: string;
  postExhaustionPackageName: string;
  allowanceType: AllowanceType;
  sourceAmount: string;
  sourceReference: string;
  sourceReceivedAt: Date;
};

export type RetailerAllowanceSummary = AllowanceSummary & {
  /** Il plafond prioritario che mantiene il contratto storico dei campi root. */
  primaryAllowanceId: string;
  /** Totali aggregati, utili alle card che visualizzano un solo importo. */
  totalInitialAmount: string;
  totalConsumedAmount: string;
  totalRemainingAmount: string;
  /** Dettaglio completo dei plafond attivi/eleggibili in ordine di consumo. */
  allowances: AllowanceSummary[];
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value: number) => round2(value).toFixed(2);

function assertValidSource(input: AllowanceActivationInput) {
  if (!Number.isFinite(input.sourceAmount) || input.sourceAmount <= 0) {
    throw new Error("L'importo di origine deve essere maggiore di zero.");
  }
  if (!input.sourceReference.trim()) {
    throw new Error("Il riferimento dell'origine è obbligatorio.");
  }
  if (!(input.sourceReceivedAt instanceof Date) || Number.isNaN(input.sourceReceivedAt.getTime())) {
    throw new Error("La data di incasso dell'origine è obbligatoria e valida.");
  }
}

/**
 * Regole centrali per i plafond commerciali.
 * restaurant_package: sempre E-Keto, € 1.000, Premium congelato.
 * investor_benefit: sempre SoKeto, 5% dell'investimento incassato, listino.
 */
export async function prepareAllowanceActivation(
  database: Database,
  input: AllowanceActivationInput,
) {
  assertValidSource(input);

  const [premium] = await database
    .select({ id: pricingPackages.id, discountPercent: pricingPackages.discountPercent })
    .from(pricingPackages)
    .where(eq(pricingPackages.name, "Premium"))
    .orderBy(pricingPackages.sortOrder, pricingPackages.id)
    .limit(1);

  if (!premium) throw new Error("Pacchetto Premium non configurato.");

  if (input.allowanceType === "restaurant_package") {
    if (input.companyId !== EKETO_COMPANY_ID) throw new Error("Il credito pacchetto ristoratore può appartenere solo a E-Keto Food Srls.");
    return { initialAmount: "1000.00", valuationDiscountPercent: premium.discountPercent, postExhaustionPricingPackageId: premium.id };
  }
  if (input.allowanceType === "promo_bonus") {
    if (!Number.isFinite(input.initialAmountOverride) || (input.initialAmountOverride ?? 0) <= 0) throw new Error("L'importo del bonus promozionale è obbligatorio.");
    if (input.valuationDiscountPercentOverride !== 0) throw new Error("Il bonus promozionale deve essere valorizzato a prezzo al pubblico.");
    if (!input.postExhaustionPricingPackageIdOverride) throw new Error("Il pacchetto post-esaurimento del bonus è obbligatorio.");
    return { initialAmount: money(input.initialAmountOverride!), valuationDiscountPercent: "0.00", postExhaustionPricingPackageId: input.postExhaustionPricingPackageIdOverride };
  }
  if (input.companyId !== SOKETO_COMPANY_ID) throw new Error("Il beneficio investitore può appartenere solo a SoKeto Srl.");
  return { initialAmount: money(input.sourceAmount * 0.05), valuationDiscountPercent: "0.00", postExhaustionPricingPackageId: premium.id };
}

/** Crea un plafond applicando sempre le regole di tipo centralizzate. */
export async function createRetailerAllowance(
  database: Database,
  input: AllowanceActivationInput,
) {
  const prepared = await prepareAllowanceActivation(database, input);
  const [allowance] = await database
    .insert(retailerAllowances)
    .values({
      retailerId: input.retailerId,
      billingCompanyId: input.companyId,
      initialAmount: prepared.initialAmount,
      valuationDiscountPercent: prepared.valuationDiscountPercent,
      activatedAt: input.activatedAt,
      packageInvoiceReference: input.packageInvoiceReference ?? null,
      postExhaustionPricingPackageId: prepared.postExhaustionPricingPackageId,
      status: "active",
      allowanceType: input.allowanceType,
      sourceAmount: money(input.sourceAmount),
      sourceReference: input.sourceReference.trim(),
      sourceReceivedAt: input.sourceReceivedAt!,
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: retailerAllowances.id });
  return { id: allowance!.id, ...prepared };
}

/**
 * Plafond utilizzabili nell'ordine di consumo.
 *
 * I bonus promo vengono prima, in attivazione crescente; il plafond base è
 * quindi il fallback. Un bonus è fail-closed: oltre allo stato active del
 * plafond richiede il record bonus ancora granted. Così exhausted, cancelled,
 * review_required/revoked e record non auditati non concedono merce gratuita.
 */
async function getActiveAllowances(
  database: Database,
  retailerId: string,
  companyId: string,
  forUpdate = false,
): Promise<AllowanceRecord[]> {
  const query = database
    .select({
      id: retailerAllowances.id,
      initialAmount: retailerAllowances.initialAmount,
      valuationDiscountPercent: retailerAllowances.valuationDiscountPercent,
      postExhaustionPricingPackageId: retailerAllowances.postExhaustionPricingPackageId,
      postExhaustionPackageName: pricingPackages.name,
      allowanceType: retailerAllowances.allowanceType,
      sourceAmount: retailerAllowances.sourceAmount,
      sourceReference: retailerAllowances.sourceReference,
      sourceReceivedAt: retailerAllowances.sourceReceivedAt,
      activatedAt: retailerAllowances.activatedAt,
      status: retailerAllowances.status,
    })
    .from(retailerAllowances)
    .innerJoin(pricingPackages, eq(pricingPackages.id, retailerAllowances.postExhaustionPricingPackageId))
    .where(and(
      eq(retailerAllowances.retailerId, retailerId),
      eq(retailerAllowances.billingCompanyId, companyId),
      eq(retailerAllowances.status, "active"),
      sql`(
        ${retailerAllowances.allowanceType} <> 'promo_bonus'
        OR EXISTS (
          SELECT 1
          FROM order_promotion_bonuses bonus_audit
          WHERE bonus_audit."allowanceId" = ${retailerAllowances.id}
            AND bonus_audit.status = 'granted'
        )
      )`,
    ))
    .orderBy(
      sql`CASE WHEN ${retailerAllowances.allowanceType} = 'promo_bonus' THEN 0 ELSE 1 END`,
      retailerAllowances.activatedAt,
      retailerAllowances.createdAt,
      retailerAllowances.id,
    );
  return (forUpdate ? query.for("update") : query) as Promise<AllowanceRecord[]>;
}

/** Tutti i plafond della scheda retailer, inclusi quelli non più utilizzabili. */
async function getRetailerAllowances(
  database: Database,
  retailerId: string,
  companyId: string,
): Promise<AllowanceRecord[]> {
  return database
    .select({
      id: retailerAllowances.id,
      initialAmount: retailerAllowances.initialAmount,
      valuationDiscountPercent: retailerAllowances.valuationDiscountPercent,
      postExhaustionPricingPackageId: retailerAllowances.postExhaustionPricingPackageId,
      postExhaustionPackageName: pricingPackages.name,
      allowanceType: retailerAllowances.allowanceType,
      sourceAmount: retailerAllowances.sourceAmount,
      sourceReference: retailerAllowances.sourceReference,
      sourceReceivedAt: retailerAllowances.sourceReceivedAt,
      activatedAt: retailerAllowances.activatedAt,
      status: retailerAllowances.status,
    })
    .from(retailerAllowances)
    .innerJoin(pricingPackages, eq(pricingPackages.id, retailerAllowances.postExhaustionPricingPackageId))
    .where(and(
      eq(retailerAllowances.retailerId, retailerId),
      eq(retailerAllowances.billingCompanyId, companyId),
    ))
    .orderBy(
      sql`CASE WHEN ${retailerAllowances.status} = 'active' THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${retailerAllowances.allowanceType} = 'promo_bonus' THEN 0 ELSE 1 END`,
      retailerAllowances.activatedAt,
      retailerAllowances.createdAt,
      retailerAllowances.id,
    ) as Promise<AllowanceRecord[]>;
}

async function getConsumedAmount(database: Database, allowanceId: string) {
  const [row] = await database
    .select({
      amount: sql<string>`COALESCE(SUM(${retailerAllowanceConsumptions.consumptionAmount}), 0)::text`,
    })
    .from(retailerAllowanceConsumptions)
    .where(eq(retailerAllowanceConsumptions.allowanceId, allowanceId));
  return parseFloat(row?.amount ?? "0");
}

async function formatAllowanceSummary(
  database: Database,
  allowance: AllowanceRecord,
): Promise<AllowanceSummary> {
  const consumedAmount = await getConsumedAmount(database, allowance.id);
  return {
    id: allowance.id,
    status: allowance.status,
    initialAmount: allowance.initialAmount,
    consumedAmount: money(consumedAmount),
    remainingAmount: money(Math.max(0, parseFloat(allowance.initialAmount) - consumedAmount)),
    valuationDiscountPercent: allowance.valuationDiscountPercent,
    postExhaustionPackageName: allowance.postExhaustionPackageName,
    allowanceType: allowance.allowanceType as AllowanceType,
    sourceAmount: allowance.sourceAmount,
    sourceReference: allowance.sourceReference,
    sourceReceivedAt: allowance.sourceReceivedAt,
  };
}

async function formatAllowanceSummaries(database: Database, allowances: AllowanceRecord[]) {
  return Promise.all(allowances.map((allowance) => formatAllowanceSummary(database, allowance)));
}

function aggregateAllowanceSummary(allowances: AllowanceSummary[]): RetailerAllowanceSummary | null {
  const primary = allowances[0];
  if (!primary) return null;
  const initialAmount = allowances.reduce((sum, allowance) => sum + parseFloat(allowance.initialAmount), 0);
  const consumedAmount = allowances.reduce((sum, allowance) => sum + parseFloat(allowance.consumedAmount), 0);
  const remainingAmount = allowances.reduce((sum, allowance) => sum + parseFloat(allowance.remainingAmount), 0);
  return {
    ...primary,
    primaryAllowanceId: primary.id,
    totalInitialAmount: money(initialAmount),
    totalConsumedAmount: money(consumedAmount),
    totalRemainingAmount: money(remainingAmount),
    allowances,
  };
}

function recalculateResult(base: PricingResult, items: AllowancePricingLine[]): AllowancePricingResult {
  const subtotalNet = round2(items.reduce((sum, item) => sum + parseFloat(item.lineTotalNet), 0));
  const totalGross = round2(items.reduce((sum, item) => sum + parseFloat(item.lineTotalGross), 0));
  return {
    ...base,
    items,
    subtotalNet: money(subtotalNet),
    vatAmount: money(totalGross - subtotalNet),
    totalGross: money(totalGross),
    allowance: null,
    allowances: [],
    allowanceConsumptionPlan: [],
  };
}

/**
 * Calcola prezzi e plafond in modo autorevole. I bonus promo sono consumati
 * prima (activatedAt crescente), poi l'unico plafond base attivo. Il prezzo
 * della quota non coperta è calcolato con il package post-esaurimento del
 * plafond che chiude la catena, non con quello del primo bonus.
 */
export async function calculateOrderPricingWithAllowance(input: {
  database?: Database;
  retailerId: string;
  companyId: string;
  items: PricingItemInput[];
  markupPercentageOverride?: number | null;
  lockAllowance?: boolean;
}): Promise<AllowancePricingResult> {
  const database = input.database ?? await getDb();
  if (!database) throw new Error("Database non disponibile");

  const allowances = await getActiveAllowances(
    database,
    input.retailerId,
    input.companyId,
    Boolean(input.lockAllowance),
  );

  if (allowances.length === 0) {
    const pricing = await calculateOrderPricing({
      retailerId: input.retailerId,
      companyId: input.companyId,
      items: input.items,
      markupPercentageOverride: input.markupPercentageOverride,
      database,
    });
    return recalculateResult(
      pricing,
      pricing.items.map((item) => ({
        ...item,
        allowanceCovered: false,
        allowanceConsumptionAmount: null,
        allowanceId: null,
        allowanceValuationDiscountPercent: null,
      })),
    );
  }

  // Dopo l'ultimo plafond in priorità il prezzo deve essere quello del suo
  // package post-esaurimento. È fondamentale quando bonus e plafond base hanno
  // package differenti: usare il primo bonus renderebbe errata la quota pagata.
  const postExhaustionAllowance = allowances[allowances.length - 1]!;
  const paidPricing = await calculateOrderPricing({
    companyId: input.companyId,
    items: input.items,
    pricingPackageIdOverride: postExhaustionAllowance.postExhaustionPricingPackageId,
    database,
  });
  const states = await Promise.all(allowances.map(async (allowance) => {
    const consumed = await getConsumedAmount(database, allowance.id);
    const remainingBefore = Math.max(0, round2(parseFloat(allowance.initialAmount) - consumed));
    return { allowance, consumed, remainingBefore, remaining: remainingBefore };
  }));

  const pricedItems: AllowancePricingLine[] = [];
  const allowanceConsumptionPlan: AllowanceConsumptionPlan[] = [];
  for (const item of paidPricing.items) {
    let remainingQuantity = item.quantity;
    for (const state of states) {
      const consumptionPerUnit = parseFloat(item.unitPriceBase)
        * (1 - parseFloat(state.allowance.valuationDiscountPercent) / 100);
      // Le quantità ordine sono confezioni intere; un residuo minore del costo
      // di una confezione non finanzia quote frazionarie di merce.
      const coveredQuantity = consumptionPerUnit > 0
        ? Math.min(remainingQuantity, Math.floor((state.remaining + 0.000001) / consumptionPerUnit))
        : 0;
      if (coveredQuantity <= 0) continue;

      const consumptionAmount = round2(consumptionPerUnit * coveredQuantity);
      state.remaining = Math.max(0, round2(state.remaining - consumptionAmount));
      remainingQuantity -= coveredQuantity;
      const plan: AllowanceConsumptionPlan = {
        allowanceId: state.allowance.id,
        pricingLineIndex: pricedItems.length,
        productId: item.productId,
        quantity: coveredQuantity,
        listUnitPrice: item.unitPriceBase,
        valuationDiscountPercent: state.allowance.valuationDiscountPercent,
        consumptionAmount: money(consumptionAmount),
      };
      allowanceConsumptionPlan.push(plan);
      pricedItems.push({
        ...item,
        quantity: coveredQuantity,
        discountPercent: "100.00",
        unitPriceFinal: "0.00",
        lineTotalNet: "0.00",
        lineTotalGross: "0.00",
        allowanceCovered: true,
        allowanceConsumptionAmount: plan.consumptionAmount,
        allowanceId: plan.allowanceId,
        allowanceValuationDiscountPercent: plan.valuationDiscountPercent,
      });
    }
    if (remainingQuantity > 0) {
      const lineTotalNet = round2(parseFloat(item.unitPriceFinal) * remainingQuantity);
      pricedItems.push({
        ...item,
        quantity: remainingQuantity,
        lineTotalNet: money(lineTotalNet),
        lineTotalGross: money(lineTotalNet * (1 + parseFloat(item.vatRate) / 100)),
        allowanceCovered: false,
        allowanceConsumptionAmount: null,
        allowanceId: null,
        allowanceValuationDiscountPercent: null,
      });
    }
  }

  const result = recalculateResult(paidPricing, pricedItems);
  result.allowances = states.map((state) => ({
    id: state.allowance.id,
    initialAmount: state.allowance.initialAmount,
    consumedAmount: money(state.consumed),
    remainingBefore: money(state.remainingBefore),
    remainingAfter: money(state.remaining),
    valuationDiscountPercent: state.allowance.valuationDiscountPercent,
    postExhaustionPackageName: state.allowance.postExhaustionPackageName,
  }));
  result.allowance = result.allowances[0] ?? null;
  result.allowanceConsumptionPlan = allowanceConsumptionPlan;
  return result;
}

/**
 * Registra nel ledger le quote gratuite pianificate dal pricing. L'ordine dei
 * writer può spezzare le righe per FEFO e l'INSERT non restituisce i loro ID;
   * per questo non si tenta mai un match post-hoc prodotto/quantità. I writer
   * passano gli ID restituiti dall'INSERT nella stessa sequenza delle righe
   * pricing: il piano conserva il relativo indice, quindi ogni entry punta in
   * modo esplicito alla sua orderItem senza matching ambiguo.
 */
export async function persistAllowanceConsumptions(
  database: Database,
  input: {
    orderId: string;
    createdBy: string;
    pricing: AllowancePricingResult;
    orderItemIdsByPricingLine?: Array<string | null>;
  },
) {
  const plans = input.pricing.allowanceConsumptionPlan;
  if (plans.length === 0) return;
  if (plans.some((plan) => !plan.allowanceId || plan.quantity <= 0 || parseFloat(plan.consumptionAmount) <= 0)) {
    throw new Error("Piano consumo plafond non valido.");
  }
  if (input.orderItemIdsByPricingLine && plans.some((plan) => !input.orderItemIdsByPricingLine?.[plan.pricingLineIndex])) {
    throw new Error("Riga ordine plafond non trovata dopo la creazione dell'ordine.");
  }

  const rows = plans.map((plan) => ({
    allowanceId: plan.allowanceId,
    orderId: input.orderId,
    orderItemId: input.orderItemIdsByPricingLine?.[plan.pricingLineIndex] ?? null,
    entryType: "consumption" as const,
    reversesConsumptionId: null,
    coveredQuantity: plan.quantity.toFixed(6),
    listUnitPriceSnapshot: plan.listUnitPrice,
    valuationDiscountPercentSnapshot: plan.valuationDiscountPercent,
    consumptionAmount: plan.consumptionAmount,
    createdBy: input.createdBy,
    reversalReason: null,
  }));

  await database.insert(retailerAllowanceConsumptions).values(rows);
}

/**
 * Inserisce reversal idempotenti per tutti i consumi ancora attivi dell'ordine.
 * Va invocata nella stessa transazione della riscrittura o dell'annullamento.
 */
export async function reverseAllowanceConsumptionsForOrder(
  database: Database,
  input: { orderId: string; createdBy: string; reason: string },
) {
  const originals = await database
    .select({
      id: retailerAllowanceConsumptions.id,
      allowanceId: retailerAllowanceConsumptions.allowanceId,
      orderItemId: retailerAllowanceConsumptions.orderItemId,
      coveredQuantity: retailerAllowanceConsumptions.coveredQuantity,
      listUnitPriceSnapshot: retailerAllowanceConsumptions.listUnitPriceSnapshot,
      valuationDiscountPercentSnapshot: retailerAllowanceConsumptions.valuationDiscountPercentSnapshot,
      consumptionAmount: retailerAllowanceConsumptions.consumptionAmount,
    })
    .from(retailerAllowanceConsumptions)
    .where(
      and(
        eq(retailerAllowanceConsumptions.orderId, input.orderId),
        eq(retailerAllowanceConsumptions.entryType, "consumption"),
      ),
    );

  if (originals.length === 0) return 0;
  const reversalRows = await database
    .select({ reversesConsumptionId: retailerAllowanceConsumptions.reversesConsumptionId })
    .from(retailerAllowanceConsumptions)
    .where(
      and(
        eq(retailerAllowanceConsumptions.orderId, input.orderId),
        eq(retailerAllowanceConsumptions.entryType, "reversal"),
      ),
    );
  const reversed = new Set(reversalRows.map((row) => row.reversesConsumptionId).filter(Boolean));
  const rows = originals
    .filter((original) => !reversed.has(original.id))
    .map((original) => ({
      allowanceId: original.allowanceId,
      orderId: input.orderId,
      orderItemId: original.orderItemId,
      entryType: "reversal" as const,
      reversesConsumptionId: original.id,
      coveredQuantity: (-parseFloat(original.coveredQuantity)).toFixed(6),
      listUnitPriceSnapshot: original.listUnitPriceSnapshot,
      valuationDiscountPercentSnapshot: original.valuationDiscountPercentSnapshot,
      consumptionAmount: money(-parseFloat(original.consumptionAmount)),
      createdBy: input.createdBy,
      reversalReason: input.reason,
    }));
  if (rows.length > 0) await database.insert(retailerAllowanceConsumptions).values(rows);
  return rows.length;
}

/**
 * Restituisce tutti i plafond attivi/eleggibili per card admin e portale.
 * I campi storici root descrivono il primo plafond prioritario; `allowances`
 * espone il dettaglio completo e i campi total* permettono una card aggregata.
 */
export async function getRetailerAllowanceSummary(
  database: Database,
  retailerId: string,
  companyId: string,
): Promise<RetailerAllowanceSummary | null> {
  const allowances = await getActiveAllowances(database, retailerId, companyId);
  return aggregateAllowanceSummary(await formatAllowanceSummaries(database, allowances));
}

/** Riepiloghi attivi, uno per retailer, per la lista rivenditori della company. */
export async function getCompanyAllowanceSummaries(database: Database, companyId: string) {
  const rows = await database
    .select({ retailerId: retailerAllowances.retailerId })
    .from(retailerAllowances)
    .leftJoin(orderPromotionBonuses, eq(orderPromotionBonuses.allowanceId, retailerAllowances.id))
    .where(and(
      eq(retailerAllowances.billingCompanyId, companyId),
      eq(retailerAllowances.status, "active"),
      or(
        ne(retailerAllowances.allowanceType, "promo_bonus"),
        eq(orderPromotionBonuses.status, "granted"),
      ),
    ));
  const retailerIds = Array.from(new Set(rows.map((row) => row.retailerId)));
  const summaries = await Promise.all(retailerIds.map(async (retailerId) => ({
    retailerId,
    summary: await getRetailerAllowanceSummary(database, retailerId, companyId),
  })));
  return summaries.flatMap(({ retailerId, summary }) => summary ? [{ retailerId, ...summary }] : []);
}

/** Storico completo dei plafond e dei loro consumi per la scheda amministrativa. */
export async function getRetailerAllowanceLedger(
  database: Database,
  retailerId: string,
  companyId: string,
) {
  const allowanceRows = await getRetailerAllowances(database, retailerId, companyId);
  if (allowanceRows.length === 0) return { allowance: null, allowances: [], entries: [] };

  const allowances = await formatAllowanceSummaries(database, allowanceRows);
  const allowanceIds = allowances.map((allowance) => allowance.id);
  const entries = await database
    .select({
      id: retailerAllowanceConsumptions.id,
      allowanceId: retailerAllowanceConsumptions.allowanceId,
      entryType: retailerAllowanceConsumptions.entryType,
      coveredQuantity: retailerAllowanceConsumptions.coveredQuantity,
      consumptionAmount: retailerAllowanceConsumptions.consumptionAmount,
      createdAt: retailerAllowanceConsumptions.createdAt,
      reversalReason: retailerAllowanceConsumptions.reversalReason,
      orderId: retailerAllowanceConsumptions.orderId,
    })
    .from(retailerAllowanceConsumptions)
    .where(inArray(retailerAllowanceConsumptions.allowanceId, allowanceIds))
    .orderBy(desc(retailerAllowanceConsumptions.createdAt), retailerAllowanceConsumptions.id);
  return { allowance: allowances[0] ?? null, allowances, entries };
}

/**
 * Origini economiche cross-company. La chiave (amount, reference, receivedAt)
 * identifica un unico versamento, anche se nel caso 3 genera due plafond.
 */
export async function getAllowanceOriginReport(
  database: Database,
  companyIds: string[],
) {
  if (companyIds.length === 0) return [];

  const rows = await database
    .select({
      sourceAmount: retailerAllowances.sourceAmount,
      sourceReference: retailerAllowances.sourceReference,
      sourceReceivedAt: retailerAllowances.sourceReceivedAt,
      allowancesCount: sql<number>`COUNT(${retailerAllowances.id})::int`,
      initialAmountTotal: sql<string>`SUM(${retailerAllowances.initialAmount})::text`,
      companyIds: sql<string[]>`array_agg(DISTINCT ${retailerAllowances.billingCompanyId}::text)`,
      allowanceTypes: sql<string[]>`array_agg(DISTINCT ${retailerAllowances.allowanceType})`,
    })
    .from(retailerAllowances)
    .where(inArray(retailerAllowances.billingCompanyId, companyIds))
    .groupBy(
      retailerAllowances.sourceAmount,
      retailerAllowances.sourceReference,
      retailerAllowances.sourceReceivedAt,
    )
    .orderBy(desc(retailerAllowances.sourceReceivedAt), retailerAllowances.sourceReference);

  return rows.map((row) => ({
    ...row,
    sourceAmount: money(parseFloat(row.sourceAmount)),
    initialAmountTotal: money(parseFloat(row.initialAmountTotal)),
    isSharedOrigin: row.allowancesCount > 1,
  }));
}
