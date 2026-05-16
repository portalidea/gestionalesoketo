/**
 * M6.1.4 — /auth/verify
 *
 * Pagina di atterraggio per i magic link custom.
 * Riceve token_hash + type dalla query string, chiama supabase.auth.verifyOtp,
 * e redirige l'utente alla dashboard appropriata in base al ruolo.
 *
 * NON protetta da RequireRole (l'utente non è ancora autenticato).
 */
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { supabase } from "@/lib/supabase";

export default function AuthVerify() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(search);
    const tokenHash = params.get("token_hash");
    const type = params.get("type") as "invite" | "magiclink" | "recovery" | "email" | null;

    if (!tokenHash || !type) {
      setStatus("error");
      setErrorMsg("Link non valido o incompleto.");
      return;
    }

    (async () => {
      try {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: type === "invite" ? "invite" : type === "recovery" ? "recovery" : "magiclink",
        });

        if (error) {
          setStatus("error");
          if (error.message.includes("expired") || error.message.includes("Token")) {
            setErrorMsg("Il link è scaduto. Richiedi un nuovo invito all'amministratore.");
          } else if (error.message.includes("already") || error.message.includes("used")) {
            setErrorMsg("Questo link è già stato utilizzato. Prova ad accedere normalmente.");
          } else {
            console.error("[AuthVerify] verifyOtp error:", error.message);
            setErrorMsg("Verifica fallita. Contatta il supporto.");
          }
          return;
        }

        // Sessione attiva. Determina redirect basato su role
        setStatus("success");
        const { data: { user } } = await supabase.auth.getUser();
        const role = user?.user_metadata?.role || user?.app_metadata?.role || "";

        // Piccolo delay per mostrare il successo
        setTimeout(() => {
          if (role.startsWith("retailer_")) {
            setLocation("/partner-portal/dashboard");
          } else {
            setLocation("/");
          }
        }, 800);
      } catch (err) {
        console.error("[AuthVerify] unexpected error:", err);
        setStatus("error");
        setErrorMsg("Errore imprevisto. Riprova o contatta il supporto.");
      }
    })();
  }, [search, setLocation]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-green-100">
      <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full text-center">
        {status === "verifying" && (
          <>
            <div className="animate-spin h-10 w-10 border-4 border-green-600 border-t-transparent rounded-full mx-auto mb-5" />
            <h1 className="text-xl font-semibold text-gray-900">Verifica in corso…</h1>
            <p className="text-gray-600 mt-2">Stai per accedere al portale SoKeto.</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="text-green-600 text-5xl mb-4">✓</div>
            <h1 className="text-xl font-semibold text-gray-900">Accesso confermato!</h1>
            <p className="text-gray-600 mt-2">Redirect in corso…</p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="text-red-500 text-5xl mb-4">✕</div>
            <h1 className="text-xl font-semibold text-gray-900">Accesso non riuscito</h1>
            <p className="text-gray-600 mt-3">{errorMsg}</p>
            <a
              href="/login"
              className="inline-block mt-6 px-5 py-2.5 bg-green-700 text-white rounded-lg font-medium hover:bg-green-800 transition-colors"
            >
              Torna al login
            </a>
          </>
        )}
      </div>
    </div>
  );
}
