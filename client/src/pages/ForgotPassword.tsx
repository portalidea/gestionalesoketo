import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { Loader2, Mail, ArrowLeft } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      setStatus("error");
      if (
        error.message.toLowerCase().includes("not found") ||
        error.message.toLowerCase().includes("user not found")
      ) {
        setErrorMessage(
          "Email non riconosciuta. Verifica l'indirizzo o contatta l'amministratore.",
        );
      } else if (error.message.toLowerCase().includes("rate")) {
        setErrorMessage("Troppe richieste. Attendi qualche minuto prima di riprovare.");
      } else {
        setErrorMessage(error.message);
      }
      return;
    }
    setStatus("sent");
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Password dimenticata</h1>
          <p className="text-sm text-muted-foreground">
            Inserisci la tua email e ti invieremo un link per reimpostare la password.
          </p>
        </div>

        {status === "sent" ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center space-y-4">
            <Mail className="mx-auto h-10 w-10 text-primary" />
            <h2 className="text-lg font-medium">Controlla la tua email</h2>
            <p className="text-sm text-muted-foreground">
              Abbiamo inviato un link per reimpostare la password a{" "}
              <strong>{email}</strong>. Apri l'email e clicca sul link.
            </p>
            <p className="text-xs text-muted-foreground">
              Non trovi l'email? Controlla la cartella spam.
            </p>
            <Link href="/login">
              <Button variant="outline" size="sm" className="mt-2">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Torna al login
              </Button>
            </Link>
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
                "Invia link di reset"
              )}
            </Button>

            <div className="text-center">
              <Link
                href="/login"
                className="text-sm text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
              >
                <ArrowLeft className="inline h-3 w-3 mr-1" />
                Torna al login
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
