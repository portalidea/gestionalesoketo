import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  orderItems,
  orderPromotionBonuses,
  orderServiceLines,
  orders,
  pricingPackages,
  prospectOrderCommercialTerms,
  prospectSimulationItems,
  prospectSimulations,
  retailers,
} from "../../drizzle/schema";
import { calculateOrderPricing, type PricingResult } from "../pricing";
import { normalizeVatNumber } from "./prospectInvitationService";

type Database = any;

const ALLOWED_PACKAGE_NAMES = new Set(["Starter", "Partner", "Premium", "Elite"]);

function exactTierPackageName(tierCode: string): string {
  const candidate = tierCode.trim().toLowerCase();
  const names: Record<string, string> = {
    starter: "Starter",
    partner: "Partner",
    premium: "Premium",
    elite: "Elite",
  };
  const name = names[candidate];
  if (!name || !ALLOWED_PACKAGE_NAMES.has(name)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Fascia prospect non convertibile: "${tierCode}". È richiesto Starter, Partner, Premium o Elite.` });
  }
  return name;
}

async function getSimulation(database: Database, companyId: string, simulationId: string) {
  const [simulation] = await database.select().from(prospectSimulations)
    .where(and(eq(prospectSimulations.id, simulationId), eq(prospectSimulations.companyId, companyId)))
    .limit(1);
  if (!simulation) throw new TRPCError({ code: "NOT_FOUND", message: "Richiesta prospect non trovata" });
  const items = await database.select().from(prospectSimulationItems)
    .where(eq(prospectSimulationItems.simulationId, simulation.id))
    .orderBy(prospectSimulationItems.sortOrder);
  if (items.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "La richiesta non contiene righe ordine" });
  const [commercialTerms] = await database.select().from(prospectOrderCommercialTerms)
    .where(and(
      eq(prospectOrderCommercialTerms.simulationId, simulation.id),
      eq(prospectOrderCommercialTerms.companyId, companyId),
    ))
    .limit(1);
  return { simulation, items, commercialTerms: commercialTerms ?? null };
}

type FrozenCommercialItem = {
  productId: string;
  productSku: string;
  productName: string;
  quantity: number;
  unitPriceBase: string;
  discountPercent: string;
  unitPriceFinal: string;
  vatRate: string;
  lineTotalNet: string;
  lineTotalGross: string;
};

function frozenItems(snapshot: unknown): FrozenCommercialItem[] {
  const parsed = z.array(z.object({
    // PostgreSQL accetta UUID sintatticamente validi anche se non rispettano la
    // variante RFC stretta di z.uuid(); i dati provengono dallo snapshot server-side.
    productId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    productSku: z.string().min(1),
    productName: z.string().min(1),
    quantity: z.number().int().positive(),
    unitPriceBase: z.string(),
    discountPercent: z.string(),
    unitPriceFinal: z.string(),
    vatRate: z.string(),
    lineTotalNet: z.string(),
    lineTotalGross: z.string(),
  })).min(1).safeParse(snapshot);
  if (!parsed.success) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Termini commerciali prospect non validi" });
  return parsed.data;
}

const frozenMoney = z.string().regex(/^\d+(?:\.\d{1,2})?$/);

type FrozenServicePackage = {
  serviceCode: string;
  serviceName: string;
  unitPriceNet: string;
  vatRate: string;
  lineTotalNet: string;
  lineTotalGross: string;
  totals: {
    subtotalNet: string;
    shippingNet: string;
    shippingVatRate: string | null;
    shippingVatAmount: string;
    freeShippingApplied: boolean;
    vatAmount: string;
    totalGross: string;
  };
  bonus: { amount: string; paymentDeadline: string } | null;
};

/** Gli importi commerciali sono espressi in centesimi per ricomporre gli
 * header senza introdurre un ricalcolo o arrotondamenti del listino corrente. */
function snapshotCents(value: unknown, field: string, positive = false): number {
  const parsed = frozenMoney.safeParse(value);
  if (!parsed.success) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Termini commerciali prospect non validi: ${field}` });
  const [integer, decimal = ""] = parsed.data.split(".");
  const cents = Number(integer) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || (positive ? cents <= 0 : cents < 0)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Termini commerciali prospect non validi: ${field}` });
  }
  return cents;
}

function snapshotMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Valida e materializza esclusivamente il contratto service_package già
 * congelato. La riga servizio resta separata dalla merce e non passa mai da
 * orderItems, FEFO, lotti, stock o trasferimenti.
 */
function frozenServicePackage(terms: NonNullable<Awaited<ReturnType<typeof getSimulation>>["commercialTerms"]>): FrozenServicePackage | null {
  if (terms.ruleType !== "service_package") return null;
  const service = z.object({
    serviceCode: z.string().trim().min(1).max(100),
    serviceName: z.string().trim().min(1),
    unitPriceNet: frozenMoney,
    vatRate: frozenMoney,
    lineTotalNet: frozenMoney,
    lineTotalGross: frozenMoney,
  }).strict().safeParse(terms.serviceLineSnapshot);
  if (!service.success) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Riga servizio delle condizioni prospect non valida" });

  const unitNet = snapshotCents(service.data.unitPriceNet, "prezzo unitario servizio", true);
  const serviceNet = snapshotCents(service.data.lineTotalNet, "netto servizio", true);
  const serviceGross = snapshotCents(service.data.lineTotalGross, "lordo servizio", true);
  const serviceVatRate = snapshotCents(service.data.vatRate, "IVA servizio", true);
  const termsServiceNet = snapshotCents(terms.serviceNet, "netto servizio termini", true);
  const termsServiceVatRate = terms.serviceVatRate == null ? null : snapshotCents(terms.serviceVatRate, "IVA servizio termini", true);
  const termsServiceVat = snapshotCents(terms.serviceVatAmount, "IVA servizio termini");
  const expectedServiceVat = Math.round(serviceNet * serviceVatRate / 10_000);
  if (
    unitNet !== serviceNet ||
    ![400, 500, 1000, 2200].includes(serviceVatRate) ||
    termsServiceNet !== serviceNet ||
    termsServiceVatRate !== serviceVatRate ||
    termsServiceVat !== expectedServiceVat ||
    serviceGross !== serviceNet + expectedServiceVat
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Riga servizio prospect non coerente con le condizioni congelate" });
  }

  const bonus = terms.bonusSnapshot == null ? null : z.object({
    amount: frozenMoney,
    paymentDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict().safeParse(terms.bonusSnapshot);
  if (bonus && !bonus.success) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Bonus delle condizioni prospect non valido" });
  if (bonus) {
    const deadline = new Date(`${bonus.data.paymentDeadline}T00:00:00.000Z`);
    if (deadline.toISOString().slice(0, 10) !== bonus.data.paymentDeadline) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Scadenza bonus prospect non valida" });
    }
  }

  const merchandiseNet = snapshotCents(terms.merchandiseNet, "netto merce");
  const shippingNet = snapshotCents(terms.shippingNet, "spedizione");
  // vatAmount dei termini è il totale IVA dell'ordine (merce, servizio e
  // spedizione); shippingVatAmount è il suo dettaglio, non un importo da
  // sommare una seconda volta.
  const vatAmount = snapshotCents(terms.vatAmount, "IVA totale");
  const shippingVat = snapshotCents(terms.shippingVatAmount, "IVA spedizione");
  if (shippingVat > vatAmount) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "IVA spedizione prospect non coerente con le condizioni congelate" });
  }
  const totalGross = merchandiseNet + serviceNet + shippingNet + vatAmount;
  if (snapshotCents(terms.totalGross, "totale lordo") !== totalGross) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Totali congelati prospect incoerenti" });
  }

  return {
    serviceCode: service.data.serviceCode,
    serviceName: service.data.serviceName,
    unitPriceNet: snapshotMoney(unitNet),
    vatRate: snapshotMoney(serviceVatRate),
    lineTotalNet: snapshotMoney(serviceNet),
    lineTotalGross: snapshotMoney(serviceGross),
    totals: {
      subtotalNet: snapshotMoney(merchandiseNet + serviceNet),
      shippingNet: snapshotMoney(shippingNet),
      shippingVatRate: terms.shippingVatRate,
      shippingVatAmount: snapshotMoney(shippingVat),
      freeShippingApplied: terms.freeShippingApplied,
      vatAmount: snapshotMoney(vatAmount),
      totalGross: snapshotMoney(totalGross),
    },
    bonus: bonus ? {
      amount: snapshotMoney(snapshotCents(bonus.data.amount, "importo bonus", true)),
      paymentDeadline: bonus.data.paymentDeadline,
    } : null,
  };
}

function retailerPackageTierCode(
  simulation: Awaited<ReturnType<typeof getSimulation>>["simulation"],
  commercialTerms: Awaited<ReturnType<typeof getSimulation>>["commercialTerms"],
): string {
  if (!commercialTerms) return simulation.reachedTierCode;
  // Il service package assegna il package configurato; il tier upgrade conserva
  // invece la fascia reale per gli ordini successivi al primo.
  return commercialTerms.ruleType === "service_package"
    ? commercialTerms.pricingTierCode
    : commercialTerms.realTierCode;
}

function pricingFromCommercialTerms(terms: NonNullable<Awaited<ReturnType<typeof getSimulation>>["commercialTerms"]>): PricingResult {
  const items = frozenItems(terms.pricedItemsSnapshot).map((item) => ({
    ...item,
    piecesPerUnit: 1,
    stockAvailableConfezioni: 0,
    stockWarning: false,
    pricingModel: "tier_discount" as const,
  }));
  return {
    discountPercent: items[0]?.discountPercent ?? "0.00",
    packageName: terms.pricingTierCode,
    items,
    subtotalNet: terms.merchandiseNet,
    vatAmount: terms.vatAmount,
    totalGross: terms.totalGross,
    warnings: [],
    pricingModel: "tier_discount",
  };
}

async function resolveExistingRetailer(database: Database, companyId: string, vatNumber: string) {
  return (await database.select({
    id: retailers.id,
    name: retailers.name,
    vatNumber: retailers.vatNumber,
    pricingPackageId: retailers.pricingPackageId,
    paymentTerms: retailers.paymentTerms,
  }).from(retailers).where(and(eq(retailers.companyId, companyId), eq(retailers.vatNumber, vatNumber))).limit(1))[0] ?? null;
}

async function hasExistingRetailerOrder(database: Database, retailerId: string) {
  const [row] = await database.select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.retailerId, retailerId));
  return (row?.count ?? 0) > 0;
}

async function resolveProspectPricingPackage(database: Database, tierCode: string) {
  const requiredName = exactTierPackageName(tierCode);
  const matching = await database.select({ id: pricingPackages.id, name: pricingPackages.name, discountPercent: pricingPackages.discountPercent })
    .from(pricingPackages).where(eq(pricingPackages.name, requiredName)).limit(2);
  if (matching.length !== 1 || matching[0]?.name !== requiredName || !ALLOWED_PACKAGE_NAMES.has(matching[0].name)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Pricing package "${requiredName}" non risolto in modo univoco; conversione bloccata.` });
  }
  return matching[0];
}

export type ProspectConversionPreview = {
  simulation: Awaited<ReturnType<typeof getSimulation>>["simulation"];
  items: Awaited<ReturnType<typeof getSimulation>>["items"];
  proposedPackage: { id: string; name: string; discountPercent: string };
  existingRetailer: Awaited<ReturnType<typeof resolveExistingRetailer>>;
  requiresExistingRetailerConfirmation: boolean;
  pricing: PricingResult;
  minimumOrderNet: string;
  meetsMinimumOrder: boolean;
  simulationTierNet: string;
  pricingDifferenceNet: string;
  usesFrozenCommercialTerms: boolean;
  pricingTierCode: string;
  minimumOrderOverrideAllowed: boolean;
  servicePackage: FrozenServicePackage | null;
  promotionFirstOrderEligible: boolean;
};

export async function previewProspectConversion(database: Database, companyId: string, simulationId: string): Promise<ProspectConversionPreview> {
  const { simulation, items, commercialTerms } = await getSimulation(database, companyId, simulationId);
  if (simulation.status === "converted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Questa richiesta è già stata convertita" });
  const normalizedVat = normalizeVatNumber(simulation.vatNumber);
  const [existingRetailer, proposedPackage] = await Promise.all([
    resolveExistingRetailer(database, companyId, normalizedVat),
    resolveProspectPricingPackage(database, retailerPackageTierCode(simulation, commercialTerms)),
  ]);
  const promotionFirstOrderEligible = !commercialTerms || !existingRetailer
    ? true
    : !(await hasExistingRetailerOrder(database, existingRetailer.id));
  const standardPricing = await calculateOrderPricing({
    retailerId: existingRetailer?.id,
    pricingPackageIdOverride: existingRetailer ? undefined : proposedPackage.id,
    companyId,
    items: items.map((item: { productId: string; quantity: number }) => ({ productId: item.productId, quantity: item.quantity })),
    database,
  });
  const pricing = commercialTerms ? pricingFromCommercialTerms(commercialTerms) : standardPricing;
  const servicePackage = commercialTerms ? frozenServicePackage(commercialTerms) : null;
  const snapshot = simulation.calculationSnapshot as {
    minimumOrderNet?: string;
    currentTierMerchandiseNet?: string;
    appliedServicePackage?: { minimumMerchandiseNet?: string } | null;
  };
  const packageMinimum = commercialTerms?.ruleType === "service_package"
    ? Number(snapshot?.appliedServicePackage?.minimumMerchandiseNet ?? 0)
    : 0;
  const minimumOrderNet = Math.max(Number(snapshot?.minimumOrderNet ?? 290), packageMinimum).toFixed(2);
  const meetsMinimumOrder = Number(pricing.subtotalNet) >= Number(minimumOrderNet);
  const simulationTierNet = commercialTerms?.merchandiseNet ?? snapshot?.currentTierMerchandiseNet ?? "0.00";
  return {
    simulation, items, proposedPackage, existingRetailer,
    requiresExistingRetailerConfirmation: Boolean(existingRetailer),
    pricing, minimumOrderNet, meetsMinimumOrder, simulationTierNet,
    pricingDifferenceNet: (Number(standardPricing.subtotalNet) - Number(simulationTierNet)).toFixed(2),
    usesFrozenCommercialTerms: Boolean(commercialTerms),
    pricingTierCode: commercialTerms?.pricingTierCode ?? simulation.reachedTierCode,
    minimumOrderOverrideAllowed: commercialTerms?.ruleType !== "service_package",
    servicePackage,
    promotionFirstOrderEligible,
  };
}

/**
 * Converte una sola richiesta in retailer/location/ordine. Advisory lock e flag converted
 * impediscono duplicazione anche su doppio click o retry dopo timeout client.
 */
export async function convertProspectSimulation(
  database: Database,
  input: { companyId: string; simulationId: string; actorId: string; useExistingRetailer: boolean; minimumOrderOverrideReason?: string },
) {
  return database.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.simulationId}))`);
    const { simulation, items, commercialTerms } = await getSimulation(tx, input.companyId, input.simulationId);
    if (simulation.status === "converted" && simulation.convertedOrderId && simulation.convertedRetailerId) {
      return { alreadyConverted: true as const, retailerId: simulation.convertedRetailerId, orderId: simulation.convertedOrderId };
    }
    if (simulation.status === "converted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Richiesta convertita in modo incompleto: richiede verifica amministrativa" });
    const normalizedVat = normalizeVatNumber(simulation.vatNumber);
    const existingRetailer = await resolveExistingRetailer(tx, input.companyId, normalizedVat);
    if (existingRetailer && !input.useExistingRetailer) {
      throw new TRPCError({ code: "CONFLICT", message: `Esiste già il retailer "${existingRetailer.name}" con la stessa P.IVA. Conferma il collegamento prima di proseguire.` });
    }
    if (commercialTerms && existingRetailer && await hasExistingRetailerOrder(tx, existingRetailer.id)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "La promozione prospect è applicabile solo al primo ordine del retailer. Questa anagrafica ha già ordini registrati.",
      });
    }
    const proposedPackage = !existingRetailer || commercialTerms?.ruleType === "service_package"
      ? await resolveProspectPricingPackage(tx, retailerPackageTierCode(simulation, commercialTerms))
      : null;
    const pricing = commercialTerms
      ? pricingFromCommercialTerms(commercialTerms)
      : await calculateOrderPricing({
        retailerId: existingRetailer?.id,
        pricingPackageIdOverride: existingRetailer ? undefined : proposedPackage!.id,
        companyId: input.companyId,
        items: items.map((item: { productId: string; quantity: number }) => ({ productId: item.productId, quantity: item.quantity })),
        database: tx as any,
      });
    const servicePackage = commercialTerms ? frozenServicePackage(commercialTerms) : null;
    const snapshot = simulation.calculationSnapshot as {
      minimumOrderNet?: string;
      appliedServicePackage?: { minimumMerchandiseNet?: string } | null;
    };
    const packageMinimum = commercialTerms?.ruleType === "service_package"
      ? Number(snapshot?.appliedServicePackage?.minimumMerchandiseNet ?? 0)
      : 0;
    const minimumOrderNet = Math.max(Number(snapshot?.minimumOrderNet ?? 290), packageMinimum);
    const isBelowMinimumOrder = Number(pricing.subtotalNet) < minimumOrderNet;
    const minimumOrderOverrideReason = input.minimumOrderOverrideReason?.trim();
    if (commercialTerms?.ruleType === "service_package" && isBelowMinimumOrder) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Pacchetto non approvabile: netto merce € ${pricing.subtotalNet}, minimo prodotti richiesto € ${minimumOrderNet.toFixed(2)}.`,
      });
    }
    if (isBelowMinimumOrder && !minimumOrderOverrideReason) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Ordine non approvabile: netto merce € ${pricing.subtotalNet}, minimo richiesto € ${minimumOrderNet.toFixed(2)}.` });
    }

    let retailer = existingRetailer;
    if (!retailer) {
      const [createdRetailer] = await tx.insert(retailers).values({
        name: simulation.legalName,
        businessType: simulation.businessType,
        address: simulation.address,
        city: simulation.city,
        province: simulation.province,
        postalCode: simulation.postalCode,
        phone: simulation.phone,
        email: simulation.email,
        contactPerson: simulation.contactName,
        vatNumber: normalizedVat,
        notes: simulation.notes,
        pricingPackageId: proposedPackage!.id,
        companyId: input.companyId,
      }).returning({ id: retailers.id, name: retailers.name, vatNumber: retailers.vatNumber, pricingPackageId: retailers.pricingPackageId, paymentTerms: retailers.paymentTerms });
      retailer = createdRetailer;
      await tx.insert(locations).values({ type: "retailer", name: createdRetailer.name, retailerId: createdRetailer.id, companyId: input.companyId });
    } else if (commercialTerms?.ruleType === "service_package" && retailer.pricingPackageId !== proposedPackage!.id) {
      await tx.update(retailers).set({ pricingPackageId: proposedPackage!.id, updatedAt: new Date() })
        .where(and(eq(retailers.id, retailer.id), eq(retailers.companyId, input.companyId)));
      retailer = { ...retailer, pricingPackageId: proposedPackage!.id };
    }

    const [order] = await tx.insert(orders).values({
      retailerId: retailer.id,
      status: "pending",
      paymentTerms: retailer.paymentTerms,
      subtotalNet: servicePackage?.totals.subtotalNet ?? pricing.subtotalNet,
      shippingNet: servicePackage?.totals.shippingNet ?? commercialTerms?.shippingNet ?? "0.00",
      shippingVatRate: servicePackage?.totals.shippingVatRate ?? commercialTerms?.shippingVatRate ?? null,
      shippingVatAmount: servicePackage?.totals.shippingVatAmount ?? commercialTerms?.shippingVatAmount ?? "0.00",
      freeShippingApplied: servicePackage?.totals.freeShippingApplied ?? commercialTerms?.freeShippingApplied ?? false,
      vatAmount: servicePackage?.totals.vatAmount ?? pricing.vatAmount,
      totalGross: servicePackage?.totals.totalGross ?? pricing.totalGross,
      discountPercent: pricing.discountPercent,
      notes: simulation.notes,
      notesInternal: `Creato dalla richiesta prospect ${simulation.id}`,
      createdBy: input.actorId,
      companyId: input.companyId,
      prospectCommercialTermsId: commercialTerms?.id ?? null,
    }).returning();
    await tx.insert(orderItems).values(pricing.items.map((item) => ({
      orderId: order.id,
      productId: item.productId,
      batchId: null,
      quantity: item.quantity,
      unitPriceBase: item.unitPriceBase,
      discountPercent: item.discountPercent,
      unitPriceFinal: item.unitPriceFinal,
      vatRate: item.vatRate,
      lineTotalNet: item.lineTotalNet,
      lineTotalGross: item.lineTotalGross,
      productSku: item.productSku,
      productName: item.productName,
    })));
    if (servicePackage) {
      await tx.insert(orderServiceLines).values({
        orderId: order.id,
        companyId: input.companyId,
        sourcePromotionId: commercialTerms!.promotionId,
        serviceCode: servicePackage.serviceCode,
        serviceName: servicePackage.serviceName,
        quantity: "1.000",
        unitPriceNet: servicePackage.unitPriceNet,
        vatRate: servicePackage.vatRate,
        lineTotalNet: servicePackage.lineTotalNet,
        lineTotalGross: servicePackage.lineTotalGross,
      });
      if (servicePackage.bonus) {
        await tx.insert(orderPromotionBonuses).values({
          orderId: order.id,
          retailerId: retailer.id,
          companyId: input.companyId,
          promotionId: commercialTerms!.promotionId,
          bonusAmount: servicePackage.bonus.amount,
          valuationDiscountPercent: "0.00",
          paymentDeadline: servicePackage.bonus.paymentDeadline,
          status: "pending",
          createdBy: input.actorId,
          updatedBy: input.actorId,
        });
      }
    }
    await tx.update(prospectSimulations).set({
      status: "converted", convertedRetailerId: retailer.id, convertedOrderId: order.id,
      convertedAt: new Date(), convertedBy: input.actorId,
      minimumOrderOverrideApplied: isBelowMinimumOrder,
      minimumOrderOverrideReason: isBelowMinimumOrder ? minimumOrderOverrideReason! : null,
      minimumOrderOverriddenBy: isBelowMinimumOrder ? input.actorId : null,
      minimumOrderOverriddenAt: isBelowMinimumOrder ? new Date() : null,
    }).where(eq(prospectSimulations.id, simulation.id));
    return { alreadyConverted: false as const, retailerId: retailer.id, orderId: order.id, orderNumber: order.orderNumber, pricing };
  });
}
