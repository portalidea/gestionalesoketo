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

export interface FicClientInfo {
  id: number;
  name: string;
  vat_number?: string;
  tax_code?: string;
  email?: string;
  type?: string;
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

export async function disconnectFic(): Promise<void> {
  await db.deleteSystemIntegration(FIC_INTEGRATION_TYPE);
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
 * Se cache vuota o se forceRefresh, fetch da FiC.
 */
export async function getFicClients(forceRefresh = false): Promise<{
  clients: FicClientInfo[];
  refreshedAt: string | null;
}> {
  const integration = await db.getSystemIntegration(FIC_INTEGRATION_TYPE);
  if (!integration) throw new Error("Integrazione FiC non connessa");
  const meta = (integration.metadata ?? {}) as FicIntegrationMetadata;
  if (!forceRefresh && meta.clientsCache && meta.clientsCache.length > 0) {
    return {
      clients: meta.clientsCache,
      refreshedAt: meta.clientsCacheRefreshedAt ?? null,
    };
  }
  return await refreshFicClients();
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

/**
 * Crea proforma su FiC dato payload retailer-side.
 *
 * Ritorna {id, number} su success, throw su qualsiasi errore (rete, 4xx,
 * 5xx). Il caller decide se enqueue per retry o fail hard.
 *
 * Payload semplificato per M3: solo campi essenziali. Estensioni future
 * (sconti riga aggiuntivi, codici IVA non standard) in M4+.
 */
export async function createFicProforma(input: {
  ficClientId: number;
  date: string; // YYYY-MM-DD
  notesInternal: string;
  items: Array<{
    description: string;
    qty: number;
    unitPriceFinal: string; // 2 decimali
    vatRate: string; // es. "10.00" / "22.00"
  }>;
}): Promise<{ id: number; number: string }> {
  const { accessToken, companyId } = await getValidFicAccessToken();

  // Mappa vatRate string → struttura FiC vat. FiC accetta `vat: { value: 10 }`
  // su ogni riga. Per aliquote IT standard è sufficiente `value`.
  const items_list = input.items.map((it) => ({
    name: it.description,
    qty: it.qty,
    net_price: parseFloat(it.unitPriceFinal),
    vat: { value: parseFloat(it.vatRate) },
  }));

  const body = {
    data: {
      type: "proforma",
      entity: { id: input.ficClientId },
      date: input.date,
      payment_method: { name: "Bonifico" },
      items_list,
      notes: input.notesInternal,
      visible_subject: "Proforma SoKeto",
    },
  };

  try {
    const r = await axios.post<{
      data: { id: number; number: string };
    }>(`${FIC_API_BASE}/c/${companyId}/issued_documents`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const out = r.data?.data;
    if (!out?.id) throw new Error("FiC non ha restituito proforma id");
    return { id: out.id, number: out.number ?? `${out.id}` };
  } catch (e: any) {
    const msg =
      e?.response?.data?.error?.message ??
      e?.response?.data?.error?.validation_result?.fields?.[0]?.message ??
      e?.message ??
      "errore sconosciuto";
    throw new Error(`FiC API: ${msg}`);
  }
}
