import { LOGIN_PATH } from "@/const";
import { supabase } from "@/lib/supabase";
import { trpc } from "@/lib/trpc";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export const AUTH_BOUNCE_REASON_KEY = "auth_bounce_reason";

const REDIRECT_GRACE_MS = 800;

type BounceReason = {
  at: string;
  from: string;
  cause: "no_session" | "no_app_user" | "me_query_error";
  detail?: string;
  hasSupabaseSession: boolean;
  supabaseUserId: string | null;
  supabaseEmail: string | null;
};

function recordBounce(reason: BounceReason) {
  try {
    sessionStorage.setItem(AUTH_BOUNCE_REASON_KEY, JSON.stringify(reason));
  } catch {
    // ignore (private mode etc.)
  }
  // Sempre loggato in console per chi guarda il devtools.
  console.error("[useAuth] Bouncing to login. Reason:", reason);
}

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = LOGIN_PATH } =
    options ?? {};
  const utils = trpc.useUtils();

  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setSessionLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
        // Una volta che lo state change arriva, possiamo sblocchare il loader
        // anche se il primo getSession() non era ancora tornato.
        setSessionLoading(false);
      },
    );

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const meQuery = trpc.auth.me.useQuery(undefined, {
    enabled: Boolean(session),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    utils.auth.me.setData(undefined, null);
    await utils.auth.me.invalidate();
    if (typeof window !== "undefined") {
      window.location.href = LOGIN_PATH;
    }
  }, [utils]);

  const state = useMemo(() => {
    const loading = sessionLoading || (Boolean(session) && meQuery.isLoading);
    return {
      session,
      user: meQuery.data ?? null,
      loading,
      error: meQuery.error ?? null,
      isAuthenticated: Boolean(session && meQuery.data),
    };
  }, [session, sessionLoading, meQuery.data, meQuery.error, meQuery.isLoading]);

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (state.loading) return;
    if (state.isAuthenticated) return;
    if (typeof window === "undefined") return;
    if (window.location.pathname === redirectPath) return;

    // Se abbiamo una sessione Supabase ma nessuna data da meQuery e la query
    // non è ancora finita, NON ribaltare: aspetta il successo o l'errore.
    if (session && meQuery.isFetching) return;

    let cause: BounceReason["cause"];
    let detail: string | undefined;
    if (!session) {
      cause = "no_session";
    } else if (meQuery.error) {
      cause = "me_query_error";
      detail = meQuery.error.message;
    } else {
      cause = "no_app_user";
      detail =
        "Sessione Supabase valida ma /api/trpc/auth.me ha restituito null. " +
        "Probabilmente manca la riga in public.users (trigger handle_new_user) " +
        "oppure il JWT_SECRET server non corrisponde a quello del progetto Supabase.";
    }

    const reason: BounceReason = {
      at: new Date().toISOString(),
      from: window.location.pathname + window.location.search,
      cause,
      detail,
      hasSupabaseSession: Boolean(session),
      supabaseUserId: session?.user.id ?? null,
      supabaseEmail: session?.user.email ?? null,
    };

    // Grace window per evitare bounce su transitorio (rete lenta, retry).
    const handle = window.setTimeout(() => {
      recordBounce(reason);
      window.location.href = redirectPath;
    }, REDIRECT_GRACE_MS);

    return () => window.clearTimeout(handle);
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    state.loading,
    state.isAuthenticated,
    session,
    meQuery.isFetching,
    meQuery.error,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
