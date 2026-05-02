import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plug,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function Integrations() {
  const { user: me } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const { data: status, isLoading: statusLoading } =
    trpc.ficIntegration.getStatus.useQuery();
  const { data: clientsData } = trpc.ficClients.list.useQuery(undefined, {
    enabled: !!status?.connected,
    retry: false,
  });

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<"normal" | "force" | null>(null);

  const disconnectMut = trpc.ficIntegration.disconnect.useMutation({
    onSuccess: (res) => {
      utils.ficIntegration.getStatus.invalidate();
      utils.ficClients.list.invalidate();
      setDisconnectOpen(false);
      // M3.0.4: marca timestamp post-disconnect così il prossimo "Connetti"
      // forza prompt=login automaticamente (evita che FiC riusi cookie
      // sessione e auto-selezioni la stessa azienda). TTL 24h: dopo, il
      // flag scade e il connect torna fluido. Cleared dopo connect success.
      try {
        localStorage.setItem("fic_just_disconnected_at", String(Date.now()));
      } catch {}
      toast.success(
        `Fatture in Cloud disconnesso (${res.deleted} riga rimossa dal DB)`,
      );
    },
    onError: (e) => toast.error(e.message),
  });

  const refreshMut = trpc.ficClients.refresh.useMutation({
    onSuccess: (data) => {
      utils.ficClients.list.invalidate();
      toast.success(`Aggiornati ${data.clients.length} clienti FiC`);
    },
    onError: (e) => toast.error(e.message),
  });

  // Listen for OAuth popup success → refetch status
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "fic_sso_success") {
        utils.ficIntegration.getStatus.invalidate();
        utils.ficClients.list.invalidate();
        // M3.0.4: pulisci flag post-disconnect dopo connect riuscito
        try {
          localStorage.removeItem("fic_just_disconnected_at");
        } catch {}
        toast.success("Fatture in Cloud connesso");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [utils]);

  // M3.0.4: se l'utente ha disconnesso negli ultimi 24h, il prossimo
  // "Connetti" forza prompt=login per evitare auto-rilascio della stessa
  // azienda da parte di FiC via cookie sessione browser.
  function shouldAutoForceLogin(): boolean {
    try {
      const ts = localStorage.getItem("fic_just_disconnected_at");
      if (!ts) return false;
      const age = Date.now() - parseInt(ts, 10);
      if (age < 0 || age > 24 * 60 * 60 * 1000) return false;
      return true;
    } catch {
      return false;
    }
  }

  if (me && me.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <p className="text-muted-foreground">Accesso riservato agli amministratori.</p>
        </div>
      </DashboardLayout>
    );
  }

  async function handleConnect(explicitForceLogin?: boolean) {
    // explicitForceLogin precedence: bottoni espliciti scelgono.
    // Default (undefined): auto-derivato dal flag post-disconnect.
    const forceLogin =
      explicitForceLogin !== undefined ? explicitForceLogin : shouldAutoForceLogin();
    setOauthLoading(forceLogin ? "force" : "normal");
    try {
      const r = await utils.ficIntegration.startOAuth.fetch({ forceLogin });
      if (r?.url) {
        window.open(r.url, "fic-oauth", "width=600,height=700");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Errore avvio OAuth");
    } finally {
      setOauthLoading(null);
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">Integrazioni</h1>
          <p className="text-muted-foreground">Connessioni a servizi esterni di sistema.</p>
        </div>

        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Plug className="h-6 w-6 text-primary" />
              <div className="flex-1">
                <CardTitle>Fatture in Cloud</CardTitle>
                <CardDescription>
                  Integrazione single-tenant. L'account E-Keto Food Srls è connesso una sola
                  volta; tutti i retailer vengono mappati come clienti FiC e ricevono proforma
                  da questo account.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {statusLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Verifica stato connessione…</span>
              </div>
            ) : !status?.configured ? (
              <div className="flex items-center gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm">
                <AlertCircle className="h-5 w-5 shrink-0 text-yellow-500" />
                <span>
                  OAuth FiC non configurato. Variabili ambiente mancanti su Vercel:
                  <code className="ml-1 font-mono text-xs">FATTUREINCLOUD_CLIENT_ID</code>,
                  <code className="ml-1 font-mono text-xs">FATTUREINCLOUD_CLIENT_SECRET</code>,
                  <code className="ml-1 font-mono text-xs">FATTUREINCLOUD_REDIRECT_URI</code>.
                </span>
              </div>
            ) : !status.connected ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <span>Non connesso. Avvia il flusso OAuth con FiC per autorizzare l'app.</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => handleConnect(false)}
                    disabled={oauthLoading !== null}
                  >
                    {oauthLoading === "normal" ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Plug className="h-4 w-4 mr-2" />
                    )}
                    Connetti Fatture in Cloud
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleConnect(true)}
                    disabled={oauthLoading !== null}
                    title="Forza la schermata di login FiC: utile se hai più aziende e vuoi sceglierne una diversa da quella memorizzata nella sessione browser FiC."
                  >
                    {oauthLoading === "force" ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    Hai più aziende? Connetti con scelta azienda
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground max-w-2xl">
                  Nota: FiC ricorda l'azienda selezionata nella sessione browser. Se hai
                  più aziende collegate al tuo account FiC e vuoi cambiare,
                  usa "Connetti con scelta azienda" oppure prima esegui logout su{" "}
                  <a
                    href="https://secure.fattureincloud.it/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    secure.fattureincloud.it
                  </a>
                  .
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500 mt-0.5" />
                  <div className="space-y-1">
                    <div className="font-medium text-foreground">
                      Connesso — {status.companyName ?? "?"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Company ID FiC: <span className="font-mono">{status.companyId ?? "?"}</span>
                      {status.expiresAt && (
                        <span className="ml-3">
                          Token scade:{" "}
                          {new Date(status.expiresAt).toLocaleString("it-IT", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </span>
                      )}
                      {status.expired && (
                        <Badge className="ml-2 bg-orange-500 hover:bg-orange-600">
                          Scaduto — sarà rinfrescato al primo uso
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => refreshMut.mutate()}
                    disabled={refreshMut.isPending}
                  >
                    {refreshMut.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Aggiorna lista clienti FiC
                  </Button>
                  <Button variant="destructive" onClick={() => setDisconnectOpen(true)}>
                    <Unplug className="h-4 w-4 mr-2" />
                    Disconnetti
                  </Button>
                  {clientsData && (
                    <span className="text-xs text-muted-foreground ml-2">
                      {clientsData.clients.length} clienti in cache
                      {clientsData.refreshedAt && (
                        <>
                          {" "}
                          · ultimo refresh{" "}
                          {new Date(clientsData.refreshedAt).toLocaleString("it-IT", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </>
                      )}
                    </span>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnettere Fatture in Cloud?</AlertDialogTitle>
              <AlertDialogDescription>
                I token verranno cancellati. La generazione proforma su TRANSFER si bloccherà
                finché non riconnetti l'account. I mapping retailer → cliente FiC restano
                preservati, ma non saranno utilizzabili senza connessione.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => disconnectMut.mutate()}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Disconnetti
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
