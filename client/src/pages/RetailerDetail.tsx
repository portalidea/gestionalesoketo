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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  ArrowRight,
  ArrowUp,
  Calendar,
  ChevronDown,
  ChevronRight,
  Loader2,
  Mail,
  MapPin,
  Package,
  Phone,
  RefreshCw,
  Store,
  Trash2,
  TrendingUp,
  Truck,
  User,
  XCircle,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useLocation, useRoute } from "wouter";

type WriteOffTarget = {
  batchId: string;
  locationId: string;
  batchNumber: string;
  productName: string;
  maxQuantity: number;
  expirationDate: Date | null;
};

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

  // ============== Write-off state ==============
  const [writeOffTarget, setWriteOffTarget] = useState<WriteOffTarget | null>(
    null,
  );
  const [writeOffQty, setWriteOffQty] = useState("");
  const [writeOffNotes, setWriteOffNotes] = useState("");
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  const writeOffMutation = trpc.stockMovements.expiryWriteOff.useMutation({
    onSuccess: async () => {
      await utils.retailers.getDetails.invalidate({ id: retailerId });
      await utils.warehouse.getStockOverview.invalidate();
      await utils.stockMovements.listByRetailer.invalidate({ retailerId });
      setWriteOffTarget(null);
      setWriteOffQty("");
      setWriteOffNotes("");
      toast.success("Lotto scartato");
    },
    onError: (err) => toast.error(err.message),
  });

  const submitWriteOff = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!writeOffTarget) return;
    const qty = parseInt(writeOffQty, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Quantità deve essere positiva");
      return;
    }
    if (qty > writeOffTarget.maxQuantity) {
      toast.error(`Quantità massima: ${writeOffTarget.maxQuantity}`);
      return;
    }
    writeOffMutation.mutate({
      batchId: writeOffTarget.batchId,
      locationId: writeOffTarget.locationId,
      quantity: qty,
      notes: writeOffNotes || undefined,
    });
  };

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

  const { retailer, inventory, recentMovements, stats } = data;
  const now = Date.now();

  // ====== Aggregazione per prodotto (riga espandibile lotti) ======
  type ProductGroup = {
    productId: string;
    productName: string;
    productSku: string;
    productUnit: string | null;
    minStockThreshold: number | null;
    totalStock: number;
    activeBatchCount: number;
    nearestExpiration: Date | null;
    items: typeof inventory;
  };
  const groupsMap = new Map<string, ProductGroup>();
  for (const item of inventory) {
    if (!item.product) continue;
    let entry = groupsMap.get(item.product.id);
    if (!entry) {
      entry = {
        productId: item.product.id,
        productName: item.product.name,
        productSku: item.product.sku,
        productUnit: item.product.unit,
        minStockThreshold: item.product.minStockThreshold ?? null,
        totalStock: 0,
        activeBatchCount: 0,
        nearestExpiration: null,
        items: [],
      };
      groupsMap.set(item.product.id, entry);
    }
    entry.totalStock += item.quantity;
    if (item.quantity > 0) entry.activeBatchCount += 1;
    if (
      item.quantity > 0 &&
      item.expirationDate &&
      (!entry.nearestExpiration || item.expirationDate < entry.nearestExpiration)
    ) {
      entry.nearestExpiration = item.expirationDate;
    }
    entry.items.push(item);
  }
  const productGroups = Array.from(groupsMap.values()).sort((a, b) =>
    a.productName.localeCompare(b.productName),
  );

  const daysToExpiry = (d: Date | string | null) => {
    if (!d) return null;
    return Math.floor((new Date(d).getTime() - now) / 86_400_000);
  };

  const expirationBadge = (d: Date | string | null) => {
    const days = daysToExpiry(d);
    if (days === null) return null;
    if (days <= 0) {
      return (
        <Badge variant="destructive" className="text-xs">
          Scaduto
        </Badge>
      );
    }
    if (days <= 30) {
      return (
        <Badge className="text-xs bg-orange-500 hover:bg-orange-600">
          {days}gg
        </Badge>
      );
    }
    return null;
  };

  const movementBadge = (type: string) => {
    switch (type) {
      case "TRANSFER":
        return (
          <Badge className="text-xs bg-blue-500 hover:bg-blue-600">
            <Truck className="h-3 w-3 mr-1" />
            Trasferimento
          </Badge>
        );
      case "EXPIRY_WRITE_OFF":
        return (
          <Badge variant="destructive" className="text-xs">
            <XCircle className="h-3 w-3 mr-1" />
            Scarto
          </Badge>
        );
      case "RECEIPT_FROM_PRODUCER":
        return (
          <Badge className="text-xs bg-green-600 hover:bg-green-700">
            <ArrowDown className="h-3 w-3 mr-1" />
            Ingresso
          </Badge>
        );
      case "IN":
        return (
          <Badge variant="secondary" className="text-xs">
            <ArrowDown className="h-3 w-3 mr-1" />
            Entrata
          </Badge>
        );
      case "OUT":
        return (
          <Badge variant="secondary" className="text-xs">
            <ArrowUp className="h-3 w-3 mr-1" />
            Uscita
          </Badge>
        );
      case "ADJUSTMENT":
        return (
          <Badge variant="secondary" className="text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Rettifica
          </Badge>
        );
      default:
        return <Badge variant="outline">{type}</Badge>;
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <Button
            variant="ghost"
            onClick={() => setLocation("/retailers")}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Torna ai Rivenditori
          </Button>
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className="h-16 w-16 rounded-lg bg-primary/20 flex items-center justify-center">
                <Store className="h-8 w-8 text-primary" />
              </div>
              <div>
                <h1 className="text-4xl font-bold text-foreground mb-2">
                  {retailer.name}
                </h1>
                {retailer.businessType && (
                  <p className="text-lg text-muted-foreground">
                    {retailer.businessType}
                  </p>
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
                <span className="text-2xl font-bold text-foreground">
                  €{stats.totalValue}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Lotti in stock</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Package className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold text-foreground">
                  {stats.totalItems}
                </span>
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
                <span className="text-2xl font-bold text-foreground">
                  {stats.lowStockCount}
                </span>
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
                    <p className="text-sm font-medium text-foreground">
                      Persona di Contatto
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {retailer.contactPerson}
                    </p>
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
            <TabsTrigger value="movements">
              Movimenti ({recentMovements.length})
            </TabsTrigger>
          </TabsList>

          {/* ====================== TAB INVENTARIO ====================== */}
          <TabsContent value="inventory" className="space-y-4">
            {productGroups.length > 0 ? (
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle>Inventario per prodotto e lotto</CardTitle>
                  <CardDescription>
                    Click su una riga per vedere il dettaglio dei lotti.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10"></TableHead>
                        <TableHead>Prodotto</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">Stock totale</TableHead>
                        <TableHead className="text-right">Lotti</TableHead>
                        <TableHead>Scadenza più vicina</TableHead>
                        <TableHead>Stato</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {productGroups.map((g) => {
                        const isExpanded = expandedProductId === g.productId;
                        const isLowStock =
                          g.minStockThreshold !== null &&
                          g.totalStock < g.minStockThreshold;
                        return (
                          <>
                            <TableRow
                              key={g.productId}
                              className="cursor-pointer hover:bg-accent/50"
                              onClick={() =>
                                setExpandedProductId(
                                  isExpanded ? null : g.productId,
                                )
                              }
                            >
                              <TableCell>
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                              </TableCell>
                              <TableCell className="font-medium">
                                {g.productName}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {g.productSku}
                              </TableCell>
                              <TableCell className="text-right font-semibold">
                                <span
                                  className={
                                    isLowStock
                                      ? "text-yellow-500"
                                      : "text-foreground"
                                  }
                                >
                                  {g.totalStock}
                                </span>
                                {g.productUnit && (
                                  <span className="text-muted-foreground ml-1 font-normal">
                                    {g.productUnit}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                {g.activeBatchCount}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <span>
                                    {g.nearestExpiration
                                      ? format(
                                          g.nearestExpiration,
                                          "dd/MM/yyyy",
                                        )
                                      : "-"}
                                  </span>
                                  {expirationBadge(g.nearestExpiration)}
                                </div>
                              </TableCell>
                              <TableCell>
                                {isLowStock && (
                                  <Badge variant="secondary" className="text-xs">
                                    Scorta bassa
                                  </Badge>
                                )}
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow key={`${g.productId}-detail`}>
                                <TableCell></TableCell>
                                <TableCell colSpan={6} className="bg-accent/20 py-4">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead>Lotto</TableHead>
                                        <TableHead>Produttore</TableHead>
                                        <TableHead>Scadenza</TableHead>
                                        <TableHead className="text-right">
                                          Quantità
                                        </TableHead>
                                        <TableHead className="w-10"></TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {g.items.map((item) => (
                                        <TableRow key={item.id}>
                                          <TableCell className="font-mono text-xs">
                                            {item.batchNumber}
                                          </TableCell>
                                          <TableCell className="text-muted-foreground">
                                            {item.producerName ?? "-"}
                                          </TableCell>
                                          <TableCell>
                                            <div className="flex items-center gap-2">
                                              <span>
                                                {item.expirationDate
                                                  ? format(
                                                      item.expirationDate,
                                                      "dd/MM/yyyy",
                                                    )
                                                  : "-"}
                                              </span>
                                              {expirationBadge(
                                                item.expirationDate,
                                              )}
                                            </div>
                                          </TableCell>
                                          <TableCell className="text-right font-semibold">
                                            {item.quantity}
                                          </TableCell>
                                          <TableCell>
                                            {item.quantity > 0 && (
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                aria-label="Scarta lotto"
                                                onClick={() => {
                                                  setWriteOffTarget({
                                                    batchId: item.batchId,
                                                    locationId: item.locationId,
                                                    batchNumber: item.batchNumber,
                                                    productName: g.productName,
                                                    maxQuantity: item.quantity,
                                                    expirationDate:
                                                      item.expirationDate,
                                                  });
                                                  setWriteOffQty(
                                                    String(item.quantity),
                                                  );
                                                  setWriteOffNotes("");
                                                }}
                                              >
                                                <XCircle className="h-4 w-4" />
                                              </Button>
                                            )}
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </TableCell>
                              </TableRow>
                            )}
                          </>
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
                    Nessun lotto presso questo rivenditore. Trasferisci stock dal
                    Magazzino Centrale per popolare l'inventario.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ====================== TAB MOVIMENTI ====================== */}
          <TabsContent value="movements" className="space-y-4">
            {recentMovements.length > 0 ? (
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle>Movimenti di Magazzino</CardTitle>
                  <CardDescription>
                    Ultimi {recentMovements.length} movimenti registrati per
                    questo rivenditore (in entrata + uscite).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Data</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Prodotto</TableHead>
                        <TableHead>Lotto</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead>Da → A</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentMovements.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="text-muted-foreground text-sm">
                            {m.timestamp
                              ? format(
                                  new Date(m.timestamp),
                                  "dd/MM/yyyy HH:mm",
                                  { locale: it },
                                )
                              : "-"}
                          </TableCell>
                          <TableCell>{movementBadge(m.type)}</TableCell>
                          <TableCell className="font-medium">
                            {m.productName ?? "-"}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {m.batchNumber ?? "-"}
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {m.quantity}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <span>{m.fromLocationName ?? "—"}</span>
                              <ArrowRight className="h-3 w-3" />
                              <span>{m.toLocationName ?? "—"}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm max-w-xs truncate">
                            {m.notes || m.notesInternal || "-"}
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
                    Non sono stati registrati movimenti di magazzino per questo
                    rivenditore.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* ====================== Dialog WRITE-OFF ====================== */}
      <AlertDialog
        open={writeOffTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWriteOffTarget(null);
            setWriteOffQty("");
            setWriteOffNotes("");
          }
        }}
      >
        <AlertDialogContent>
          <form onSubmit={submitWriteOff}>
            <AlertDialogHeader>
              <AlertDialogTitle>Scarta lotto</AlertDialogTitle>
              <AlertDialogDescription>
                Stai scartando unità del lotto{" "}
                <strong className="font-mono">
                  {writeOffTarget?.batchNumber}
                </strong>{" "}
                ({writeOffTarget?.productName}). Verrà registrato un movimento{" "}
                <strong>EXPIRY_WRITE_OFF</strong>. Operazione irreversibile.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="writeOffQty">
                  Quantità da scartare (max {writeOffTarget?.maxQuantity ?? 0})
                </Label>
                <Input
                  id="writeOffQty"
                  type="number"
                  min={1}
                  max={writeOffTarget?.maxQuantity ?? 1}
                  value={writeOffQty}
                  onChange={(e) => setWriteOffQty(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="writeOffNotes">Note (opzionale)</Label>
                <Textarea
                  id="writeOffNotes"
                  rows={2}
                  placeholder="Es. Contaminazione, errore conservazione, scaduto"
                  value={writeOffNotes}
                  onChange={(e) => setWriteOffNotes(e.target.value)}
                />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Annulla</AlertDialogCancel>
              <AlertDialogAction
                type="submit"
                disabled={writeOffMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {writeOffMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Scarta
              </AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
