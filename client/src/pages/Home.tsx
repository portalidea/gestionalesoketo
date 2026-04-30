import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Store, Package, AlertTriangle, TrendingUp, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Home() {
  const { data: stats, isLoading } = trpc.dashboard.getStats.useQuery();
  const { data: activeAlerts } = trpc.alerts.getActive.useQuery();

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">
            Dashboard
          </h1>
          <p className="text-muted-foreground">
            Panoramica generale della gestione magazzino rivenditori SoKeto
          </p>
        </div>

        {/* KPI Cards */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Card className="border-border bg-card">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Rivenditori Attivi
                  </CardTitle>
                  <Store className="h-5 w-5 text-primary" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">
                    {stats?.totalRetailers || 0}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Punti vendita registrati
                  </p>
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Prodotti Catalogati
                  </CardTitle>
                  <Package className="h-5 w-5 text-primary" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">
                    {stats?.totalProducts || 0}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Prodotti SoKeto disponibili
                  </p>
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Alert Attivi
                  </CardTitle>
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">
                    {stats?.activeAlerts || 0}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stats?.lowStockItems || 0} scorte basse, {stats?.expiringItems || 0} in scadenza
                  </p>
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Valore Inventario
                  </CardTitle>
                  <TrendingUp className="h-5 w-5 text-primary" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">
                    €{stats?.totalInventoryValue || "0.00"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Valore totale stimato
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Alert Section */}
            {activeAlerts && activeAlerts.length > 0 && (
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle className="text-xl text-foreground">Alert Recenti</CardTitle>
                  <CardDescription>
                    Situazioni che richiedono attenzione immediata
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {activeAlerts.slice(0, 5).map((alert) => (
                      <div
                        key={alert.id}
                        className="flex items-start gap-3 p-3 rounded-lg bg-accent/50 border border-border"
                      >
                        <AlertTriangle
                          className={`h-5 w-5 mt-0.5 ${
                            alert.type === "EXPIRED"
                              ? "text-destructive"
                              : alert.type === "EXPIRING"
                              ? "text-orange-500"
                              : "text-yellow-500"
                          }`}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {alert.type === "LOW_STOCK"
                              ? "Scorta Bassa"
                              : alert.type === "EXPIRING"
                              ? "Prodotto in Scadenza"
                              : "Prodotto Scaduto"}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {alert.message}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {activeAlerts.length > 5 && (
                    <div className="mt-4 text-center">
                      <Link href="/alerts">
                        <Button variant="outline" size="sm">
                          Vedi tutti gli alert ({activeAlerts.length})
                        </Button>
                      </Link>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Quick Actions */}
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-xl text-foreground">Azioni Rapide</CardTitle>
                <CardDescription>
                  Accesso veloce alle funzionalità principali
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Link href="/retailers">
                    <Button variant="outline" className="w-full h-auto py-4 flex-col gap-2">
                      <Store className="h-6 w-6" />
                      <span>Gestisci Rivenditori</span>
                    </Button>
                  </Link>
                  <Link href="/products">
                    <Button variant="outline" className="w-full h-auto py-4 flex-col gap-2">
                      <Package className="h-6 w-6" />
                      <span>Gestisci Prodotti</span>
                    </Button>
                  </Link>
                  <Link href="/reports">
                    <Button variant="outline" className="w-full h-auto py-4 flex-col gap-2">
                      <TrendingUp className="h-6 w-6" />
                      <span>Visualizza Report</span>
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
