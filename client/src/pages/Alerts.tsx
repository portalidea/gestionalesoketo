import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { it } from "date-fns/locale";

export default function Alerts() {
  const { data: alerts, isLoading } = trpc.alerts.getActive.useQuery();
  const utils = trpc.useUtils();

  const updateStatusMutation = trpc.alerts.updateStatus.useMutation({
    onSuccess: () => {
      utils.alerts.getActive.invalidate();
      toast.success("Stato alert aggiornato");
    },
    onError: () => {
      toast.error("Errore nell'aggiornamento dello stato");
    },
  });

  const getAlertIcon = (type: string) => {
    switch (type) {
      case "EXPIRED":
        return <XCircle className="h-6 w-6 text-destructive" />;
      case "EXPIRING":
        return <AlertTriangle className="h-6 w-6 text-orange-500" />;
      case "LOW_STOCK":
        return <AlertTriangle className="h-6 w-6 text-yellow-500" />;
      default:
        return <AlertTriangle className="h-6 w-6 text-muted-foreground" />;
    }
  };

  const getAlertBadgeVariant = (type: string) => {
    switch (type) {
      case "EXPIRED":
        return "destructive";
      case "EXPIRING":
        return "default";
      case "LOW_STOCK":
        return "secondary";
      default:
        return "outline";
    }
  };

  const getAlertTypeLabel = (type: string) => {
    switch (type) {
      case "EXPIRED":
        return "Prodotto Scaduto";
      case "EXPIRING":
        return "In Scadenza";
      case "LOW_STOCK":
        return "Scorta Bassa";
      default:
        return type;
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">Alert</h1>
          <p className="text-muted-foreground">
            Situazioni che richiedono attenzione nei magazzini rivenditori
          </p>
        </div>

        {/* Alerts List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : alerts && alerts.length > 0 ? (
          <div className="space-y-4">
            {alerts.map((alert) => (
              <Card
                key={alert.id}
                className={`border-border bg-card ${
                  alert.type === "EXPIRED"
                    ? "border-l-4 border-l-destructive"
                    : alert.type === "EXPIRING"
                    ? "border-l-4 border-l-orange-500"
                    : "border-l-4 border-l-yellow-500"
                }`}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="mt-1">{getAlertIcon(alert.type)}</div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <CardTitle className="text-xl text-foreground">
                            {getAlertTypeLabel(alert.type)}
                          </CardTitle>
                          <Badge variant={getAlertBadgeVariant(alert.type)}>
                            {alert.status}
                          </Badge>
                        </div>
                        <CardDescription>
                          Creato il{" "}
                          {format(new Date(alert.createdAt), "dd MMMM yyyy 'alle' HH:mm", {
                            locale: it,
                          })}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {alert.status === "ACTIVE" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              updateStatusMutation.mutate({
                                id: alert.id,
                                status: "ACKNOWLEDGED",
                              })
                            }
                            disabled={updateStatusMutation.isPending}
                          >
                            <CheckCircle className="h-4 w-4 mr-2" />
                            Presa Visione
                          </Button>
                          <Button
                            size="sm"
                            onClick={() =>
                              updateStatusMutation.mutate({
                                id: alert.id,
                                status: "RESOLVED",
                              })
                            }
                            disabled={updateStatusMutation.isPending}
                          >
                            Risolvi
                          </Button>
                        </>
                      )}
                      {alert.status === "ACKNOWLEDGED" && (
                        <Button
                          size="sm"
                          onClick={() =>
                            updateStatusMutation.mutate({
                              id: alert.id,
                              status: "RESOLVED",
                            })
                          }
                          disabled={updateStatusMutation.isPending}
                        >
                          Risolvi
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {alert.message && (
                    <p className="text-sm text-foreground">{alert.message}</p>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    {alert.currentQuantity !== null && (
                      <div>
                        <span className="text-muted-foreground">Quantità Attuale:</span>
                        <p className="text-foreground font-semibold">
                          {alert.currentQuantity}
                        </p>
                      </div>
                    )}
                    {alert.thresholdQuantity !== null && (
                      <div>
                        <span className="text-muted-foreground">Soglia:</span>
                        <p className="text-foreground font-semibold">
                          {alert.thresholdQuantity}
                        </p>
                      </div>
                    )}
                    {alert.expirationDate && (
                      <div>
                        <span className="text-muted-foreground">Data Scadenza:</span>
                        <p className="text-foreground font-semibold">
                          {format(new Date(alert.expirationDate), "dd/MM/yyyy")}
                        </p>
                      </div>
                    )}
                    {alert.acknowledgedAt && (
                      <div>
                        <span className="text-muted-foreground">Presa Visione:</span>
                        <p className="text-foreground font-semibold">
                          {format(new Date(alert.acknowledgedAt), "dd/MM/yyyy HH:mm")}
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <CheckCircle className="h-16 w-16 text-primary mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Nessun alert attivo
              </h3>
              <p className="text-muted-foreground text-center max-w-md">
                Tutti i magazzini sono in buone condizioni. Gli alert appariranno qui quando ci
                saranno scorte basse o prodotti in scadenza.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
