import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "wouter";

const REASON_MESSAGES: Record<string, string> = {
  expired: "Sessione scaduta. Accedi di nuovo.",
  no_profile:
    "Account non riconosciuto. Contatta l'amministratore per ricevere un invito.",
  me_error: "Errore di connessione al server. Riprova.",
  callback_error: "Login non riuscito. Riprova.",
  password_updated: "Password aggiornata con successo. Accedi con le nuove credenziali.",
};

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bounceMessage, setBounceMessage] = useState<string | null>(null);
  const [bounceType, setBounceType] = useState<"error" | "success">("error");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("reason");
    if (reason && REASON_MESSAGES[reason]) {
      setBounceMessage(REASON_MESSAGES[reason]);
      setBounceType(reason === "password_updated" ? "success" : "error");
      const clean = new URL(window.location.href);
      clean.searchParams.delete("reason");
      window.history.replaceState({}, "", clean.toString());
    }
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setStatus("error");
      if (
        error.message.toLowerCase().includes("invalid login credentials") ||
        error.message.toLowerCase().includes("invalid_credentials")
      ) {
        setErrorMessage("Email o password non corretti.");
      } else if (
        error.message.toLowerCase().includes("email not confirmed")
      ) {
        setErrorMessage("Email non confermata. Controlla la tua casella di posta.");
      } else if (
        error.message.toLowerCase().includes("not found") ||
        error.message.toLowerCase().includes("signups not allowed")
      ) {
        setErrorMessage(
          "Email non riconosciuta. Contatta l'amministratore per ricevere un invito di accesso.",
        );
      } else {
        setErrorMessage(error.message);
      }
      return;
    }

    // Success — redirect will be handled by auth state listener
    window.location.href = "/";
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        {bounceMessage && (
          <div
            className={`rounded-md border p-3 text-center text-sm ${
              bounceType === "success"
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            {bounceMessage}
          </div>
        )}

        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">SoKeto Gestionale</h1>
          <p className="text-sm text-muted-foreground">
            Accedi con le tue credenziali.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border bg-card p-6">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tuo@indirizzo.it"
              disabled={status === "submitting"}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
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
                aria-label={showPassword ? "Nascondi password" : "Mostra password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}

          <Button type="submit" className="w-full" disabled={status === "submitting"}>
            {status === "submitting" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Accedi"
            )}
          </Button>

          <div className="text-center">
            <Link
              href="/forgot-password"
              className="text-sm text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
            >
              Password dimenticata?
            </Link>
          </div>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          Solo per operatori SoKeto autorizzati.
        </p>
      </div>
    </div>
  );
}
