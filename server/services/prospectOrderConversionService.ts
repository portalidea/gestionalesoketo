import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  orderItems,
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
};

export async function previewProspectConversion(database: Database, companyId: string, simulationId: string): Promise<ProspectConversionPreview> {
  const { simulation, items, commercialTerms } = await getSimulation(database, companyId, simulationId);
  if (simulation.status === "converted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Questa richiesta è già stata convertita" });
  const normalizedVat = normalizeVatNumber(simulation.vatNumber);
  const [existingRetailer, proposedPackage] = await Promise.all([
    resolveExistingRetailer(database, companyId, normalizedVat),
    resolveProspectPricingPackage(database, simulation.reachedTierCode),
  ]);
  const standardPricing = await calculateOrderPricing({
    retailerId: existingRetailer?.id,
    pricingPackageIdOverride: existingRetailer ? undefined : proposedPackage.id,
    companyId,
    items: items.map((item: { productId: string; quantity: number }) => ({ productId: item.productId, quantity: item.quantity })),
    database,
  });
  const pricing = commercialTerms ? pricingFromCommercialTerms(commercialTerms) : standardPricing;
  const snapshot = simulation.calculationSnapshot as { minimumOrderNet?: string; currentTierMerchandiseNet?: string };
  const minimumOrderNet = snapshot?.minimumOrderNet ?? "290.00";
  const meetsMinimumOrder = Number(pricing.subtotalNet) >= Number(minimumOrderNet);
  const simulationTierNet = commercialTerms?.merchandiseNet ?? snapshot?.currentTierMerchandiseNet ?? "0.00";
  return {
    simulation, items, proposedPackage, existingRetailer,
    requiresExistingRetailerConfirmation: Boolean(existingRetailer),
    pricing, minimumOrderNet, meetsMinimumOrder, simulationTierNet,
    pricingDifferenceNet: (Number(standardPricing.subtotalNet) - Number(simulationTierNet)).toFixed(2),
    usesFrozenCommercialTerms: Boolean(commercialTerms),
    pricingTierCode: commercialTerms?.pricingTierCode ?? simulation.reachedTierCode,
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
    const proposedPackage = existingRetailer ? null : await resolveProspectPricingPackage(tx, simulation.reachedTierCode);
    const pricing = commercialTerms
      ? pricingFromCommercialTerms(commercialTerms)
      : await calculateOrderPricing({
        retailerId: existingRetailer?.id,
        pricingPackageIdOverride: existingRetailer ? undefined : proposedPackage!.id,
        companyId: input.companyId,
        items: items.map((item: { productId: string; quantity: number }) => ({ productId: item.productId, quantity: item.quantity })),
        database: tx as any,
      });
    const snapshot = simulation.calculationSnapshot as { minimumOrderNet?: string };
    const minimumOrderNet = Number(snapshot?.minimumOrderNet ?? 290);
    const isBelowMinimumOrder = Number(pricing.subtotalNet) < minimumOrderNet;
    const minimumOrderOverrideReason = input.minimumOrderOverrideReason?.trim();
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
    }

    const [order] = await tx.insert(orders).values({
      retailerId: retailer.id,
      status: "pending",
      paymentTerms: retailer.paymentTerms,
      subtotalNet: pricing.subtotalNet,
      shippingNet: commercialTerms?.shippingNet ?? "0.00",
      shippingVatRate: commercialTerms?.shippingVatRate ?? null,
      shippingVatAmount: commercialTerms?.shippingVatAmount ?? "0.00",
      freeShippingApplied: commercialTerms?.freeShippingApplied ?? false,
      vatAmount: pricing.vatAmount,
      totalGross: pricing.totalGross,
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
