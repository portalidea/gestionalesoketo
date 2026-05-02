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
  ExternalLink,
  Info,
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
      toast.success(
        `Fatture in Cloud disconnesso (${res.deleted} riga rimossa dal DB). Per connettere ad altra azienda, prima cambia azienda su Fatture in Cloud, poi clicca Connetti.`,
        { duration: 8000 },
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
        toast.success("Fatture in Cloud connesso");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [utils]);

  if (me && me.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <p className="text-muted-foreground">Accesso riservato agli amministratori.</p>
        </div>
      </DashboardLayout>
    );
  }

  async function handleConnect(forceLogin = false) {
    // M3.0.5: prompt=login NON è onorato da FiC (testato empiricamente:
    // selettore appare 1s e poi auto-submit con la company precedente).
    // Il workaround vero è cambiare azienda su secure.fattureincloud.it
    // prima del Connect — vedi info-box. Il flag forceLogin resta
    // wired (bottone "Forza re-login" come edge case) ma non è
    // più la soluzione primaria.
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

                {/* M3.0.5: info-box workaround multi-azienda. FiC non onora
                    prompt=login (verificato empiricamente), unica strada
                    affidabile è cambiare azienda PRIMA del connect. */}
                <div className="rounded-md border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm space-y-3">
                  <div className="flex items-start gap-3">
                    <Info className="h-5 w-5 shrink-0 text-blue-400 mt-0.5" />
                    <div className="space-y-2 flex-1">
                      <div className="font-medium text-foreground">
                        Hai più aziende su Fatture in Cloud?
                      </div>
                      <p className="text-muted-foreground">
                        OAuth FiC autorizza sempre l'<strong>azienda attualmente
                        attiva</strong> nella tua sessione browser FiC. Per connettere
                        un'azienda diversa:
                      </p>
                      <ol className="list-decimal list-inside text-muted-foreground space-y-1 pl-1">
                        <li>
                          Apri Fatture in Cloud in una nuova scheda (link sotto).
                        </li>
                        <li>
                          Cambia all'azienda da connettere col selettore in alto a destra.
                        </li>
                        <li>
                          Torna qui e clicca <strong>Connetti Fatture in Cloud</strong>.
                        </li>
                      </ol>
                      <a
                        href="https://secure.fattureincloud.it/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 underline mt-1"
                      >
                        Apri Fatture in Cloud
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
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
                    title="Edge case: prova a forzare prompt=login. FiC tipicamente lo ignora — usa il workaround dell'info-box sopra."
                  >
                    {oauthLoading === "force" ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    Forza re-login (edge case)
                  </Button>
                </div>
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
