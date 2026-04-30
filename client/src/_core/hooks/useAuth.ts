import { LOGIN_PATH } from "@/const";
import { supabase } from "@/lib/supabase";
import { trpc } from "@/lib/trpc";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

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
    // Stato transitorio: sessione presente ma meQuery non ancora risolta.
    if (session && meQuery.isFetching) return;

    const reason = !session
      ? "expired"
      : meQuery.error
        ? "me_error"
        : "no_profile";
    console.warn(`[useAuth] redirecting to ${redirectPath} (${reason})`);
    window.location.href = `${redirectPath}?reason=${reason}`;
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
