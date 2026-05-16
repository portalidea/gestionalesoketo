/**
 * Variabili d'ambiente lato server. Centralizza l'accesso a `process.env`
 * per documentare cosa serve e per fallire fast all'avvio se manca qualcosa
 * di critico.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const ENV = {
  databaseUrl: required("DATABASE_URL"),
  supabase: {
    url: required("SUPABASE_URL"),
    anonKey: required("SUPABASE_ANON_KEY"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    // jwtSecret rimosso: verifica JWT via JWKS pubblico ECDSA P-256
    // (vedi server/_core/context.ts). SUPABASE_JWT_SECRET nelle env vars
    // di Vercel può essere mantenuta per safety di rollback.
  },
  ownerEmail: optional("OWNER_EMAIL"),
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  resendApiKey: optional("RESEND_API_KEY"),
  /** M6.1.4: URL pubblico dell'app (dominio custom, no vercel/supabase) */
  publicAppUrl: optional("PUBLIC_APP_URL") ?? "https://gestionale.soketo.it",
  isProduction: process.env.NODE_ENV === "production",
  fattureInCloud: {
    clientId: optional("FATTUREINCLOUD_CLIENT_ID"),
    clientSecret: optional("FATTUREINCLOUD_CLIENT_SECRET"),
    redirectUri: optional("FATTUREINCLOUD_REDIRECT_URI"),
  },
};
