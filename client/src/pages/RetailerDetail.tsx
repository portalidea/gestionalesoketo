import DashboardLayout from "@/components/DashboardLayout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Calendar,
  Loader2,
  Mail,
  MapPin,
  Package,
  Phone,
  Plus,
  RefreshCw,
  Store,
  Trash2,
  TrendingUp,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation, useRoute } from "wouter";

export default function RetailerDetail() {
  const [, params] = useRoute("/retailers/:id");
  const [, setLocation] = useLocation();
  const retailerId = params?.id ?? "";
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.retailers.getDetails.useQuery(
    { id: retailerId },
    { enabled: retailerId.length > 0 },
  );
  const { data: deps } = trpc.retailers.dependentsCount.useQuery(
    { id: retailerId },
    { enabled: retailerId.length > 0 },
  );

  const deleteRetailerMutation = trpc.retailers.delete.useMutation({
    onSuccess: async () => {
      await utils.retailers.list.invalidate();
      toast.success("Rivenditore eliminato");
      setLocation("/retailers");
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  if (!data || !data.retailer) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Button variant="ghost" onClick={() => setLocation("/retailers")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Torna ai Rivenditori
          </Button>
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Store className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Rivenditore non trovato
              </h3>
              <p className="text-muted-foreground">
                Il rivenditore richiesto non esiste o è stato eliminato
              </p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  const { retailer, inventory, recentMovements, alerts, stats } = data;

  const getMovementIcon = (type: string) => {
    switch (type) {
      case "IN":
        return <ArrowDown className="h-4 w-4 text-green-500" />;
      case "OUT":
        return <ArrowUp className="h-4 w-4 text-red-500" />;
      case "ADJUSTMENT":
        return <RefreshCw className="h-4 w-4 text-blue-500" />;
      default:
        return <Package className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getMovementLabel = (type: string) => {
    switch (type) {
      case "IN":
        return "Entrata";
      case "OUT":
        return "Uscita";
      case "ADJUSTMENT":
        return "Rettifica";
      default:
        return type;
    }
  };

  const getDaysUntilExpiry = (expirationDate: Date | null) => {
    if (!expirationDate) return null;
    return Math.floor(
      (new Date(expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <Button variant="ghost" onClick={() => setLocation("/retailers")} className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Torna ai Rivenditori
          </Button>
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className="h-16 w-16 rounded-lg bg-primary/20 flex items-center justify-center">
                <Store className="h-8 w-8 text-primary" />
              </div>
              <div>
                <h1 className="text-4xl font-bold text-foreground mb-2">{retailer.name}</h1>
                {retailer.businessType && (
                  <p className="text-lg text-muted-foreground">{retailer.businessType}</p>
                )}
              </div>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Elimina rivenditore"
                >
                  <Trash2 className="h-5 w-5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Eliminare {retailer.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Saranno eliminate anche{" "}
                    <strong>{deps?.inventory ?? "?"} lotti correnti</strong>,{" "}
                    <strong>{deps?.stockMovements ?? "?"} movimenti</strong>,{" "}
                    <strong>{deps?.alerts ?? "?"} alert</strong> e{" "}
                    <strong>{deps?.syncLogs ?? "?"} log di sync</strong>{" "}
                    associati. L'operazione è irreversibile.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annulla</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() =>
                      deleteRetailerMutation.mutate({ id: retailerId })
                    }
                  >
                    Elimina rivenditore
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Valore Inventario</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <TrendingUp className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold text-foreground">€{stats.totalValue}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Prodotti in Stock</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Package className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold text-foreground">{stats.totalItems}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Scorte Basse</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-yellow-500" />
                <span className="text-2xl font-bold text-foreground">{stats.lowStockCount}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Alert Attivi</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <span className="text-2xl font-bold text-foreground">
                  {stats.activeAlertsCount}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Info Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle>Informazioni Rivenditore</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {retailer.address && (
                <div className="flex items-start gap-3">
                  <MapPin className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Indirizzo</p>
                    <p className="text-sm text-muted-foreground">
                      {retailer.address}
                      {retailer.city && `, ${retailer.city}`}
                      {retailer.province && ` (${retailer.province})`}
                      {retailer.postalCode && ` - ${retailer.postalCode}`}
                    </p>
                  </div>
                </div>
              )}
              {retailer.phone && (
                <div className="flex items-start gap-3">
                  <Phone className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Telefono</p>
                    <p className="text-sm text-muted-foreground">{retailer.phone}</p>
                  </div>
                </div>
              )}
              {retailer.email && (
                <div className="flex items-start gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Email</p>
                    <p className="text-sm text-muted-foreground">{retailer.email}</p>
                  </div>
                </div>
              )}
              {retailer.contactPerson && (
                <div className="flex items-start gap-3">
                  <User className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Persona di Contatto</p>
                    <p className="text-sm text-muted-foreground">{retailer.contactPerson}</p>
                  </div>
                </div>
              )}
            </div>
            {retailer.notes && (
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-sm font-medium text-foreground mb-2">Note</p>
                <p className="text-sm text-muted-foreground">{retailer.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tabs: Inventario e Movimenti */}
        <Tabs defaultValue="inventory" className="space-y-6">
          <TabsList>
            <TabsTrigger value="inventory">Inventario</TabsTrigger>
            <TabsTrigger value="movements">Movimenti Stock</TabsTrigger>
          </TabsList>

          <TabsContent value="inventory" className="space-y-4">
            {inventory.length > 0 ? (
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle>Inventario Prodotti</CardTitle>
                  <CardDescription>
                    Elenco completo dei prodotti disponibili presso questo rivenditore
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Prodotto</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">Quantità</TableHead>
                        <TableHead>Scadenza</TableHead>
                        <TableHead>Lotto</TableHead>
                        <TableHead>Stato</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {inventory.map((item) => {
                        const daysUntilExpiry = getDaysUntilExpiry(item.expirationDate);
                        const isLowStock =
                          item.product &&
                          item.quantity < (item.product.minStockThreshold || 10);
                        const isExpiringSoon =
                          daysUntilExpiry !== null && daysUntilExpiry <= 30 && daysUntilExpiry > 0;
                        const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;

                        return (
                          <TableRow key={item.id}>
                            <TableCell className="font-medium">
                              {item.product?.name || "Prodotto sconosciuto"}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {item.product?.sku}
                            </TableCell>
                            <TableCell className="text-right">
                              <span
                                className={
                                  isLowStock ? "text-yellow-500 font-semibold" : "text-foreground"
                                }
                              >
                                {item.quantity}
                              </span>
                              {item.product?.unit && (
                                <span className="text-muted-foreground ml-1">
                                  {item.product.unit}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {item.expirationDate ? (
                                <span
                                  className={
                                    isExpired
                                      ? "text-destructive font-semibold"
                                      : isExpiringSoon
                                      ? "text-orange-500 font-semibold"
                                      : "text-foreground"
                                  }
                                >
                                  {format(new Date(item.expirationDate), "dd/MM/yyyy")}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {item.batchNumber || "-"}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                {isExpired && (
                                  <Badge variant="destructive" className="text-xs">
                                    Scaduto
                                  </Badge>
                                )}
                                {isExpiringSoon && !isExpired && (
                                  <Badge
                                    variant="default"
                                    className="text-xs bg-orange-500 hover:bg-orange-600"
                                  >
                                    In scadenza
                                  </Badge>
                                )}
                                {isLowStock && (
                                  <Badge variant="secondary" className="text-xs">
                                    Scorta bassa
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-border bg-card">
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Package className="h-16 w-16 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    Inventario Vuoto
                  </h3>
                  <p className="text-muted-foreground text-center max-w-md">
                    Nessun prodotto presente nell'inventario di questo rivenditore
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="movements" className="space-y-4">
            <div className="flex flex-col items-end gap-1">
              <Button disabled aria-disabled="true">
                <Plus className="h-4 w-4 mr-2" />
                Aggiungi Movimento
              </Button>
              <p className="text-xs text-muted-foreground">
                Sistema lotti FEFO completo in arrivo (Fase B post-cutover).
              </p>
            </div>

            {recentMovements.length > 0 ? (
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle>Movimenti di Magazzino</CardTitle>
                  <CardDescription>
                    Ultimi 50 movimenti registrati per questo rivenditore
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Data</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Prodotto</TableHead>
                        <TableHead className="text-right">Quantità</TableHead>
                        <TableHead>Documento</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentMovements.map((movement) => (
                        <TableRow key={movement.id}>
                          <TableCell className="text-muted-foreground">
                            {movement.timestamp
                              ? format(new Date(movement.timestamp), "dd/MM/yyyy HH:mm", {
                                  locale: it,
                                })
                              : "-"}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getMovementIcon(movement.type)}
                              <span className="text-sm">{getMovementLabel(movement.type)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">
                            {movement.product?.name || "Prodotto sconosciuto"}
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={
                                movement.type === "IN"
                                  ? "text-green-500 font-semibold"
                                  : movement.type === "OUT"
                                  ? "text-red-500 font-semibold"
                                  : "text-foreground font-semibold"
                              }
                            >
                              {movement.type === "IN" ? "+" : movement.type === "OUT" ? "-" : ""}
                              {movement.quantity}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {movement.sourceDocument || "-"}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {movement.notes || "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-border bg-card">
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Calendar className="h-16 w-16 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    Nessun Movimento
                  </h3>
                  <p className="text-muted-foreground text-center max-w-md">
                    Non sono stati registrati movimenti di magazzino per questo rivenditore.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

        </Tabs>
      </div>
    </DashboardLayout>
  );
}
