import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  orderItems,
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

export type AllowanceType = "restaurant_package" | "investor_benefit";

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
};

export type AllowancePricingLine = PricingItemOutput & {
  allowanceCovered: boolean;
  allowanceConsumptionAmount: string | null;
};

export type AllowancePricingResult = Omit<PricingResult, "items" | "subtotalNet" | "vatAmount" | "totalGross"> & {
  items: AllowancePricingLine[];
  subtotalNet: string;
  vatAmount: string;
  totalGross: string;
  allowance: {
    id: string;
    initialAmount: string;
    consumedAmount: string;
    remainingBefore: string;
    remainingAfter: string;
    valuationDiscountPercent: string;
    postExhaustionPackageName: string;
  } | null;
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
    if (input.companyId !== EKETO_COMPANY_ID) {
      throw new Error("Il credito pacchetto ristoratore può appartenere solo a E-Keto Food Srls.");
    }
    return {
      initialAmount: "1000.00",
      valuationDiscountPercent: premium.discountPercent,
      postExhaustionPricingPackageId: premium.id,
    };
  }

  if (input.companyId !== SOKETO_COMPANY_ID) {
    throw new Error("Il beneficio investitore può appartenere solo a SoKeto Srl.");
  }
  return {
    initialAmount: money(input.sourceAmount * 0.05),
    valuationDiscountPercent: "0.00",
    postExhaustionPricingPackageId: premium.id,
  };
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

async function getActiveAllowance(
  database: Database,
  retailerId: string,
  companyId: string,
  forUpdate = false,
) {
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
    })
    .from(retailerAllowances)
    .innerJoin(
      pricingPackages,
      eq(pricingPackages.id, retailerAllowances.postExhaustionPricingPackageId),
    )
    .where(
      and(
        eq(retailerAllowances.retailerId, retailerId),
        eq(retailerAllowances.billingCompanyId, companyId),
        eq(retailerAllowances.status, "active"),
      ),
    )
    .limit(1);

  return forUpdate ? query.for("update") : query;
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

async function getLatestAllowance(
  database: Database,
  retailerId: string,
  companyId: string,
) {
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
      status: retailerAllowances.status,
    })
    .from(retailerAllowances)
    .innerJoin(
      pricingPackages,
      eq(pricingPackages.id, retailerAllowances.postExhaustionPricingPackageId),
    )
    .where(
      and(
        eq(retailerAllowances.retailerId, retailerId),
        eq(retailerAllowances.billingCompanyId, companyId),
      ),
    )
    .orderBy(desc(retailerAllowances.activatedAt), desc(retailerAllowances.createdAt))
    .limit(1);
}

async function formatAllowanceSummary(
  database: Database,
  allowance: Awaited<ReturnType<typeof getLatestAllowance>>[number],
) {
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
  };
}

/**
 * Calcola prezzi e plafond in modo autorevole. Quando esiste un plafond attivo,
 * il prezzo della quota non coperta deriva dal package post-esaurimento,
 * mentre ogni confezione coperta conserva un consumo a prezzo listino scontato
 * con percentuale congelata sull'attivazione.
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

  const [allowance] = await getActiveAllowance(
    database,
    input.retailerId,
    input.companyId,
    Boolean(input.lockAllowance),
  );

  if (!allowance) {
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
      })),
    );
  }

  const basePricing = await calculateOrderPricing({
    companyId: input.companyId,
    items: input.items,
    pricingPackageIdOverride: allowance.postExhaustionPricingPackageId,
    database,
  });
  const consumedAmount = await getConsumedAmount(database, allowance.id);
  const remainingBefore = Math.max(0, round2(parseFloat(allowance.initialAmount) - consumedAmount));
  let remaining = remainingBefore;
  const valuationDiscount = parseFloat(allowance.valuationDiscountPercent);
  const pricedItems: AllowancePricingLine[] = [];

  for (const item of basePricing.items) {
    const listUnitPrice = parseFloat(item.unitPriceBase);
    // Il consumo segue la formula contrattuale su listino × quantità e viene
    // arrotondato solo sul totale riga, mai su ciascuna confezione.
    const consumptionPerUnit = listUnitPrice * (1 - valuationDiscount / 100);
    // La quantità ordine è intera: il plafond copre solo confezioni intere.
    // Un eventuale residuo inferiore al consumo di una confezione resta visibile.
    const coveredQuantity = consumptionPerUnit > 0
      ? Math.min(item.quantity, Math.floor((remaining + 0.000001) / consumptionPerUnit))
      : 0;

    if (coveredQuantity > 0) {
      const consumptionAmount = round2(consumptionPerUnit * coveredQuantity);
      remaining = Math.max(0, round2(remaining - consumptionAmount));
      pricedItems.push({
        ...item,
        quantity: coveredQuantity,
        discountPercent: "100.00",
        unitPriceFinal: "0.00",
        lineTotalNet: "0.00",
        lineTotalGross: "0.00",
        allowanceCovered: true,
        allowanceConsumptionAmount: money(consumptionAmount),
      });
    }

    const paidQuantity = item.quantity - coveredQuantity;
    if (paidQuantity > 0) {
      const lineTotalNet = round2(parseFloat(item.unitPriceFinal) * paidQuantity);
      const lineTotalGross = round2(lineTotalNet * (1 + parseFloat(item.vatRate) / 100));
      pricedItems.push({
        ...item,
        quantity: paidQuantity,
        lineTotalNet: money(lineTotalNet),
        lineTotalGross: money(lineTotalGross),
        allowanceCovered: false,
        allowanceConsumptionAmount: null,
      });
    }
  }

  const result = recalculateResult(basePricing, pricedItems);
  result.allowance = {
    id: allowance.id,
    initialAmount: allowance.initialAmount,
    consumedAmount: money(consumedAmount),
    remainingBefore: money(remainingBefore),
    remainingAfter: money(remaining),
    valuationDiscountPercent: allowance.valuationDiscountPercent,
    postExhaustionPackageName: allowance.postExhaustionPackageName,
  };
  return result;
}

/** Registra nel ledger le sole quote gratuite appena scritte sull'ordine. */
export async function persistAllowanceConsumptions(
  database: Database,
  input: {
    orderId: string;
    createdBy: string;
    pricing: AllowancePricingResult;
  },
) {
  if (!input.pricing.allowance) return;

  // Le righe possono essere ulteriormente spezzate dal FEFO; si leggono dopo
  // l'INSERT per collegare ogni consumo alla riga reale, non a una bozza.
  const coveredRows = await database
    .select({
      id: orderItems.id,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
      unitPriceBase: orderItems.unitPriceBase,
    })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, input.orderId),
        eq(orderItems.unitPriceFinal, "0"),
      ),
    );

  const valuationDiscount = parseFloat(input.pricing.allowance.valuationDiscountPercent);
  const rows = coveredRows.map((item) => {
    const consumptionAmount = round2(
      parseFloat(item.unitPriceBase) * item.quantity * (1 - valuationDiscount / 100),
    );
    return {
      allowanceId: input.pricing.allowance!.id,
      orderId: input.orderId,
      orderItemId: item.id,
      entryType: "consumption",
      reversesConsumptionId: null,
      coveredQuantity: item.quantity.toFixed(6),
      listUnitPriceSnapshot: item.unitPriceBase,
      valuationDiscountPercentSnapshot: input.pricing.allowance!.valuationDiscountPercent,
      consumptionAmount: money(consumptionAmount),
      createdBy: input.createdBy,
      reversalReason: null,
    };
  });

  if (rows.length > 0) await database.insert(retailerAllowanceConsumptions).values(rows);
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
      entryType: "reversal",
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

/** Restituisce il riepilogo adatto a card admin e portale retailer. */
export async function getRetailerAllowanceSummary(
  database: Database,
  retailerId: string,
  companyId: string,
) {
  const [allowance] = await getActiveAllowance(database, retailerId, companyId);
  if (!allowance) return null;
  return formatAllowanceSummary(database, { ...allowance, status: "active" });
}

/** Riepiloghi attivi per la lista rivenditori della company. */
export async function getCompanyAllowanceSummaries(database: Database, companyId: string) {
  const allowances = await database
    .select({ retailerId: retailerAllowances.retailerId })
    .from(retailerAllowances)
    .where(
      and(
        eq(retailerAllowances.billingCompanyId, companyId),
        eq(retailerAllowances.status, "active"),
      ),
    );
  return Promise.all(
    allowances.map(async ({ retailerId }) => ({
      retailerId,
      ...(await getRetailerAllowanceSummary(database, retailerId, companyId))!,
    })),
  );
}

/** Storico consumi per la scheda amministrativa; i reversal restano visibili. */
export async function getRetailerAllowanceLedger(
  database: Database,
  retailerId: string,
  companyId: string,
) {
  const [allowance] = await getLatestAllowance(database, retailerId, companyId);
  if (!allowance) return { allowance: null, entries: [] };
  const entries = await database
    .select({
      id: retailerAllowanceConsumptions.id,
      entryType: retailerAllowanceConsumptions.entryType,
      coveredQuantity: retailerAllowanceConsumptions.coveredQuantity,
      consumptionAmount: retailerAllowanceConsumptions.consumptionAmount,
      createdAt: retailerAllowanceConsumptions.createdAt,
      reversalReason: retailerAllowanceConsumptions.reversalReason,
      orderId: retailerAllowanceConsumptions.orderId,
    })
    .from(retailerAllowanceConsumptions)
    .where(eq(retailerAllowanceConsumptions.allowanceId, allowance.id));
  return { allowance: await formatAllowanceSummary(database, allowance), entries };
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
