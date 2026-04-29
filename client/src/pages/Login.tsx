import { AUTH_BOUNCE_REASON_KEY } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { Loader2, Mail } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

type BounceReason = {
  at: string;
  from: string;
  cause: "no_session" | "no_app_user" | "me_query_error";
  detail?: string;
  hasSupabaseSession: boolean;
  supabaseUserId: string | null;
  supabaseEmail: string | null;
};

export default function Login() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bounceReason, setBounceReason] = useState<BounceReason | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(AUTH_BOUNCE_REASON_KEY);
      if (raw) {
        setBounceReason(JSON.parse(raw) as BounceReason);
        sessionStorage.removeItem(AUTH_BOUNCE_REASON_KEY);
      }
    } catch {
      // ignore
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

  const causeLabel: Record<BounceReason["cause"], string> = {
    no_session: "Nessuna sessione Supabase trovata.",
    no_app_user:
      "Sessione Supabase valida ma utente non presente in public.users.",
    me_query_error: "Errore nella chiamata /api/trpc/auth.me.",
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        {bounceReason && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-left font-mono text-xs space-y-2">
            <p className="font-semibold text-destructive">
              Sei stato rimandato al login.
            </p>
            <p className="text-foreground">{causeLabel[bounceReason.cause]}</p>
            {bounceReason.detail && (
              <p className="text-muted-foreground break-words">
                {bounceReason.detail}
              </p>
            )}
            <div className="text-muted-foreground space-y-0.5 pt-1 border-t border-destructive/30">
              <div>
                <span className="opacity-70">at:</span> {bounceReason.at}
              </div>
              <div>
                <span className="opacity-70">from:</span>{" "}
                <span className="break-all">{bounceReason.from}</span>
              </div>
              <div>
                <span className="opacity-70">supabase session:</span>{" "}
                {bounceReason.hasSupabaseSession ? "yes" : "no"}
              </div>
              {bounceReason.supabaseUserId && (
                <div className="break-all">
                  <span className="opacity-70">user.id:</span>{" "}
                  {bounceReason.supabaseUserId}
                </div>
              )}
              {bounceReason.supabaseEmail && (
                <div className="break-all">
                  <span className="opacity-70">email:</span>{" "}
                  {bounceReason.supabaseEmail}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">SoKeto Inventory</h1>
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
