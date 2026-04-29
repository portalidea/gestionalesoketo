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
    jwtSecret: required("SUPABASE_JWT_SECRET"),
  },
  ownerEmail: optional("OWNER_EMAIL"),
  isProduction: process.env.NODE_ENV === "production",
  fattureInCloud: {
    clientId: optional("FATTUREINCLOUD_CLIENT_ID"),
    clientSecret: optional("FATTUREINCLOUD_CLIENT_SECRET"),
    redirectUri: optional("FATTUREINCLOUD_REDIRECT_URI"),
  },
};
