/**
 * Fatture in Cloud OAuth2 Integration
 * Gestisce autenticazione e token management per API Fatture in Cloud
 */

import axios from "axios";

const FATTUREINCLOUD_AUTH_URL = "https://api-v2.fattureincloud.it/oauth/authorize";
const FATTUREINCLOUD_TOKEN_URL = "https://api-v2.fattureincloud.it/oauth/token";
const FATTUREINCLOUD_API_BASE = "https://api-v2.fattureincloud.it/c";

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface FattureInCloudConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Genera URL per avviare il flusso OAuth2
 */
export function getAuthorizationUrl(config: FattureInCloudConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
  });

  return `${FATTUREINCLOUD_AUTH_URL}?${params.toString()}`;
}

/**
 * Scambia authorization code con access token
 */
export async function exchangeCodeForTokens(
  config: FattureInCloudConfig,
  code: string
): Promise<OAuthTokens> {
  try {
    const response = await axios.post<OAuthTokens>(
      FATTUREINCLOUD_TOKEN_URL,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("[FattureInCloud OAuth] Token exchange failed:", error);
    throw new Error("Failed to exchange authorization code for tokens");
  }
}

/**
 * Rinnova access token usando refresh token
 */
export async function refreshAccessToken(
  config: FattureInCloudConfig,
  refreshToken: string
): Promise<OAuthTokens> {
  try {
    const response = await axios.post<OAuthTokens>(
      FATTUREINCLOUD_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("[FattureInCloud OAuth] Token refresh failed:", error);
    throw new Error("Failed to refresh access token");
  }
}

/**
 * Verifica se il token è scaduto o sta per scadere
 */
export function isTokenExpired(expiresAt: Date): boolean {
  // Considera scaduto se mancano meno di 5 minuti
  const bufferTime = 5 * 60 * 1000; // 5 minuti in millisecondi
  return Date.now() >= expiresAt.getTime() - bufferTime;
}

/**
 * Effettua chiamata API autenticata a Fatture in Cloud
 */
export async function makeAuthenticatedRequest<T>(
  companyId: number,
  endpoint: string,
  accessToken: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  data?: any
): Promise<T> {
  try {
    const url = `${FATTUREINCLOUD_API_BASE}/${companyId}${endpoint}`;
    
    const response = await axios({
      method,
      url,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      data,
    });

    return response.data;
  } catch (error: any) {
    console.error("[FattureInCloud API] Request failed:", {
      endpoint,
      error: error.response?.data || error.message,
    });
    throw new Error(`API request failed: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Ottiene configurazione OAuth da variabili ambiente
 */
export function getOAuthConfig(): FattureInCloudConfig | null {
  const clientId = process.env.FATTUREINCLOUD_CLIENT_ID;
  const clientSecret = process.env.FATTUREINCLOUD_CLIENT_SECRET;
  const redirectUri = process.env.FATTUREINCLOUD_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.warn("[FattureInCloud OAuth] Missing configuration in environment variables");
    return null;
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}
