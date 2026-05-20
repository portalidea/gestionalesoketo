/**
 * M10 — /reset-password
 *
 * Pagina di atterraggio dal link "reset password" inviato via email.
 * Usa onAuthStateChange per intercettare l'evento PASSWORD_RECOVERY,
 * che è il modo robusto di gestire il reset con Supabase PKCE.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { PASSWORD_REQUIREMENTS, isPasswordValid } from "@/lib/passwordValidation";
import { Loader2, Eye, EyeOff, Check, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "wouter";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "submitting" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const resolved = useRef(false);

  useEffect(() => {
    // Supabase emette PASSWORD_RECOVERY quando il link reset viene processato
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (resolved.current) return;
      if (event === "PASSWORD_RECOVERY" && session) {
        resolved.current = true;
        setSessionReady(true);
        setStatus("ready");
      } else if (event === "SIGNED_IN" && session) {
        // Alcuni flussi emettono SIGNED_IN invece di PASSWORD_RECOVERY
        resolved.current = true;
        setSessionReady(true);
        setStatus("ready");
      }
    });

    // Fallback: controlla se c'è già una sessione
    // (caso detectSessionInUrl ha già fatto il lavoro prima del mount)
    const checkExisting = async () => {
      // Dai tempo a detectSessionInUrl di processare l'URL
      await new Promise((r) => setTimeout(r, 1500));
      if (resolved.current) return;

      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        resolved.current = true;
        setSessionReady(true);
        setStatus("ready");
      } else {
        // Ultimo tentativo: se c'è ?code= nell'URL, proviamo exchangeCodeForSession
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (!error) {
            resolved.current = true;
            setSessionReady(true);
            setStatus("ready");
            return;
          }
        }
        // Nessuna sessione e nessun evento recovery → link non valido
        if (!resolved.current) {
          setStatus("error");
          setErrorMessage("Link scaduto o non valido. Richiedi un nuovo link di reset.");
        }
      }
    };
    checkExisting();

    return () => subscription.unsubscribe();
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!sessionReady) {
      setErrorMessage("Sessione non pronta. Ricarica la pagina dal link email.");
      return;
    }
    if (!isPasswordValid(password)) {
      setErrorMessage("La password non soddisfa tutti i requisiti.");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("Le password non coincidono.");
      return;
    }

    setStatus("submitting");

    // Verifica: la sessione deve essere attiva PRIMA di updateUser
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setStatus("error");
      setErrorMessage("Sessione scaduta. Richiedi un nuovo link di reset.");
      return;
    }

    const { data, error } = await supabase.auth.updateUser({ password });

    if (error) {
      setStatus("ready");
      if (error.message.toLowerCase().includes("same")) {
        setErrorMessage("La nuova password deve essere diversa dalla precedente.");
      } else {
        setErrorMessage(error.message);
      }
      return;
    }

    // Verifica che updateUser abbia restituito l'utente aggiornato
    if (!data?.user) {
      setStatus("error");
      setErrorMessage("Aggiornamento password non confermato. Riprova.");
      return;
    }

    console.log("[ResetPassword] password updated for user:", data.user.email);

    // Logout e redirect
    await supabase.auth.signOut();
    setLocation("/login?reason=password_updated");
  };

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === "error" && !errorMessage?.includes("requisiti") && !errorMessage?.includes("coincidono") && !errorMessage?.includes("diversa")) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-8">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="text-destructive text-5xl">✕</div>
          <h1 className="text-xl font-semibold">Link non valido</h1>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <a
            href="/forgot-password"
            className="inline-block px-5 py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
          >
            Richiedi nuovo link
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Reimposta password</h1>
          <p className="text-sm text-muted-foreground">
            Scegli una nuova password per il tuo account.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border bg-card p-6">
          <div className="space-y-2">
            <Label htmlFor="password">Nuova password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={status === "submitting"}
                className="pr-10"
              />
              <button
                type="button"
                tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Nascondi" : "Mostra"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Password requirements checklist */}
          {password.length > 0 && (
            <ul className="space-y-1 text-sm">
              {PASSWORD_REQUIREMENTS.map((req) => {
                const met = req.test(password);
                return (
                  <li key={req.label} className={`flex items-center gap-2 ${met ? "text-emerald-600" : "text-muted-foreground"}`}>
                    {met ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                    {req.label}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Conferma password</Label>
            <Input
              id="confirmPassword"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              disabled={status === "submitting"}
            />
            {confirmPassword.length > 0 && password !== confirmPassword && (
              <p className="text-xs text-destructive">Le password non coincidono</p>
            )}
          </div>

          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={
              status === "submitting" ||
              !isPasswordValid(password) ||
              password !== confirmPassword
            }
          >
            {status === "submitting" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Salva nuova password"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
