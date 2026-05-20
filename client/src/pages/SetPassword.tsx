/**
 * M10 — /set-password
 *
 * Pagina di atterraggio per utenti invitati (primo accesso).
 * L'utente arriva qui dal link di invito con una session temporanea.
 * Imposta la password e viene rediretto alla dashboard.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { PASSWORD_REQUIREMENTS, isPasswordValid } from "@/lib/passwordValidation";
import { Loader2, Eye, EyeOff, Check, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";

export default function SetPassword() {
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "submitting" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Check if we have a valid session (from the invite link)
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        setStatus("ready");
        return;
      }

      // Try to exchange the code from URL if present
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          setStatus("error");
          setErrorMessage("Link di invito scaduto o non valido. Contatta l'amministratore per un nuovo invito.");
        } else {
          setStatus("ready");
        }
      } else {
        // Check hash fragment
        const hash = window.location.hash;
        if (hash && hash.includes("access_token")) {
          setTimeout(async () => {
            const { data: { session: s } } = await supabase.auth.getSession();
            if (s) {
              setStatus("ready");
            } else {
              setStatus("error");
              setErrorMessage("Link di invito scaduto o non valido. Contatta l'amministratore per un nuovo invito.");
            }
          }, 1000);
        } else {
          setStatus("error");
          setErrorMessage("Link di invito scaduto o non valido. Contatta l'amministratore per un nuovo invito.");
        }
      }
    };
    checkSession();
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!isPasswordValid(password)) {
      setErrorMessage("La password non soddisfa tutti i requisiti.");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("Le password non coincidono.");
      return;
    }

    setStatus("submitting");

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setStatus("ready");
      setErrorMessage(error.message);
      return;
    }

    // Password set successfully — redirect to dashboard
    setLocation("/");
  };

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === "error" && !errorMessage?.includes("requisiti") && !errorMessage?.includes("coincidono")) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-8">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="text-destructive text-5xl">✕</div>
          <h1 className="text-xl font-semibold">Link non valido</h1>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <a
            href="/login"
            className="inline-block px-5 py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
          >
            Vai al login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Imposta la tua password</h1>
          <p className="text-sm text-muted-foreground">
            Benvenuto in SoKeto! Scegli una password per il tuo account.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border bg-card p-6">
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
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
              "Imposta password e accedi"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
