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

      const errorDescription =
        url.searchParams.get("error_description") ??
        hashParams.get("error_description");
      if (errorDescription) {
        console.error("[Auth callback]", errorDescription);
        if (!cancelled) setError(errorDescription);
        return;
      }

      const code = url.searchParams.get("code");
      if (code) {
        const { data, error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code);
        if (cancelled) return;
        if (exchangeError) {
          console.error("[Auth callback] exchange failed:", exchangeError);
          setError(exchangeError.message);
          return;
        }
        if (!data.session) {
          console.error("[Auth callback] exchange returned no session");
          setError("Sessione non disponibile");
          return;
        }
        window.location.replace("/");
        return;
      }

      // Fallback: legacy hash flow con access_token nel fragment.
      if (hashParams.get("access_token")) {
        for (let i = 0; i < 20; i++) {
          const { data } = await supabase.auth.getSession();
          if (cancelled) return;
          if (data.session) {
            window.location.replace("/");
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        console.error("[Auth callback] hash flow: session not picked up");
        setError("Login non riuscito");
        return;
      }

      console.error("[Auth callback] no code/access_token/error in URL");
      setError("Parametri di login mancanti");
    };

    run().catch((err) => {
      if (cancelled) return;
      console.error("[Auth callback] unexpected:", err);
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => {
      window.location.replace("/login?reason=callback_error");
    }, 600);
    return () => window.clearTimeout(t);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">
          {error
            ? "Login non riuscito, ti rimando alla pagina di accesso…"
            : "Accesso in corso…"}
        </span>
      </div>
    </div>
  );
}
