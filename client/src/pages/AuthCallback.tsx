import { supabase } from "@/lib/supabase";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export default function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const finalize = async () => {
      // Supabase JS con detectSessionInUrl + flowType pkce gestisce
      // automaticamente l'exchange. Aspettiamo che venga creata la sessione.
      const url = new URL(window.location.href);
      const errorDescription = url.searchParams.get("error_description");
      if (errorDescription) {
        if (!cancelled) setError(errorDescription);
        return;
      }

      // Polling breve in caso il listener async non abbia ancora completato.
      for (let attempt = 0; attempt < 20; attempt++) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          if (!cancelled) {
            window.location.replace("/");
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!cancelled) setError("Sessione non ottenuta. Riprova dal link nell'email.");
    };

    finalize();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      {error ? (
        <div className="max-w-md text-center space-y-4 px-6">
          <h1 className="text-lg font-medium">Login non riuscito</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
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
