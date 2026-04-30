import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { Loader2, Mail } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

const REASON_MESSAGES: Record<string, string> = {
  expired: "Sessione scaduta. Accedi di nuovo.",
  no_profile:
    "Account non riconosciuto. Contatta l'amministratore per ricevere un invito.",
  me_error: "Errore di connessione al server. Riprova.",
  callback_error: "Login non riuscito. Riprova.",
};

export default function Login() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bounceMessage, setBounceMessage] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("reason");
    if (reason && REASON_MESSAGES[reason]) {
      setBounceMessage(REASON_MESSAGES[reason]);
      // Pulisci il query param così un reload non rimostra il messaggio.
      const clean = new URL(window.location.href);
      clean.searchParams.delete("reason");
      window.history.replaceState({}, "", clean.toString());
    }
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }
    setStatus("sent");
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        {bounceMessage && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-center text-sm text-destructive">
            {bounceMessage}
          </div>
        )}

        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">SoKeto Gestionale</h1>
          <p className="text-sm text-muted-foreground">
            Accedi con il tuo indirizzo email. Ti invieremo un link magico per il login.
          </p>
        </div>

        {status === "sent" ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center space-y-4">
            <Mail className="mx-auto h-10 w-10 text-primary" />
            <h2 className="text-lg font-medium">Controlla la tua email</h2>
            <p className="text-sm text-muted-foreground">
              Abbiamo inviato un link di accesso a <strong>{email}</strong>. Apri
              l'email e clicca sul link per entrare.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("idle");
                setEmail("");
              }}
            >
              Usa un'altra email
            </Button>
          </div>
        ) : (
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

            {errorMessage ? (
              <p className="text-sm text-destructive">{errorMessage}</p>
            ) : null}

            <Button type="submit" className="w-full" disabled={status === "submitting"}>
              {status === "submitting" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Invia link di accesso"
              )}
            </Button>
          </form>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Solo per operatori SoKeto autorizzati.
        </p>
      </div>
    </div>
  );
}
