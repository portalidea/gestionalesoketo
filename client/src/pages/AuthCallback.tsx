import { supabase } from "@/lib/supabase";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export default function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const url = new URL(window.location.href);
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));

      // 1. Errore esplicito da Supabase (in query o nel fragment).
      const errorDescription =
        url.searchParams.get("error_description") ??
        hashParams.get("error_description");
      if (errorDescription) {
        console.error("[Auth callback] Supabase returned error:", {
          error: url.searchParams.get("error") ?? hashParams.get("error"),
          error_description: errorDescription,
          full_url: window.location.href,
        });
        if (!cancelled) setError(errorDescription);
        return;
      }

      // 2. PKCE flow (default per signInWithOtp): ?code=xxx in query.
      const code = url.searchParams.get("code");
      if (code) {
        console.log("[Auth callback] Exchanging PKCE code for session…");
        const { data, error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          console.error("[Auth callback] exchangeCodeForSession failed:", {
            message: exchangeError.message,
            status: (exchangeError as { status?: number }).status,
            name: exchangeError.name,
            full: exchangeError,
          });
          if (!cancelled) setError(exchangeError.message);
          return;
        }
        if (!data.session) {
          console.error("[Auth callback] No session returned after exchange.");
          if (!cancelled) setError("Sessione non creata dopo lo scambio del codice.");
          return;
        }
        if (!cancelled) {
          console.log("[Auth callback] Session established, redirecting /");
          window.location.replace("/");
        }
        return;
      }

      // 3. Implicit / hash flow: #access_token=xxx (es. recovery flow vecchio).
      if (hashParams.get("access_token")) {
        console.log("[Auth callback] Hash-based session, waiting for SDK to pick it up");
        for (let attempt = 0; attempt < 20; attempt++) {
          const { data } = await supabase.auth.getSession();
          if (data.session) {
            if (!cancelled) window.location.replace("/");
            return;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        if (!cancelled) {
          setError("Sessione non ottenuta dal token nel fragment URL.");
        }
        return;
      }

      // 4. Nessun parametro utile.
      console.error("[Auth callback] No code or token in URL:", window.location.href);
      if (!cancelled) {
        setError(
          "Nessun codice di autenticazione trovato nell'URL. Apri il link più recente dall'email.",
        );
      }
    };

    run().catch((err) => {
      console.error("[Auth callback] unexpected error:", err);
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      {error ? (
        <div className="max-w-md text-center space-y-4 px-6">
          <h1 className="text-lg font-medium">Login non riuscito</h1>
          <p className="text-sm text-muted-foreground break-words">{error}</p>
          <a href="/login" className="text-sm text-primary underline">
            Torna alla pagina di login
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Accesso in corso…</span>
        </div>
      )}
    </div>
  );
}
