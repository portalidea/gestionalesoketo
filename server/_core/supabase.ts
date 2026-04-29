/**
 * Client Supabase server-side con privilegi di service_role.
 *
 * Uso esclusivo per operazioni admin che il backend deve fare
 * "per conto del sistema": invitare utenti, gestire auth.users, ecc.
 * MAI esporre la service_role key al client.
 *
 * Per le query applicative usiamo Drizzle direttamente (vedi server/db.ts).
 */
import { createClient } from "@supabase/supabase-js";
import { ENV } from "./env";

export const supabaseAdmin = createClient(
  ENV.supabase.url,
  ENV.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);
