import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  Store,
  Package,
  AlertTriangle,
  TrendingUp,
  Loader2,
  ArrowDown,
  Clock,
  ShoppingCart,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Helper: classe colore per scadenza */
function getExpiryClass(daysToExpiry: number): string {
  if (daysToExpiry < 0) return "text-red-700 line-through";
  if (daysToExpiry < 7) return "text-red-500 font-semibold";
  return "text-amber-500 font-medium";
}

function getExpiryLabel(daysToExpiry: number): string {
  if (daysToExpiry < 0) return `Scaduto da ${Math.abs(daysToExpiry)}g`;
  if (daysToExpiry === 0) return "Scade oggi";
  return `${daysToExpiry}g rimanenti`;
}

export default function Home() {
  const { data: stats, isLoading } = trpc.dashboard.getStats.useQuery();
  const { data: activeAlerts } = trpc.alerts.getActive.useQuery();
  const { data: stockAlerts } = trpc.dashboard.getStockAlerts.useQuery();
  const { data: expiringBatches } = trpc.dashboard.getExpiringBatches.useQuery();

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">Dashboard</h1>
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
                    &euro;{stats?.totalInventoryValue || "0.00"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Valore totale stimato
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Stock sotto soglia + Scadenze imminenti — side by side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Card: Prodotti sotto soglia stock */}
              <Card className="border-border bg-card">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg text-foreground flex items-center gap-2">
                        <ArrowDown className="h-5 w-5 text-amber-500" />
                        Scorte Basse
                      </CardTitle>
                      <CardDescription>
                        Prodotti sotto soglia minima (magazzino centrale)
                      </CardDescription>
                    </div>
                    {stockAlerts && stockAlerts.length > 0 && (
                      <Badge variant="destructive" className="text-xs">
                        {stockAlerts.length}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {!stockAlerts ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : stockAlerts.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      Nessun prodotto sotto soglia
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Prodotto</TableHead>
                            <TableHead className="text-right">Stock</TableHead>
                            <TableHead className="text-right">Soglia</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {stockAlerts.slice(0, 10).map((p) => {
                            const pct = p.minStockThreshold > 0
                              ? Math.round((p.totalStock / p.minStockThreshold) * 100)
                              : 0;
                            return (
                              <TableRow key={p.id}>
                                <TableCell>
                                  <Link href={`/products/${p.id}`}>
                                    <span className="text-sm font-medium hover:underline cursor-pointer">
                                      {p.name}
                                    </span>
                                  </Link>
                                  <span className="text-xs text-muted-foreground ml-2 font-mono">
                                    {p.sku}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right">
                                  <span className={`font-mono text-sm font-semibold ${
                                    p.totalStock === 0 ? "text-red-500" : "text-amber-500"
                                  }`}>
                                    {p.totalStock}
                                  </span>
                                  <span className="text-xs text-muted-foreground ml-1">
                                    ({pct}%)
                                  </span>
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm text-muted-foreground">
                                  {p.minStockThreshold}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                      {stockAlerts.length > 10 && (
                        <div className="mt-3 text-center">
                          <Link href="/products">
                            <Button variant="outline" size="sm">
                              Vedi tutti ({stockAlerts.length})
                            </Button>
                          </Link>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Card: Scadenze imminenti */}
              <Card className="border-border bg-card">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg text-foreground flex items-center gap-2">
                        <Clock className="h-5 w-5 text-red-500" />
                        Scadenze Imminenti
                      </CardTitle>
                      <CardDescription>
                        Lotti in scadenza (magazzino centrale)
                      </CardDescription>
                    </div>
                    {expiringBatches && expiringBatches.length > 0 && (
                      <Badge variant="destructive" className="text-xs">
                        {expiringBatches.length}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {!expiringBatches ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : expiringBatches.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      Nessun lotto in scadenza imminente
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Prodotto</TableHead>
                            <TableHead>Lotto</TableHead>
                            <TableHead className="text-right">Stock</TableHead>
                            <TableHead className="text-right">Scadenza</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {expiringBatches.slice(0, 10).map((b) => (
                            <TableRow key={b.batchId}>
                              <TableCell>
                                <Link href={`/products/${b.productId}`}>
                                  <span className="text-sm font-medium hover:underline cursor-pointer">
                                    {b.productName}
                                  </span>
                                </Link>
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {b.batchNumber}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {b.stock}
                              </TableCell>
                              <TableCell className="text-right">
                                <span className={`text-sm ${getExpiryClass(b.daysToExpiry)}`}>
                                  {b.expirationDate?.slice(0, 10) ?? "—"}
                                </span>
                                <span className={`block text-xs ${getExpiryClass(b.daysToExpiry)}`}>
                                  {getExpiryLabel(b.daysToExpiry)}
                                </span>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      {expiringBatches.length > 10 && (
                        <div className="mt-3 text-center">
                          <Link href="/products">
                            <Button variant="outline" size="sm">
                              Vedi tutti ({expiringBatches.length})
                            </Button>
                          </Link>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Alert Recenti (dalla tabella alerts) */}
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
                          <p className="text-sm text-muted-foreground">{alert.message}</p>
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
                  Accesso veloce alle funzionalita principali
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
                  <Link href="/orders/new">
                    <Button variant="outline" className="w-full h-auto py-4 flex-col gap-2">
                      <ShoppingCart className="h-6 w-6" />
                      <span>Nuovo Ordine</span>
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
