/**
 * M6.2.B — FiC Document Lifecycle Service
 *
 * Pure service layer (no tRPC). Handles:
 * - createProforma: issued_documents type=proforma
 * - modifyProforma: PUT issued_documents/{id}
 * - transformProformaToInvoice: GET transform + POST (keep_copy=1)
 * - deleteProforma: DELETE issued_documents/{id} (bin, recoverable 30d)
 *
 * Uses existing fic-integration.ts for token management and API base.
 */
import axios from "axios";
import {
  getValidFicAccessToken,
  getFicVatTypes,
  getFicPaymentMethods,
  getFicClientById,
} from "../fic-integration";

const FIC_API_BASE = "https://api-v2.fattureincloud.it";

// --- Helpers ---

function findVatTypeId(vatTypes: any[], rate: number): number {
  const match = vatTypes.find((v: any) => Math.abs(v.value - rate) < 0.01);
  return match?.id ?? vatTypes[0]?.id ?? 0;
}

function findPaymentMethodId(methods: any[], name: string): number {
  const match = methods.find(
    (m: any) => m.name?.toLowerCase().includes(name.toLowerCase()),
  );
  return match?.id ?? methods[0]?.id ?? 0;
}

function formatDateIT(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString("it-IT");
  } catch {
    return isoDate;
  }
}

// --- Interfaces ---

export interface FicProformaItem {
  productName: string;
  quantity: number;
  unitPrice: number; // already discounted for retailer package
  vatRate: number; // 10 or 22
  batchNumber?: string;
  expiryDate?: string; // ISO date
  sku?: string;
}

export interface CreateProformaInput {
  orderId: string;
  orderNumber: string;
  retailerFicClientId: number;
  items: FicProformaItem[];
  paymentTerms: "advance_transfer" | "on_delivery" | "credit_card" | "manual";
  totalGross?: number;
  notes?: string;
}

export interface CreateProformaResult {
  ficDocumentId: number;
  ficNumber: string;
}

export interface TransformResult {
  ficInvoiceId: number;
  ficInvoiceNumber: string;
}

// --- Service methods ---

/**
 * Create a proforma on FiC for a given order.
 */
export async function createProforma(
  input: CreateProformaInput,
): Promise<CreateProformaResult> {
  const t0 = Date.now();
  console.log(`[ficDocService.createProforma] start orderId=${input.orderId}`);

  const { accessToken, companyId } = await getValidFicAccessToken();
  const [vatTypes, paymentMethods] = await Promise.all([
    getFicVatTypes(),
    getFicPaymentMethods(),
  ]);

  // Payment method label
  const paymentLabel =
    input.paymentTerms === "advance_transfer"
      ? "Bonifico bancario anticipato"
      : input.paymentTerms === "on_delivery"
        ? "Pagamento alla consegna"
        : input.paymentTerms === "credit_card"
          ? "Carta di credito"
          : "Manuale";

  const paymentMethodId = findPaymentMethodId(paymentMethods, paymentLabel);

  // Build items_list
  const items_list = input.items.map((item) => {
    const vatId = findVatTypeId(vatTypes, item.vatRate);
    const descParts: string[] = [];
    if (item.batchNumber) descParts.push(`Lotto: ${item.batchNumber}`);
    if (item.expiryDate) descParts.push(`Scad: ${formatDateIT(item.expiryDate)}`);

    return {
      product_id: 0,
      ...(item.sku ? { code: item.sku } : {}),
      name: item.productName, // bold on FiC PDF
      description: descParts.join(" | "), // normal text below
      qty: item.quantity,
      net_price: item.unitPrice,
      vat: { id: vatId },
      not_taxable: false,
    };
  });

  // Calculate totalGross if not provided
  const totalGross =
    input.totalGross ??
    input.items.reduce(
      (sum, it) => sum + it.unitPrice * it.quantity * (1 + it.vatRate / 100),
      0,
    );

  // Fetch entity from FiC
  const ficEntity = await getFicClientById(input.retailerFicClientId);

  const body = {
    data: {
      type: "proforma",
      entity: ficEntity,
      date: new Date().toISOString().slice(0, 10),
      currency: { id: "EUR" },
      payment_method: { id: paymentMethodId },
      subject: `Ordine ${input.orderNumber}`,
      visible_subject: `Ordine ${input.orderNumber}`,
      items_list,
      payments_list: [
        {
          amount: Math.round(totalGross * 100) / 100,
          due_date: new Date().toISOString().slice(0, 10),
          status: "not_paid" as const,
        },
      ],
      notes: input.notes ?? "",
    },
  };

  try {
    const r = await axios.post<{ data: { id: number; number: string } }>(
      `${FIC_API_BASE}/c/${companyId}/issued_documents`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 7000, // respect 8s middleware
      },
    );

    const out = r.data?.data;
    if (!out?.id) throw new Error("FiC non ha restituito proforma id");

    console.log(
      `[ficDocService.createProforma] DONE id=${out.id} number=${out.number} (${Date.now() - t0}ms)`,
    );
    return { ficDocumentId: out.id, ficNumber: out.number?.toString() ?? `${out.id}` };
  } catch (e: any) {
    const status = e?.response?.status;
    const msg = extractFicError(e);
    console.error(`[ficDocService.createProforma] ERROR (${status}): ${msg}`);
    throw new Error(`FiC createProforma (${status ?? "??"}): ${msg}`);
  }
}

/**
 * Modify an existing proforma on FiC (PUT).
 * Used when admin modifies order items after payment confirmation.
 */
export async function modifyProforma(
  ficDocumentId: number,
  input: CreateProformaInput,
): Promise<void> {
  const t0 = Date.now();
  console.log(
    `[ficDocService.modifyProforma] start ficDocId=${ficDocumentId} orderId=${input.orderId}`,
  );

  const { accessToken, companyId } = await getValidFicAccessToken();
  const [vatTypes, paymentMethods] = await Promise.all([
    getFicVatTypes(),
    getFicPaymentMethods(),
  ]);

  const paymentLabel =
    input.paymentTerms === "advance_transfer"
      ? "Bonifico bancario anticipato"
      : input.paymentTerms === "on_delivery"
        ? "Pagamento alla consegna"
        : input.paymentTerms === "credit_card"
          ? "Carta di credito"
          : "Manuale";

  const paymentMethodId = findPaymentMethodId(paymentMethods, paymentLabel);

  const items_list = input.items.map((item) => {
    const vatId = findVatTypeId(vatTypes, item.vatRate);
    const descParts: string[] = [];
    if (item.batchNumber) descParts.push(`Lotto: ${item.batchNumber}`);
    if (item.expiryDate) descParts.push(`Scad: ${formatDateIT(item.expiryDate)}`);

    return {
      product_id: 0,
      ...(item.sku ? { code: item.sku } : {}),
      name: item.productName,
      description: descParts.join(" | "),
      qty: item.quantity,
      net_price: item.unitPrice,
      vat: { id: vatId },
      not_taxable: false,
    };
  });

  const totalGross =
    input.totalGross ??
    input.items.reduce(
      (sum, it) => sum + it.unitPrice * it.quantity * (1 + it.vatRate / 100),
      0,
    );

  const ficEntity = await getFicClientById(input.retailerFicClientId);

  const body = {
    data: {
      type: "proforma",
      entity: ficEntity,
      date: new Date().toISOString().slice(0, 10),
      currency: { id: "EUR" },
      payment_method: { id: paymentMethodId },
      subject: `Ordine ${input.orderNumber}`,
      visible_subject: `Ordine ${input.orderNumber}`,
      items_list,
      payments_list: [
        {
          amount: Math.round(totalGross * 100) / 100,
          due_date: new Date().toISOString().slice(0, 10),
          status: "not_paid" as const,
        },
      ],
      notes: input.notes ?? "",
    },
  };

  try {
    await axios.put(
      `${FIC_API_BASE}/c/${companyId}/issued_documents/${ficDocumentId}`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 7000,
      },
    );
    console.log(
      `[ficDocService.modifyProforma] DONE ficDocId=${ficDocumentId} (${Date.now() - t0}ms)`,
    );
  } catch (e: any) {
    const status = e?.response?.status;
    const msg = extractFicError(e);
    console.error(`[ficDocService.modifyProforma] ERROR (${status}): ${msg}`);
    throw new Error(`FiC modifyProforma (${status ?? "??"}): ${msg}`);
  }
}

/**
 * Transform proforma → invoice (with keep_copy=1).
 * Two-step: GET /transform → POST /issued_documents with returned body.
 */
export async function transformProformaToInvoice(
  ficProformaId: number,
): Promise<TransformResult> {
  const t0 = Date.now();
  console.log(
    `[ficDocService.transformToInvoice] start proformaId=${ficProformaId}`,
  );

  const { accessToken, companyId } = await getValidFicAccessToken();

  try {
    // Step 1: GET transform preview
    const transformResp = await axios.get(
      `${FIC_API_BASE}/c/${companyId}/issued_documents/transform`,
      {
        params: {
          original_document_id: ficProformaId,
          new_type: "invoice",
          transform_keep_copy: 1,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 7000,
      },
    );

    // Step 2: POST the returned body as-is to create the invoice
    const createResp = await axios.post<{ data: { id: number; number: string } }>(
      `${FIC_API_BASE}/c/${companyId}/issued_documents`,
      transformResp.data, // includes data + options exactly as returned
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 7000,
      },
    );

    const invoice = createResp.data?.data;
    if (!invoice?.id) throw new Error("FiC non ha restituito invoice id");

    console.log(
      `[ficDocService.transformToInvoice] DONE invoiceId=${invoice.id} number=${invoice.number} (${Date.now() - t0}ms)`,
    );
    return {
      ficInvoiceId: invoice.id,
      ficInvoiceNumber: invoice.number?.toString() ?? `${invoice.id}`,
    };
  } catch (e: any) {
    const status = e?.response?.status;
    const msg = extractFicError(e);
    console.error(`[ficDocService.transformToInvoice] ERROR (${status}): ${msg}`);
    throw new Error(`FiC transformToInvoice (${status ?? "??"}): ${msg}`);
  }
}

/**
 * Delete a proforma (moves to FiC bin, recoverable for 30 days).
 */
export async function deleteProforma(ficDocumentId: number): Promise<void> {
  const t0 = Date.now();
  console.log(`[ficDocService.deleteProforma] start ficDocId=${ficDocumentId}`);

  const { accessToken, companyId } = await getValidFicAccessToken();

  try {
    await axios.delete(
      `${FIC_API_BASE}/c/${companyId}/issued_documents/${ficDocumentId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 7000,
      },
    );
    console.log(
      `[ficDocService.deleteProforma] DONE ficDocId=${ficDocumentId} (${Date.now() - t0}ms)`,
    );
  } catch (e: any) {
    const status = e?.response?.status;
    // 404 = already deleted, treat as success
    if (status === 404) {
      console.warn(
        `[ficDocService.deleteProforma] 404 — document already deleted, treating as success`,
      );
      return;
    }
    const msg = extractFicError(e);
    console.error(`[ficDocService.deleteProforma] ERROR (${status}): ${msg}`);
    throw new Error(`FiC deleteProforma (${status ?? "??"}): ${msg}`);
  }
}

// --- Error extraction helper ---

function extractFicError(e: any): string {
  const validationFields = e?.response?.data?.error?.validation_result?.fields;
  if (validationFields) {
    return validationFields
      .map((f: any) => `${f.field}: ${f.message}`)
      .join("; ");
  }
  return (
    e?.response?.data?.error?.message ??
    e?.response?.data?.message ??
    e?.message ??
    "errore sconosciuto"
  );
}
