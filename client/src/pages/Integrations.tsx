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
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * M11.C — Integrations page: dual FiC connection per company.
 * Shows one card per company with independent OAuth connect/disconnect,
 * plus a "Sync Retailer Mapping" button per company.
 */
export default function Integrations() {
  const { user: me } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();

  // M11.C: list all company connections
  const { data: connections, isLoading: connectionsLoading } =
    trpc.ficIntegration.listConnections.useQuery();

  const [disconnectTarget, setDisconnectTarget] = useState<{
    companyId: string;
    companyName: string;
  } | null>(null);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [syncLoading, setSyncLoading] = useState<string | null>(null);

  const disconnectMut = trpc.ficIntegration.disconnectForCompany.useMutation({
    onSuccess: () => {
      utils.ficIntegration.listConnections.invalidate();
      setDisconnectTarget(null);
      toast.success("Fatture in Cloud disconnesso per questa azienda.");
    },
    onError: (e) => toast.error(e.message),
  });

  const syncMappingsMut = trpc.ficIntegration.syncRetailerMappings.useMutation({
    onSuccess: (data) => {
      setSyncLoading(null);
      toast.success(
        `Mapping sincronizzato: ${data.mapped} abbinati, ${data.unmatched.length} non trovati.`,
      );
    },
    onError: (e) => {
      setSyncLoading(null);
      toast.error(e.message);
    },
  });

  // Listen for OAuth popup success → refetch
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "fic_sso_success") {
        utils.ficIntegration.listConnections.invalidate();
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

  async function handleConnect(companyId: string, forceLogin = false) {
    setOauthLoading(companyId);
    try {
      const r = await utils.ficIntegration.startOAuthForCompany.fetch({
        companyId,
        forceLogin,
      });
      if (r?.url) {
        window.open(r.url, "fic-oauth", "width=600,height=700");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Errore avvio OAuth");
    } finally {
      setOauthLoading(null);
    }
  }

  function handleSyncMappings(companyId: string) {
    setSyncLoading(companyId);
    syncMappingsMut.mutate({ companyId });
  }

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">Integrazioni</h1>
          <p className="text-muted-foreground">
            Connessioni Fatture in Cloud per-azienda. Ogni azienda ha la propria connessione
            OAuth indipendente e il proprio mapping retailer → clienti FiC.
          </p>
        </div>

        {connectionsLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Caricamento stato connessioni…</span>
          </div>
        ) : (
          <div className="grid gap-6">
            {connections?.map((conn) => (
              <CompanyFicCard
                key={conn.companyId}
                companyId={conn.companyId}
                companyName={conn.companyName}
                configured={conn.configured}
                connected={conn.connected}
                companyFicName={conn.companyName}
                ficCompanyId={conn.companyId}
                expiresAt={conn.tokenExpiresAt}
                expired={conn.expired}
                oauthLoading={oauthLoading === conn.companyId}
                syncLoading={syncLoading === conn.companyId}
                onConnect={(force) => handleConnect(conn.companyId, force)}
                onDisconnect={() =>
                  setDisconnectTarget({
                    companyId: conn.companyId,
                    companyName: conn.companyName,
                  })
                }
                onSyncMappings={() => handleSyncMappings(conn.companyId)}
              />
            ))}
          </div>
        )}

        {/* Info box: workaround multi-azienda FiC */}
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3 text-sm">
              <Info className="h-5 w-5 shrink-0 text-blue-400 mt-0.5" />
              <div className="space-y-2 flex-1">
                <div className="font-medium text-foreground">
                  Come funziona il flusso OAuth per-azienda
                </div>
                <p className="text-muted-foreground">
                  OAuth FiC autorizza sempre l'<strong>azienda attualmente attiva</strong> nella
                  tua sessione browser FiC. Per connettere un'azienda diversa:
                </p>
                <ol className="list-decimal list-inside text-muted-foreground space-y-1 pl-1">
                  <li>
                    Apri Fatture in Cloud in una nuova scheda.
                  </li>
                  <li>
                    Cambia all'azienda da connettere col selettore in alto a destra.
                  </li>
                  <li>
                    Torna qui e clicca <strong>Connetti</strong> sulla card corrispondente.
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
          </CardContent>
        </Card>

        {/* Disconnect confirmation dialog */}
        <AlertDialog
          open={!!disconnectTarget}
          onOpenChange={(open) => !open && setDisconnectTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Disconnettere FiC per {disconnectTarget?.companyName}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                I token verranno cancellati. La generazione proforma si bloccherà finché non
                riconnetti. I mapping retailer → cliente FiC restano preservati.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  disconnectTarget &&
                  disconnectMut.mutate({ companyId: disconnectTarget.companyId })
                }
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

// --- Sub-component: Company FiC Card ---

interface CompanyFicCardProps {
  companyId: string;
  companyName: string;
  configured: boolean;
  connected: boolean;
  companyFicName?: string;
  ficCompanyId?: string;
  expiresAt?: string | null;
  expired?: boolean;
  oauthLoading: boolean;
  syncLoading: boolean;
  onConnect: (forceLogin?: boolean) => void;
  onDisconnect: () => void;
  onSyncMappings: () => void;
}

function CompanyFicCard({
  companyName,
  configured,
  connected,
  expiresAt,
  expired,
  oauthLoading,
  syncLoading,
  onConnect,
  onDisconnect,
  onSyncMappings,
}: CompanyFicCardProps) {
  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <div className="flex items-center gap-3">
          <Plug className="h-6 w-6 text-primary" />
          <div className="flex-1">
            <CardTitle className="flex items-center gap-2">
              {companyName}
              {connected ? (
                <Badge className="bg-emerald-500/20 text-emerald-500 border-emerald-500/30">
                  Connesso
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  Non connesso
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Connessione Fatture in Cloud per {companyName}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configured ? (
          <div className="flex items-center gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm">
            <AlertCircle className="h-5 w-5 shrink-0 text-yellow-500" />
            <span>
              OAuth FiC non configurato. Variabili ambiente mancanti:
              <code className="ml-1 font-mono text-xs">FATTUREINCLOUD_CLIENT_ID</code>,
              <code className="ml-1 font-mono text-xs">FATTUREINCLOUD_CLIENT_SECRET</code>,
              <code className="ml-1 font-mono text-xs">FATTUREINCLOUD_REDIRECT_URI</code>.
            </span>
          </div>
        ) : !connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>Non connesso. Avvia il flusso OAuth per autorizzare questa azienda.</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => onConnect(false)} disabled={oauthLoading}>
                {oauthLoading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4 mr-2" />
                )}
                Connetti Fatture in Cloud
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500 mt-0.5" />
              <div className="space-y-1">
                <div className="font-medium text-foreground">Connesso</div>
                <div className="text-xs text-muted-foreground">
                  {expiresAt && (
                    <span>
                      Token scade:{" "}
                      {new Date(expiresAt).toLocaleString("it-IT", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </span>
                  )}
                  {expired && (
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
                onClick={onSyncMappings}
                disabled={syncLoading}
              >
                {syncLoading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Users className="h-4 w-4 mr-2" />
                )}
                Sincronizza mapping retailer
              </Button>
              <Button
                variant="secondary"
                onClick={() => onConnect(false)}
                disabled={oauthLoading}
              >
                {oauthLoading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Riconnetti (cambia azienda FiC)
              </Button>
              <Button variant="destructive" onClick={onDisconnect}>
                <Unplug className="h-4 w-4 mr-2" />
                Disconnetti
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
