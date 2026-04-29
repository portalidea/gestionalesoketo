import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Disabilitato: l'auto-detection consuma `?code=` al primo import del
    // client (prima che AuthCallback monti) e rimuove la query string,
    // quindi se fallisce non lascia tracce. Lo gestiamo esplicitamente in
    // pages/AuthCallback.tsx con exchangeCodeForSession.
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});
