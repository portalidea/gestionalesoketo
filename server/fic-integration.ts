/**
 * M11.C — Fatture in Cloud multi-tenant integration.
 *
 * Multi-tenant: ogni company ha la propria connessione FiC salvata in
 * `ficConnections` (una riga per company). Il token viene selezionato
 * in base a ctx.activeCompanyId passato dal caller.
 *
 * Sostituisce il vecchio modello single-tenant basato su `systemIntegrations`.
 */
import axios from "axios";
import {
  exchangeCodeForTokens,
  isTokenExpired,
  refreshAccessToken,
} from "./fattureincloud-oauth";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  ficConnections,
  FicConnection,
  retailerFicMapping,
  companies,
  retailers,
} from "../drizzle/schema";

export const FIC_INTEGRATION_TYPE = "fattureincloud";
const FIC_API_BASE = "https://api-v2.fattureincloud.it";

// ─── Company → env slug mapping ────────────────────────────────────────────
const COMPANY_ENV_SLUG_MAP: Record<string, string> = {
  "00000000-0000-0000-0000-000000000001": "EKETO_FOOD",
  "00000000-0000-0000-0000-000000000002": "SOKETO_SRL",
};

export interface FicCompanyInfo {
  id: number;
  name: string;
  type?: string;
}

export interface FicClientInfo {
  id: number;
  name: string;
  vat_number?: string;
  tax_code?: string;
  email?: string;
  phone?: string;
  type?: string;
  address_street?: string;
  address_postal_code?: string;
  address_city?: string;
  address_province?: string;
  address_extra?: string;
  country?: string;
  country_iso?: string;
  contact_person?: string;
}

export interface FicVatType {
  id: number;
  value: number;
  description: string;
  is_disabled: boolean;
}

export interface FicPaymentMethod {
  id: number;
  name: string;
  type: string;
  is_default: boolean;
}

export interface FicIntegrationStatus {
  connected: boolean;
  expired: boolean;
  ficCompanyId: string | null;
  tokenExpiresAt: string | null;
  configured: boolean;
}

// ─── DB helper (internal) ──────────────────────────────────────────────────

let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    const client = postgres(url);
    _db = drizzle(client);
  }
  return _db;
}

// ─── Credentials lookup ────────────────────────────────────────────────────

export interface FicOAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Ritorna le credenziali OAuth FiC per una specifica company.
 * Legge da env vars: FATTUREINCLOUD_CLIENT_ID_<SLUG>, FATTUREINCLOUD_CLIENT_SECRET_<SLUG>
 * Fallback: FATTUREINCLOUD_CLIENT_ID / FATTUREINCLOUD_CLIENT_SECRET (legacy single-tenant)
 */
export function getFicClientCredentials(companyId: string): FicOAuthCredentials | null {
  const slug = COMPANY_ENV_SLUG_MAP[companyId];
  const redirectUri = process.env.FATTUREINCLOUD_REDIRECT_URI;
  if (!redirectUri) return null;

  // Try per-company env vars first
  if (slug) {
    const clientId = process.env[`FATTUREINCLOUD_CLIENT_ID_${slug}`];
    const clientSecret = process.env[`FATTUREINCLOUD_CLIENT_SECRET_${slug}`];
    if (clientId && clientSecret) {
      return { clientId, clientSecret, redirectUri };
    }
  }

  // Fallback to legacy single env vars
  const clientId = process.env.FATTUREINCLOUD_CLIENT_ID;
  const clientSecret = process.env.FATTUREINCLOUD_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return { clientId, clientSecret, redirectUri };
  }

  return null;
}

// ─── Connection helpers ────────────────────────────────────────────────────

/**
 * Recupera la connessione FiC per una company specifica.
 */
export async function getFicConnection(companyId: string): Promise<FicConnection | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(ficConnections)
    .where(eq(ficConnections.companyId, companyId))
    .limit(1);
  return row ?? null;
}

/**
 * Recupera la connessione FiC attiva per una company, con auto-refresh del token.
 * Throw se non connessa o se il refresh fallisce.
 */
export async function getActiveFicConnection(companyId: string): Promise<{
  accessToken: string;
  ficCompanyId: number;
}> {
  const conn = await getFicConnection(companyId);
  if (!conn || !conn.accessToken) {
    throw new FicNotConnectedError(companyId);
  }
  if (!conn.ficCompanyId) {
    throw new Error("Connessione FiC senza ficCompanyId — riconnetti l'integrazione");
  }

  const ficCompanyId = parseInt(conn.ficCompanyId, 10);

  // Check token expiry and refresh if needed
  if (conn.tokenExpiresAt && isTokenExpired(conn.tokenExpiresAt) && conn.refreshToken) {
    const creds = getFicClientCredentials(companyId);
    if (!creds) throw new FicReauthRequiredError(companyId);

    try {
      const refreshed = await refreshAccessToken(creds, conn.refreshToken);
      const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

      const db = getDb();
      await db
        .update(ficConnections)
        .set({
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          tokenExpiresAt: newExpiresAt,
          updatedAt: new Date(),
        })
        .where(eq(ficConnections.companyId, companyId));

      console.log(`[fic] Token refreshed for company ${companyId}, expires ${newExpiresAt.toISOString()}`);
      return { accessToken: refreshed.access_token, ficCompanyId };
    } catch (e) {
      console.error(`[fic] Token refresh failed for company ${companyId}:`, e);
      throw new FicReauthRequiredError(companyId);
    }
  }

  // Token expired and no refresh token
  if (conn.tokenExpiresAt && isTokenExpired(conn.tokenExpiresAt)) {
    throw new FicReauthRequiredError(companyId);
  }

  return { accessToken: conn.accessToken, ficCompanyId };
}

// ─── Status ────────────────────────────────────────────────────────────────

export async function getFicStatusForCompany(companyId: string): Promise<FicIntegrationStatus> {
  const creds = getFicClientCredentials(companyId);
  const conn = await getFicConnection(companyId);

  if (!conn || !conn.accessToken) {
    return {
      connected: false,
      expired: false,
      ficCompanyId: null,
      tokenExpiresAt: null,
      configured: !!creds,
    };
  }

  const expired = conn.tokenExpiresAt ? isTokenExpired(conn.tokenExpiresAt) : false;

  return {
    connected: true,
    expired,
    ficCompanyId: conn.ficCompanyId ?? null,
    tokenExpiresAt: conn.tokenExpiresAt?.toISOString() ?? null,
    configured: !!creds,
  };
}

/**
 * Legacy wrapper — getFicStatus() senza companyId.
 * Usa la prima connessione trovata (backward compat per UI che non passa companyId).
 */
export async function getFicStatus(): Promise<FicIntegrationStatus & {
  accountId: string | null;
  companyId: number | null;
  companyName: string | null;
  scopes: string | null;
}> {
  const db = getDb();
  const [conn] = await db.select().from(ficConnections).limit(1);
  if (!conn || !conn.accessToken) {
    return {
      connected: false,
      expired: false,
      accountId: null,
      companyId: null,
      companyName: null,
      ficCompanyId: null,
      tokenExpiresAt: null,
      scopes: null,
      configured: !!process.env.FATTUREINCLOUD_CLIENT_ID,
    };
  }
  const expired = conn.tokenExpiresAt ? isTokenExpired(conn.tokenExpiresAt) : false;
  return {
    connected: true,
    expired,
    accountId: conn.ficCompanyId ?? null,
    companyId: conn.ficCompanyId ? parseInt(conn.ficCompanyId, 10) : null,
    companyName: null,
    ficCompanyId: conn.ficCompanyId ?? null,
    tokenExpiresAt: conn.tokenExpiresAt?.toISOString() ?? null,
    scopes: null,
    configured: true,
  };
}

// ─── OAuth flow ────────────────────────────────────────────────────────────

const OAUTH_SCOPES = [
  "entity.clients:r",
  "entity.clients:a",
  "issued_documents.proformas:a",
  "settings:r",
].join(" ");

/**
 * Genera URL OAuth per una specifica company.
 * Il state include il companyId per il callback.
 */
export function getFicAuthorizationUrlForCompany(
  companyId: string,
  opts?: { forceLogin?: boolean },
): string {
  const creds = getFicClientCredentials(companyId);
  if (!creds) {
    throw new Error(
      `OAuth FiC non configurato per company ${companyId} — mancano env vars FATTUREINCLOUD_CLIENT_ID/SECRET`,
    );
  }

  const state = JSON.stringify({ companyId, ts: Date.now() });
  const stateEncoded = Buffer.from(state).toString("base64url");

  const params: Record<string, string> = {
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    scope: OAUTH_SCOPES,
    state: stateEncoded,
  };
  if (opts?.forceLogin) {
    params.prompt = "login";
  }
  return `${FIC_API_BASE}/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

/**
 * Legacy wrapper for backward compat.
 */
export function getFicAuthorizationUrl(opts?: { forceLogin?: boolean }): string {
  // Default to SoKeto Srl for backward compat
  return getFicAuthorizationUrlForCompany(
    "00000000-0000-0000-0000-000000000002",
    opts,
  );
}

/**
 * Completa il flusso OAuth per una company specifica.
 * Scambia code → token, chiama /user/companies per scoprire la company FiC,
 * UPSERT su ficConnections.
 */
export async function completeFicOAuthForCompany(
  code: string,
  companyId: string,
): Promise<{ ficCompanyId: number; ficCompanyName: string }> {
  const creds = getFicClientCredentials(companyId);
  if (!creds) throw new Error(`OAuth FiC non configurato per company ${companyId}`);

  const tokens = await exchangeCodeForTokens(creds, code);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Discovery: prendi la prima company FiC disponibile
  const ficCompanies = await listFicCompanies(tokens.access_token);
  const ficCompany = ficCompanies[0];
  if (!ficCompany) throw new Error("Account FiC senza alcuna company associata");

  const db = getDb();

  // Cross-company validation: se esiste già una connessione per questa company,
  // verifica che il ficCompanyId restituito da FiC corrisponda a quello salvato.
  // Previene sovrascrivimenti accidentali se l'utente autorizza l'azienda FiC sbagliata.
  const existing = await db
    .select({ ficCompanyId: ficConnections.ficCompanyId })
    .from(ficConnections)
    .where(eq(ficConnections.companyId, companyId))
    .limit(1);

  if (existing.length > 0 && existing[0].ficCompanyId) {
    const expectedFicId = existing[0].ficCompanyId;
    if (expectedFicId !== String(ficCompany.id)) {
      throw new Error(
        `Hai autorizzato l'azienda FiC "${ficCompany.name}" (ID ${ficCompany.id}) ` +
        `ma questa company del gestionale era gi\u00e0 collegata a FiC ID ${expectedFicId}. ` +
        `Verifica di aver selezionato l'azienda corretta nel selettore di Fatture in Cloud ` +
        `prima di riautorizzare. Se vuoi cambiare azienda FiC, disconnetti prima e riconnetti.`
      );
    }
  }

  await db
    .insert(ficConnections)
    .values({
      companyId,
      ficCompanyId: String(ficCompany.id),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt,
    })
    .onConflictDoUpdate({
      target: ficConnections.companyId,
      set: {
        ficCompanyId: String(ficCompany.id),
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      },
    });

  console.log(`[fic] OAuth completed for company ${companyId} → FiC company ${ficCompany.id} (${ficCompany.name})`);
  return { ficCompanyId: ficCompany.id, ficCompanyName: ficCompany.name };
}

/**
 * Legacy wrapper — completeFicOAuth senza companyId (backward compat).
 */
export async function completeFicOAuth(code: string): Promise<{
  companyId: number;
  companyName: string;
}> {
  const result = await completeFicOAuthForCompany(code, "00000000-0000-0000-0000-000000000002");
  return { companyId: result.ficCompanyId, companyName: result.ficCompanyName };
}

/**
 * Disconnette la company da FiC (DELETE ficConnections row).
 */
export async function disconnectFicForCompany(companyId: string): Promise<{ deleted: number }> {
  const db = getDb();
  const deleted = await db
    .delete(ficConnections)
    .where(eq(ficConnections.companyId, companyId))
    .returning();
  console.log(`[fic] disconnectFic company=${companyId} — righe rimosse: ${deleted.length}`);
  return { deleted: deleted.length };
}

export async function disconnectFic(): Promise<{ deleted: number }> {
  return disconnectFicForCompany("00000000-0000-0000-0000-000000000002");
}

// ─── FiC API helpers ───────────────────────────────────────────────────────

async function listFicCompanies(accessToken: string): Promise<FicCompanyInfo[]> {
  try {
    const r = await axios.get<{ data: { companies: FicCompanyInfo[] } }>(
      `${FIC_API_BASE}/user/companies`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    return r.data?.data?.companies ?? [];
  } catch (e: any) {
    console.error("[fic] listCompanies failed:", e?.response?.data ?? e?.message);
    throw new Error(
      `Impossibile leggere companies da FiC: ${e?.response?.data?.error?.message ?? e?.message}`,
    );
  }
}

/**
 * Recupera lista clienti FiC per una company specifica.
 * Pagina fino a 50 pagine (5000 clienti max).
 */
export async function refreshFicClientsForCompany(companyId: string): Promise<{
  clients: FicClientInfo[];
  refreshedAt: string;
}> {
  const { accessToken, ficCompanyId } = await getActiveFicConnection(companyId);
  const clients: FicClientInfo[] = [];
  let page = 1;
  while (page <= 50) {
    try {
      const r = await axios.get<{
        data: FicClientInfo[];
        current_page: number;
        last_page: number;
      }>(`${FIC_API_BASE}/c/${ficCompanyId}/entities/clients`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { per_page: 100, page },
      });
      const batch = r.data?.data ?? [];
      clients.push(...batch);
      const last = r.data?.last_page ?? page;
      if (page >= last) break;
      page++;
    } catch (e: any) {
      console.error("[fic] refreshClients failed:", e?.response?.data ?? e?.message);
      throw new Error(
        `Impossibile leggere clienti da FiC: ${e?.response?.data?.error?.message ?? e?.message}`,
      );
    }
  }
  return { clients, refreshedAt: new Date().toISOString() };
}

/**
 * Legacy wrapper — refreshFicClients senza companyId.
 */
export async function refreshFicClients(): Promise<{
  clients: FicClientInfo[];
  refreshedAt: string;
}> {
  return refreshFicClientsForCompany("00000000-0000-0000-0000-000000000002");
}

/**
 * Legacy wrapper — getFicClients (reads from first connection).
 * M11.C: la cache clienti non è più in metadata DB, ma viene fetchata on-demand.
 */
export async function getFicClients(forceRefresh = false): Promise<{
  clients: FicClientInfo[];
  refreshedAt: string | null;
}> {
  if (forceRefresh) {
    return await refreshFicClients();
  }
  // Without metadata cache, return empty (UI should trigger refresh)
  return { clients: [], refreshedAt: null };
}

// ─── Single FiC Client fetch (by id) with cache ───────────────────────────
const ficClientByIdCache = new Map<string, { data: FicClientInfo; fetchedAt: number }>();
const FIC_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch un singolo cliente FiC per id, per una company specifica.
 */
export async function getFicClientByIdForCompany(
  clientId: number,
  companyId: string,
): Promise<FicClientInfo> {
  const cacheKey = `${companyId}:${clientId}`;
  const cached = ficClientByIdCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FIC_CLIENT_CACHE_TTL_MS) {
    return cached.data;
  }

  const { accessToken, ficCompanyId } = await getActiveFicConnection(companyId);
  try {
    const r = await axios.get<{ data: FicClientInfo }>(
      `${FIC_API_BASE}/c/${ficCompanyId}/entities/clients/${clientId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const client = r.data?.data;
    if (!client) throw new Error(`FiC client id=${clientId} non trovato`);
    ficClientByIdCache.set(cacheKey, { data: client, fetchedAt: Date.now() });
    return client;
  } catch (e: any) {
    throw new Error(
      `Impossibile recuperare cliente FiC id=${clientId}: ${e?.response?.data?.error?.message ?? e?.message}`,
    );
  }
}

/**
 * Legacy wrapper — getFicClientById senza companyId (usa SoKeto default).
 */
export async function getFicClientById(clientId: number): Promise<FicClientInfo> {
  return getFicClientByIdForCompany(clientId, "00000000-0000-0000-0000-000000000002");
}

// ─── VAT Types cache ───────────────────────────────────────────────────────
const vatTypesCache = new Map<string, { data: FicVatType[]; fetchedAt: number }>();
const VAT_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getFicVatTypesForCompany(companyId: string): Promise<FicVatType[]> {
  const cacheKey = companyId;
  const cached = vatTypesCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < VAT_CACHE_TTL_MS) {
    return cached.data;
  }

  const { accessToken, ficCompanyId } = await getActiveFicConnection(companyId);
  const r = await axios.get<{ data: FicVatType[] }>(
    `${FIC_API_BASE}/c/${ficCompanyId}/info/vat_types`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const types = (r.data?.data ?? []).filter((t) => !t.is_disabled);
  vatTypesCache.set(cacheKey, { data: types, fetchedAt: Date.now() });
  return types;
}

export async function getFicVatTypes(): Promise<FicVatType[]> {
  return getFicVatTypesForCompany("00000000-0000-0000-0000-000000000002");
}

// ─── Payment Methods cache ─────────────────────────────────────────────────
const paymentMethodsCache = new Map<string, { data: FicPaymentMethod[]; fetchedAt: number }>();
const PM_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getFicPaymentMethodsForCompany(companyId: string): Promise<FicPaymentMethod[]> {
  const cacheKey = companyId;
  const cached = paymentMethodsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PM_CACHE_TTL_MS) {
    return cached.data;
  }

  const { accessToken, ficCompanyId } = await getActiveFicConnection(companyId);
  const r = await axios.get<{ data: FicPaymentMethod[] }>(
    `${FIC_API_BASE}/c/${ficCompanyId}/info/payment_methods`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const methods = r.data?.data ?? [];
  paymentMethodsCache.set(cacheKey, { data: methods, fetchedAt: Date.now() });
  return methods;
}

export async function getFicPaymentMethods(): Promise<FicPaymentMethod[]> {
  return getFicPaymentMethodsForCompany("00000000-0000-0000-0000-000000000002");
}

// ─── Utility functions ─────────────────────────────────────────────────────

function findVatTypeId(vatTypes: FicVatType[], vatRate: number): number {
  const match = vatTypes.find((t) => t.value === vatRate);
  if (!match) {
    throw new Error(
      `VAT rate ${vatRate}% non configurata su FiC. Disponibili: ${vatTypes.map((t) => `${t.value}% (id=${t.id})`).join(", ")}`,
    );
  }
  return match.id;
}

function findPaymentMethodId(methods: FicPaymentMethod[], nameHint: string): number {
  const lower = nameHint.toLowerCase();
  const exact = methods.find((m) => m.name.toLowerCase() === lower);
  if (exact) return exact.id;
  const partial = methods.find((m) => m.name.toLowerCase().includes(lower));
  if (partial) return partial.id;
  const def = methods.find((m) => m.is_default);
  if (def) return def.id;
  if (methods.length > 0) return methods[0].id;
  throw new Error(`Nessun metodo di pagamento configurato su FiC.`);
}

function computePaymentsAmount(items: Array<{
  quantity: number;
  unitPrice: number;
  vatRate: number;
}>): number {
  const vatGroups: Record<string, number> = {};
  for (const item of items) {
    const lineNet = item.quantity * item.unitPrice;
    const vatKey = item.vatRate.toString();
    vatGroups[vatKey] = (vatGroups[vatKey] ?? 0) + lineNet;
  }
  let totalGross = 0;
  for (const [vatRateStr, totalNet] of Object.entries(vatGroups)) {
    const vatRate = parseFloat(vatRateStr);
    const netRounded = Math.round((totalNet + Number.EPSILON) * 100) / 100;
    const vat = Math.round((netRounded * vatRate / 100 + Number.EPSILON) * 100) / 100;
    totalGross += netRounded + vat;
  }
  return Math.round((totalGross + Number.EPSILON) * 100) / 100;
}

// ─── Proforma creation (multi-tenant) ──────────────────────────────────────

/**
 * Crea proforma su FiC per una company specifica.
 * Il companyId determina quale connessione FiC usare.
 */
export async function createFicProformaForCompany(
  companyId: string,
  input: {
    ficClientId: number;
    date: string;
    notesInternal: string;
    orderNumber?: string;
    items: Array<{
      code?: string;
      name: string;
      description: string;
      qty: number;
      unitPriceFinal: string;
      vatRate: string;
    }>;
  },
): Promise<{ id: number; number: string }> {
  const { accessToken, ficCompanyId } = await getActiveFicConnection(companyId);

  const [vatTypes, paymentMethods] = await Promise.all([
    getFicVatTypesForCompany(companyId),
    getFicPaymentMethodsForCompany(companyId),
  ]);

  const paymentMethodId = findPaymentMethodId(paymentMethods, "Bonifico");

  const items_list = input.items.map((it) => {
    const vatRateNum = parseFloat(it.vatRate);
    const vatId = findVatTypeId(vatTypes, vatRateNum);
    return {
      product_id: 0,
      ...(it.code ? { code: it.code } : {}),
      name: it.name,
      description: it.description,
      qty: it.qty,
      net_price: parseFloat(it.unitPriceFinal),
      vat: { id: vatId },
      not_taxable: false,
    };
  });

  const paymentsAmount = computePaymentsAmount(
    input.items.map((it) => ({
      quantity: it.qty,
      unitPrice: parseFloat(it.unitPriceFinal),
      vatRate: parseFloat(it.vatRate),
    })),
  );

  const ficEntity = await getFicClientByIdForCompany(input.ficClientId, companyId);

  const body = {
    data: {
      type: "proforma",
      entity: ficEntity,
      date: input.date,
      currency: { id: "EUR" },
      payment_method: { id: paymentMethodId },
      subject: input.orderNumber ? `Ordine ${input.orderNumber}` : "Proforma",
      visible_subject: input.orderNumber ? `Ordine ${input.orderNumber}` : "Proforma",
      items_list,
      payments_list: [{
        amount: paymentsAmount,
        due_date: input.date,
        status: "not_paid" as const,
      }],
      notes: input.notesInternal,
    },
  };

  console.log(`[fic:createProforma] company=${companyId} ficCompany=${ficCompanyId} client=${input.ficClientId}`);

  try {
    const r = await axios.post<{
      data: { id: number; number: string };
    }>(`${FIC_API_BASE}/c/${ficCompanyId}/issued_documents`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const out = r.data?.data;
    if (!out?.id) throw new Error("FiC non ha restituito proforma id");
    console.log(`[fic:createProforma] OK → id=${out.id} number=${out.number}`);
    return { id: out.id, number: out.number ?? `${out.id}` };
  } catch (e: any) {
    const validationFields = e?.response?.data?.error?.validation_result?.fields;
    const validationMsg = validationFields
      ? validationFields.map((f: any) => `${f.field}: ${f.message}`).join("; ")
      : null;
    const msg =
      validationMsg ??
      e?.response?.data?.error?.message ??
      e?.response?.data?.message ??
      e?.message ??
      "errore sconosciuto";
    throw new Error(`FiC API (${e?.response?.status ?? "??"}): ${msg}`);
  }
}

/**
 * Legacy wrapper — createFicProforma senza companyId (usa SoKeto default).
 */
export async function createFicProforma(input: {
  ficClientId: number;
  date: string;
  notesInternal: string;
  orderNumber?: string;
  totalGross?: number;
  items: Array<{
    code?: string;
    name: string;
    description: string;
    qty: number;
    unitPriceFinal: string;
    vatRate: string;
  }>;
}): Promise<{ id: number; number: string }> {
  return createFicProformaForCompany("00000000-0000-0000-0000-000000000002", input);
}

// ─── Legacy getValidFicAccessToken (backward compat) ───────────────────────

export async function getValidFicAccessToken(): Promise<{
  accessToken: string;
  companyId: number;
}> {
  const result = await getActiveFicConnection("00000000-0000-0000-0000-000000000002");
  return { accessToken: result.accessToken, companyId: result.ficCompanyId };
}

// ─── RetailerFicMapping helpers ────────────────────────────────────────────

/**
 * Recupera il ficClientId per un retailer in una company specifica.
 * Ritorna null se non mappato.
 */
export async function getRetailerFicClientId(
  retailerId: string,
  companyId: string,
): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ ficClientId: retailerFicMapping.ficClientId })
    .from(retailerFicMapping)
    .where(
      and(
        eq(retailerFicMapping.retailerId, retailerId),
        eq(retailerFicMapping.companyId, companyId),
      ),
    )
    .limit(1);
  return row?.ficClientId ?? null;
}

/**
 * Sincronizza i mapping retailer ↔ FiC client per una company.
 * Match per vatNumber tra retailer locali e clienti FiC.
 */
export async function syncRetailerFicMappings(companyId: string): Promise<{
  mapped: number;
  unmatched: string[];
}> {
  const { clients } = await refreshFicClientsForCompany(companyId);

  // Get all retailers for this company
  const db = getDb();
  const allRetailers = await db
    .select({
      id: retailers.id,
      name: retailers.name,
    })
    .from(retailers)
    .where(eq(retailers.companyId, companyId));

  // Build vatNumber → ficClientId map from FiC clients
  const ficByVat = new Map<string, number>();
  for (const c of clients) {
    if (c.vat_number) {
      ficByVat.set(c.vat_number.replace(/\s/g, "").toUpperCase(), c.id);
    }
  }

  let mapped = 0;
  const unmatched: string[] = [];

  for (const retailer of allRetailers) {
    // Match by name (case-insensitive) between local retailer and FiC client
    const ficClient = clients.find(
      (c) => c.name?.toLowerCase().trim() === retailer.name?.toLowerCase().trim(),
    );

    if (ficClient) {
      await db
        .insert(retailerFicMapping)
        .values({
          retailerId: retailer.id,
          companyId,
          ficClientId: ficClient.id,
        })
        .onConflictDoUpdate({
          target: [retailerFicMapping.retailerId, retailerFicMapping.companyId],
          set: {
            ficClientId: ficClient.id,
            updatedAt: new Date(),
          },
        });
      mapped++;
    } else {
      unmatched.push(retailer.name);
    }
  }

  return { mapped, unmatched };
}

// ─── Error classes ─────────────────────────────────────────────────────────

export class FicNotConnectedError extends Error {
  constructor(companyId: string) {
    super(
      `Questa company non è connessa a Fatture in Cloud. Vai in Impostazioni → Integrazioni per connetterla.`,
    );
    this.name = "FicNotConnectedError";
  }
}

export class FicReauthRequiredError extends Error {
  constructor(companyId: string) {
    super(
      `Il token FiC per questa company è scaduto e non è possibile rinnovarlo. Riconnetti da Impostazioni → Integrazioni.`,
    );
    this.name = "FicReauthRequiredError";
  }
}
