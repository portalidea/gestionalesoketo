/**
 * Phase B M3 — Fatture in Cloud single-tenant integration.
 *
 * Single-tenant: 1 sola installazione FiC per l'intero sistema (account
 * E-Keto Food Srls). Token salvati in `systemIntegrations` con type='fattureincloud'.
 *
 * Differenza con `fattureincloud-oauth.ts` legacy (per-retailer): qui il
 * companyId è l'account FiC di SoKeto, e l'integrazione mantiene l'unico
 * accessToken usato per tutte le operazioni (creazione clienti FiC,
 * generazione proforma, ecc.).
 *
 * Il modulo legacy resta in piedi per ora (rollback safety); cleanup
 * pianificato in 0006 con MIGRATION_LOG.
 */
import axios from "axios";
import {
  exchangeCodeForTokens,
  getOAuthConfig,
  isTokenExpired,
  refreshAccessToken,
} from "./fattureincloud-oauth";
import * as db from "./db";

export const FIC_INTEGRATION_TYPE = "fattureincloud";
const FIC_API_BASE = "https://api-v2.fattureincloud.it";

export interface FicCompanyInfo {
  id: number;
  name: string;
  type?: string;
}

/**
 * Shape parziale di un cliente FiC. I campi address_* + contact sono
 * usati dal flow "Crea retailer da cliente FiC" (M3.0.6) per auto-popolare
 * il form. Per l'elenco completo vedi:
 * https://developers.fattureincloud.it/docs/api-reference/c/companyId/entities/clients
 */
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

interface FicIntegrationMetadata {
  companyId?: number;
  companyName?: string;
  clientsCache?: FicClientInfo[];
  clientsCacheRefreshedAt?: string;
}

/**
 * Stato integrazione FiC esposto in UI.
 */
export interface FicIntegrationStatus {
  connected: boolean;
  expired: boolean;
  accountId: string | null;
  companyId: number | null;
  companyName: string | null;
  expiresAt: string | null;
  scopes: string | null;
  configured: boolean; // env vars presenti
}

export async function getFicStatus(): Promise<FicIntegrationStatus> {
  const config = getOAuthConfig();
  const integration = await db.getSystemIntegration(FIC_INTEGRATION_TYPE);

  if (!integration || !integration.accessToken) {
    return {
      connected: false,
      expired: false,
      accountId: null,
      companyId: null,
      companyName: null,
      expiresAt: null,
      scopes: null,
      configured: !!config,
    };
  }

  const meta = (integration.metadata ?? {}) as FicIntegrationMetadata;
  const expired = integration.expiresAt
    ? isTokenExpired(integration.expiresAt)
    : false;

  return {
    connected: true,
    expired,
    accountId: integration.accountId ?? null,
    companyId: meta.companyId ?? null,
    companyName: meta.companyName ?? null,
    expiresAt: integration.expiresAt?.toISOString() ?? null,
    scopes: integration.scopes ?? null,
    configured: !!config,
  };
}

/**
 * Costruisce URL OAuth single-tenant. Il `state` è solo un marker statico
 * dato che non c'è un retailer-id da preservare nello stato (single-tenant
 * = 1 sola integrazione di sistema).
 *
 * `forceLogin=true` aggiunge `prompt=login` (param OIDC standard, non
 * documentato esplicitamente da FiC ma RFC 6749 §3.1 dice che il provider
 * DEVE ignorare param sconosciuti → safe da inviare). Se FiC lo onora
 * forza re-autenticazione interrompendo la sessione cookie e rimostrando
 * il selettore azienda quando l'utente ha più company. Se lo ignora,
 * comportamento identico al default. Bug M3.0.2.
 */
export function getFicAuthorizationUrl(opts?: { forceLogin?: boolean }): string {
  const config = getOAuthConfig();
  if (!config)
    throw new Error(
      "OAuth FiC non configurato — mancano FATTUREINCLOUD_CLIENT_ID/SECRET/REDIRECT_URI",
    );
  // FiC scope format: RESOURCE:LEVEL dove `issued_documents` deve essere
  // specificato per tipo documento (proformas, invoices, ...). Lo scope
  // generico `issued_documents:a` NON esiste e provoca "scope is not valid".
  // Ref: https://developers.fattureincloud.it/docs/basics/scopes/
  // M3 ha bisogno di:
  // - entity.clients:r → leggere lista clienti FiC (cache + dropdown UI)
  // - entity.clients:a → riservato per future auto-creazione clienti FiC
  //   da retailer (M4+); inclusa ora per evitare re-consent OAuth dopo.
  // - issued_documents.proformas:a → POST /issued_documents type=proforma.
  //   `:a` (full write) include implicitamente `:r`.
  // - settings:r → endpoint /user/companies durante discovery + future
  //   letture di config account.
  const params: Record<string, string> = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: [
      "entity.clients:r",
      "entity.clients:a",
      "issued_documents.proformas:a",
      "settings:r",
    ].join(" "),
    state: "soketo-single-tenant",
  };
  if (opts?.forceLogin) {
    params.prompt = "login";
  }
  return `${FIC_API_BASE}/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

/**
 * Completa il flusso OAuth: scambia code → token, chiama /user/companies
 * per scoprire la company FiC, salva tutto in systemIntegrations.
 */
export async function completeFicOAuth(code: string): Promise<{
  companyId: number;
  companyName: string;
}> {
  const config = getOAuthConfig();
  if (!config) throw new Error("OAuth FiC non configurato");

  const tokens = await exchangeCodeForTokens(config, code);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Discovery: prendi la prima company disponibile come "company di lavoro"
  // single-tenant. Se l'account ha più companies (raro per E-Keto Food),
  // l'admin dovrà eventualmente cambiare in futuro via env override o UI.
  const companies = await listFicCompanies(tokens.access_token);
  const company = companies[0];
  if (!company) throw new Error("Account FiC senza alcuna company associata");

  const metadata: FicIntegrationMetadata = {
    companyId: company.id,
    companyName: company.name,
  };

  await db.upsertSystemIntegration({
    type: FIC_INTEGRATION_TYPE,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
    accountId: String(company.id),
    scopes: tokens.token_type ?? null,
    metadata,
  });

  return { companyId: company.id, companyName: company.name };
}

export async function disconnectFic(): Promise<{ deleted: number }> {
  const deleted = await db.deleteSystemIntegration(FIC_INTEGRATION_TYPE);
  console.log(`[fic] disconnectFic — righe rimosse da systemIntegrations: ${deleted}`);
  return { deleted };
}

/**
 * Recupera l'access token corrente, rinfrescandolo via refresh_token se
 * scaduto. Persiste i nuovi token in DB.
 */
export async function getValidFicAccessToken(): Promise<{
  accessToken: string;
  companyId: number;
}> {
  const integration = await db.getSystemIntegration(FIC_INTEGRATION_TYPE);
  if (!integration || !integration.accessToken) {
    throw new Error("Integrazione Fatture in Cloud non connessa");
  }
  const meta = (integration.metadata ?? {}) as FicIntegrationMetadata;
  if (!meta.companyId) {
    throw new Error("Integrazione FiC senza companyId — riconnetti l'integrazione");
  }

  if (
    integration.expiresAt &&
    isTokenExpired(integration.expiresAt) &&
    integration.refreshToken
  ) {
    const config = getOAuthConfig();
    if (!config) throw new Error("OAuth FiC non configurato");
    const refreshed = await refreshAccessToken(config, integration.refreshToken);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await db.upsertSystemIntegration({
      type: FIC_INTEGRATION_TYPE,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: newExpiresAt,
      accountId: integration.accountId,
      scopes: integration.scopes,
      metadata: integration.metadata,
    });
    return { accessToken: refreshed.access_token, companyId: meta.companyId };
  }

  return { accessToken: integration.accessToken, companyId: meta.companyId };
}

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
 * Recupera lista clienti dalla cache locale (systemIntegrations.metadata).
 *
 * M3.0.7 BUGFIX: la versione precedente cadeva in `refreshFicClients()` se
 * la cache era vuota, paginando fino a 50 pagine FiC API in modo SINCRONO
 * davanti a query frontend hot (es. /retailers/:id). Per N centinaia di
 * clienti FiC, l'utente vedeva la pagina caricare per minuti.
 *
 * Comportamento M3.0.7+: se cache vuota e `!forceRefresh`, ritorna
 * `{ clients: [], refreshedAt: null }` immediatamente. Il refresh diventa
 * **strettamente esplicito** — solo dal pulsante "Aggiorna lista clienti
 * FiC" su /settings/integrations o dal bottone inline "Aggiorna ora" nei
 * dropdown FiC client. Così le query frontend sono O(1) DB read e gli
 * empty state UI guidano l'utente al primo refresh manuale.
 */
export async function getFicClients(forceRefresh = false): Promise<{
  clients: FicClientInfo[];
  refreshedAt: string | null;
}> {
  const integration = await db.getSystemIntegration(FIC_INTEGRATION_TYPE);
  if (!integration) throw new Error("Integrazione FiC non connessa");
  const meta = (integration.metadata ?? {}) as FicIntegrationMetadata;
  if (forceRefresh) {
    return await refreshFicClients();
  }
  return {
    clients: meta.clientsCache ?? [],
    refreshedAt: meta.clientsCacheRefreshedAt ?? null,
  };
}

export async function refreshFicClients(): Promise<{
  clients: FicClientInfo[];
  refreshedAt: string;
}> {
  const { accessToken, companyId } = await getValidFicAccessToken();
  const clients: FicClientInfo[] = [];
  let page = 1;
  // FiC paginazione: per_page max 100. Loop fino a esaurimento.
  // Cap di sicurezza a 50 pagine (5000 clienti).
  while (page <= 50) {
    try {
      const r = await axios.get<{
        data: FicClientInfo[];
        current_page: number;
        last_page: number;
      }>(`${FIC_API_BASE}/c/${companyId}/entities/clients`, {
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

  const refreshedAt = new Date().toISOString();
  const integration = await db.getSystemIntegration(FIC_INTEGRATION_TYPE);
  if (integration) {
    const meta = (integration.metadata ?? {}) as FicIntegrationMetadata;
    await db.upsertSystemIntegration({
      type: FIC_INTEGRATION_TYPE,
      accessToken: integration.accessToken,
      refreshToken: integration.refreshToken,
      expiresAt: integration.expiresAt,
      accountId: integration.accountId,
      scopes: integration.scopes,
      metadata: {
        ...meta,
        clientsCache: clients,
        clientsCacheRefreshedAt: refreshedAt,
      } satisfies FicIntegrationMetadata,
    });
  }

  return { clients, refreshedAt };
}

// ─── Single FiC Client fetch (by id) with cache ─────────────────────────
const ficClientByIdCache = new Map<number, { data: FicClientInfo; fetchedAt: number }>();
const FIC_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Fetch un singolo cliente FiC per id.
 * Prima cerca nella clientsCache locale (metadata DB), poi fallback a API diretta.
 * Cache in-memory 5 min per evitare chiamate ripetute.
 */
export async function getFicClientById(clientId: number): Promise<FicClientInfo> {
  // Check in-memory cache
  const cached = ficClientByIdCache.get(clientId);
  if (cached && Date.now() - cached.fetchedAt < FIC_CLIENT_CACHE_TTL_MS) {
    console.log(`[fic:getClientById] cache HIT id=${clientId}`);
    return cached.data;
  }

  // Try clientsCache from DB metadata first (no API call)
  try {
    const { clients } = await getFicClients();
    const fromCache = clients.find((c) => c.id === clientId);
    if (fromCache) {
      console.log(`[fic:getClientById] found in clientsCache id=${clientId} name=${fromCache.name}`);
      ficClientByIdCache.set(clientId, { data: fromCache, fetchedAt: Date.now() });
      return fromCache;
    }
  } catch (e) {
    console.warn("[fic:getClientById] clientsCache lookup failed, trying API", e);
  }

  // Fallback: direct API call
  console.log(`[fic:getClientById] API fetch id=${clientId}`);
  const { accessToken, companyId } = await getValidFicAccessToken();
  try {
    const r = await axios.get<{ data: FicClientInfo }>(
      `${FIC_API_BASE}/c/${companyId}/entities/clients/${clientId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const client = r.data?.data;
    if (!client) throw new Error(`FiC client id=${clientId} non trovato`);
    ficClientByIdCache.set(clientId, { data: client, fetchedAt: Date.now() });
    return client;
  } catch (e: any) {
    console.error(`[fic:getClientById] API error for id=${clientId}:`, e?.response?.data ?? e?.message);
    throw new Error(`Impossibile recuperare cliente FiC id=${clientId}: ${e?.response?.data?.error?.message ?? e?.message}`);
  }
}

// ─── VAT Types cache in-memory ───────────────────────────────────────────

export interface FicVatType {
  id: number;
  value: number; // es. 10, 22, 4
  description: string;
  is_disabled: boolean;
}

const vatTypesCache = new Map<number, { data: FicVatType[]; fetchedAt: number }>();
const VAT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuti

/**
 * Fetch vat_types da FiC per la company corrente, con cache in-memory 5 min.
 */
export async function getFicVatTypes(): Promise<FicVatType[]> {
  const { accessToken, companyId } = await getValidFicAccessToken();

  const cached = vatTypesCache.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < VAT_CACHE_TTL_MS) {
    return cached.data;
  }

  console.log(`[fic:vatTypes] Fetching vat_types for company ${companyId}...`);
  try {
    const r = await axios.get<{ data: FicVatType[] }>(
      `${FIC_API_BASE}/c/${companyId}/info/vat_types`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const types = (r.data?.data ?? []).filter((t) => !t.is_disabled);
    vatTypesCache.set(companyId, { data: types, fetchedAt: Date.now() });
    console.log(`[fic:vatTypes] Cached ${types.length} vat_types: ${types.map((t) => `${t.id}=${t.value}%`).join(", ")}`);
    return types;
  } catch (e: any) {
    console.error("[fic:vatTypes] ERROR:", e?.response?.data ?? e?.message);
    throw new Error(
      `Impossibile leggere vat_types da FiC: ${e?.response?.data?.error?.message ?? e?.message}`,
    );
  }
}

/**
 * Trova il vat_type FiC corrispondente a una aliquota IVA (es. 10, 22, 4).
 * Throw se non trovato.
 */
function findVatTypeId(vatTypes: FicVatType[], vatRate: number): number {
  const match = vatTypes.find((t) => t.value === vatRate);
  if (!match) {
    throw new Error(
      `VAT rate ${vatRate}% non configurata su FiC. Configurala manualmente prima. Disponibili: ${vatTypes.map((t) => `${t.value}% (id=${t.id})`).join(", ")}`,
    );
  }
  return match.id;
}

// ─── Payment Methods cache in-memory ──────────────────────────────────────

export interface FicPaymentMethod {
  id: number;
  name: string;
  type: string; // 'standard', etc.
  is_default: boolean;
}

const paymentMethodsCache = new Map<number, { data: FicPaymentMethod[]; fetchedAt: number }>();
const PM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuti

/**
 * Fetch payment_methods da FiC per la company corrente, con cache in-memory 5 min.
 */
export async function getFicPaymentMethods(): Promise<FicPaymentMethod[]> {
  const { accessToken, companyId } = await getValidFicAccessToken();

  const cached = paymentMethodsCache.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < PM_CACHE_TTL_MS) {
    return cached.data;
  }

  console.log(`[fic:paymentMethods] Fetching payment_methods for company ${companyId}...`);
  try {
    const r = await axios.get<{ data: FicPaymentMethod[] }>(
      `${FIC_API_BASE}/c/${companyId}/info/payment_methods`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const methods = r.data?.data ?? [];
    paymentMethodsCache.set(companyId, { data: methods, fetchedAt: Date.now() });
    console.log(`[fic:paymentMethods] Cached ${methods.length} methods: ${methods.map((m) => `${m.id}="${m.name}"`).join(", ")}`);
    return methods;
  } catch (e: any) {
    console.error("[fic:paymentMethods] ERROR:", e?.response?.data ?? e?.message);
    throw new Error(
      `Impossibile leggere payment_methods da FiC: ${e?.response?.data?.error?.message ?? e?.message}`,
    );
  }
}

/**
 * Trova il payment_method FiC per nome (case-insensitive, partial match).
 * Fallback: ritorna il default, o il primo disponibile.
 */
function findPaymentMethodId(methods: FicPaymentMethod[], nameHint: string): number {
  const lower = nameHint.toLowerCase();
  const exact = methods.find((m) => m.name.toLowerCase() === lower);
  if (exact) return exact.id;
  const partial = methods.find((m) => m.name.toLowerCase().includes(lower));
  if (partial) return partial.id;
  const def = methods.find((m) => m.is_default);
  if (def) {
    console.warn(`[fic:paymentMethod] "${nameHint}" non trovato, uso default "${def.name}" (id=${def.id})`);
    return def.id;
  }
  if (methods.length > 0) {
    console.warn(`[fic:paymentMethod] "${nameHint}" non trovato, uso primo disponibile "${methods[0].name}" (id=${methods[0].id})`);
    return methods[0].id;
  }
  throw new Error(`Nessun metodo di pagamento configurato su FiC. Configura almeno un metodo.`);
}

/**
 * Crea proforma su FiC dato payload retailer-side.
 *
 * Ritorna {id, number} su success, throw su qualsiasi errore (rete, 4xx,
 * 5xx). Il caller decide se enqueue per retry o fail hard.
 *
 * M6.2.A FIX:
 * - vat.id (ID del vat_type FiC) invece di vat.value
 * - payment_method.id (ID del payment_method FiC) invece di name
 * - payments_list con singola rata = totalGross
 */
export async function createFicProforma(input: {
  ficClientId: number;
  date: string; // YYYY-MM-DD
  notesInternal: string;
  orderNumber?: string;
  totalGross?: number; // totale lordo per payments_list
  items: Array<{
    code?: string; // SKU (opzionale — non visibile al cliente)
    description: string;
    qty: number;
    unitPriceFinal: string; // 2 decimali
    vatRate: string; // es. "10.00" / "22.00"
  }>;
}): Promise<{ id: number; number: string }> {
  const { accessToken, companyId } = await getValidFicAccessToken();

  // Fetch vat_types + payment_methods (cached 5 min)
  const [vatTypes, paymentMethods] = await Promise.all([
    getFicVatTypes(),
    getFicPaymentMethods(),
  ]);

  const paymentMethodId = findPaymentMethodId(paymentMethods, "Bonifico");

  // Mappa items con vat.id corretto
  const items_list = input.items.map((it) => {
    const vatRateNum = parseFloat(it.vatRate);
    const vatId = findVatTypeId(vatTypes, vatRateNum);
    return {
      product_id: 0, // no link a prodotto FiC
      ...(it.code ? { code: it.code } : {}), // code opzionale
      name: it.description,
      qty: it.qty,
      net_price: parseFloat(it.unitPriceFinal),
      vat: { id: vatId },
      not_taxable: false,
    };
  });
  // Calcola totalGross se non fornito (somma lineTotalGross)
  const totalGross = input.totalGross ?? input.items.reduce((sum, it) => {
    const vatRate = parseFloat(it.vatRate);
    return sum + parseFloat(it.unitPriceFinal) * it.qty * (1 + vatRate / 100);
  }, 0);

  // payments_list: singola rata = totale lordo documento
  const payments_list = [
    {
      amount: Math.round(totalGross * 100) / 100, // arrotonda a 2 decimali
      due_date: input.date,
      status: "not_paid" as const,
    },
  ];

  // Fetch entity completa da FiC API (cached 5 min)
  const ficEntity = await getFicClientById(input.ficClientId);
  console.log(`[fic:createProforma] entity: ${ficEntity.name} (id=${ficEntity.id})`);

  const body = {
    data: {
      type: "proforma",
      entity: ficEntity,
      date: input.date,
      currency: { id: "EUR" },
      payment_method: { id: paymentMethodId },
      subject: input.orderNumber ? `Ordine ${input.orderNumber}` : "Proforma SoKeto",
      visible_subject: input.orderNumber ? `Ordine ${input.orderNumber}` : "Proforma SoKeto",
      items_list,
      payments_list,
      notes: input.notesInternal,
    },
  };

  // === DIAGNOSTIC LOGGING ===
  console.log("[fic:createProforma] Payload →", JSON.stringify(body, null, 2));
  console.log(`[fic:createProforma] URL → ${FIC_API_BASE}/c/${companyId}/issued_documents`);

  try {
    const r = await axios.post<{
      data: { id: number; number: string };
    }>(`${FIC_API_BASE}/c/${companyId}/issued_documents`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    console.log("[fic:createProforma] Response OK →", JSON.stringify(r.data, null, 2));
    const out = r.data?.data;
    if (!out?.id) throw new Error("FiC non ha restituito proforma id");
    return { id: out.id, number: out.number ?? `${out.id}` };
  } catch (e: any) {
    // Log completo della response di errore
    console.error("[fic:createProforma] ERROR status →", e?.response?.status);
    console.error("[fic:createProforma] ERROR data →", JSON.stringify(e?.response?.data, null, 2));
    console.error("[fic:createProforma] ERROR headers →", JSON.stringify(e?.response?.headers, null, 2));

    // Estrai messaggio più dettagliato possibile
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
