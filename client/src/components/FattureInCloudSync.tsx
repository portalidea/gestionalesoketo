import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Cloud, CloudOff, RefreshCw, CheckCircle2, XCircle, AlertCircle, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { it } from "date-fns/locale";

interface FattureInCloudSyncProps {
  retailerId: string;
  isConnected: boolean;
  lastSyncAt?: Date | null;
  onSyncComplete?: () => void;
}

export function FattureInCloudSync({
  retailerId,
  isConnected,
  lastSyncAt,
  onSyncComplete,
}: FattureInCloudSyncProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    success: boolean;
    productsSync: number;
    inventorySync: number;
    movementsSync: number;
    errors: string[];
  } | null>(null);

  const { data: authUrl } = trpc.sync.getAuthUrl.useQuery(
    { retailerId },
    { enabled: !isConnected }
  );

  const { data: syncLogs, refetch: refetchLogs } = trpc.sync.getLogs.useQuery(
    { retailerId, limit: 10 },
    { enabled: isConnected }
  );

  const syncMutation = trpc.sync.syncRetailer.useMutation({
    onSuccess: (result) => {
      setSyncResult(result);
      setSyncing(false);
      refetchLogs();
      onSyncComplete?.();
    },
    onError: (error) => {
      console.error("Sync error:", error);
      setSyncing(false);
    },
  });

  const disconnectMutation = trpc.sync.disconnect.useMutation({
    onSuccess: () => {
      onSyncComplete?.();
    },
  });

  const handleConnect = () => {
    if (authUrl?.url) {
      const width = 600;
      const height = 700;
      const left = window.screen.width / 2 - width / 2;
      const top = window.screen.height / 2 - height / 2;

      window.open(
        authUrl.url,
        "FattureInCloudAuth",
        `width=${width},height=${height},left=${left},top=${top}`
      );

      // Ascolta messaggio da finestra popup
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === "oauth_success") {
          window.removeEventListener("message", handleMessage);
          onSyncComplete?.();
        }
      };

      window.addEventListener("message", handleMessage);
    }
  };

  const handleSync = () => {
    setSyncing(true);
    setSyncResult(null);
    syncMutation.mutate({ retailerId });
  };

  const handleDisconnect = () => {
    if (confirm("Sei sicuro di voler disconnettere Fatture in Cloud? I dati sincronizzati rimarranno salvati.")) {
      disconnectMutation.mutate({ retailerId });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "SUCCESS":
        return (
          <Badge variant="default" className="bg-green-500/10 text-green-500 hover:bg-green-500/20">
            <CheckCircle2 className="w-3 h-3 mr-1" />
            Successo
          </Badge>
        );
      case "FAILED":
        return (
          <Badge variant="destructive">
            <XCircle className="w-3 h-3 mr-1" />
            Fallito
          </Badge>
        );
      case "PARTIAL":
        return (
          <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-500">
            <AlertCircle className="w-3 h-3 mr-1" />
            Parziale
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Cloud className="w-5 h-5" />
                Sincronizzazione Fatture in Cloud
              </CardTitle>
              <CardDescription>
                Collega il gestionale per sincronizzare automaticamente prodotti e inventario
              </CardDescription>
            </div>
            {isConnected && (
              <Badge variant="default" className="bg-green-500/10 text-green-500">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Connesso
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isConnected ? (
            <div className="space-y-4">
              <Alert>
                <Cloud className="w-4 h-4" />
                <AlertDescription>
                  Connetti Fatture in Cloud per sincronizzare automaticamente prodotti, inventario e movimenti stock.
                </AlertDescription>
              </Alert>
              <Button onClick={handleConnect} disabled={!authUrl}>
                <Cloud className="w-4 h-4 mr-2" />
                Connetti Fatture in Cloud
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  {lastSyncAt ? (
                    <>
                      Ultima sincronizzazione:{" "}
                      {format(new Date(lastSyncAt), "dd/MM/yyyy 'alle' HH:mm", { locale: it })}
                    </>
                  ) : (
                    "Nessuna sincronizzazione effettuata"
                  )}
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleSync} disabled={syncing} size="sm">
                    {syncing ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Sincronizzazione...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Sincronizza Ora
                      </>
                    )}
                  </Button>
                  <Button
                    onClick={handleDisconnect}
                    variant="outline"
                    size="sm"
                    disabled={disconnectMutation.isPending}
                  >
                    <CloudOff className="w-4 h-4 mr-2" />
                    Disconnetti
                  </Button>
                </div>
              </div>

              {syncResult && (
                <Alert variant={syncResult.success ? "default" : "destructive"}>
                  <AlertDescription>
                    <div className="space-y-2">
                      <div className="font-medium">
                        {syncResult.success ? "Sincronizzazione completata!" : "Sincronizzazione completata con errori"}
                      </div>
                      <div className="text-sm space-y-1">
                        <div>Prodotti sincronizzati: {syncResult.productsSync}</div>
                        <div>Inventario aggiornato: {syncResult.inventorySync} articoli</div>
                        <div>Movimenti registrati: {syncResult.movementsSync}</div>
                      </div>
                      {syncResult.errors.length > 0 && (
                        <div className="text-sm mt-2">
                          <div className="font-medium">Errori:</div>
                          <ul className="list-disc list-inside">
                            {syncResult.errors.map((error, idx) => (
                              <li key={idx}>{error}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {isConnected && syncLogs && syncLogs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Storico Sincronizzazioni</CardTitle>
            <CardDescription>Ultimi 10 log di sincronizzazione</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="text-right">Record</TableHead>
                  <TableHead>Errori</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-sm">
                      {format(new Date(log.startedAt), "dd/MM/yyyy HH:mm", { locale: it })}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{log.syncType}</Badge>
                    </TableCell>
                    <TableCell>{getStatusBadge(log.status)}</TableCell>
                    <TableCell className="text-right">{log.recordsProcessed || 0}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {log.errorMessage || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
