/**
 * M6.2.A — OrderDetail page (Admin)
 * Dettaglio ordine con:
 * - Header: orderNumber, retailer, status badge, totali
 * - Timeline status con bottoni transizione FSM
 * - Tabella items con snapshot prezzi + assegnazione lotti differita
 * - Bottone "Genera Proforma FiC" (se ficClientId presente)
 * - Note interne/esterne
 */
import DashboardLayout from "@/components/DashboardLayout";
import { daysToExpiry, getExpiryColorClass, getExpiryLabel } from "@/lib/expiry-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  Loader2,
  Package,
  ShoppingCart,
  Truck,
  XCircle,
} from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

const STATUS_CONFIG: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: React.ElementType;
    color: string;
  }
> = {
  pending: { label: "In attesa", variant: "outline", icon: Clock, color: "text-muted-foreground" },
  paid: { label: "Pagato", variant: "default", icon: CreditCard, color: "text-green-500" },
  transferring: { label: "In trasferimento", variant: "secondary", icon: Package, color: "text-blue-500" },
  shipped: { label: "Spedito", variant: "secondary", icon: Truck, color: "text-indigo-500" },
  delivered: { label: "Consegnato", variant: "default", icon: CheckCircle2, color: "text-emerald-500" },
  cancelled: { label: "Annullato", variant: "destructive", icon: XCircle, color: "text-destructive" },
};

// FSM: transizioni consentite (mirror del backend)
const ALLOWED_TRANSITIONS: Record<string, { status: string; label: string; variant: "default" | "destructive" | "outline" }[]> = {
  pending: [
    { status: "paid", label: "Segna come Pagato", variant: "default" },
    { status: "cancelled", label: "Annulla", variant: "destructive" },
  ],
  paid: [
    { status: "transferring", label: "Avvia Trasferimento", variant: "default" },
    { status: "cancelled", label: "Annulla", variant: "destructive" },
  ],
  transferring: [
    { status: "shipped", label: "Segna come Spedito", variant: "default" },
    { status: "cancelled", label: "Annulla", variant: "destructive" },
  ],
  shipped: [
    { status: "delivered", label: "Segna come Consegnato", variant: "default" },
  ],
  delivered: [],
  cancelled: [],
};

// Timeline steps
const TIMELINE_STEPS = [
  { key: "pending", label: "Creato", tsField: "createdAt" },
  { key: "paid", label: "Pagato", tsField: "paidAt" },
  { key: "transferring", label: "In trasferimento", tsField: "transferringAt" },
  { key: "shipped", label: "Spedito", tsField: "shippedAt" },
  { key: "delivered", label: "Consegnato", tsField: "deliveredAt" },
];

const NO_BATCH = "__none__";

/**
 * Sub-component: batch selector per un singolo orderItem
 */
function BatchSelector({
  item,
  canEdit,
  orderId,
}: {
  item: {
    id: string;
    productId: string;
    batchId: string | null;
    batchNumber: string | null;
    expirationDate: string | null;
  };
  canEdit: boolean;
  orderId: string;
}) {
  const utils = trpc.useUtils();

  const batchesQuery = trpc.orders.batchesForProduct.useQuery(
    { productId: item.productId },
    { enabled: canEdit },
  );

  const assignBatch = trpc.orders.assignBatch.useMutation({
    onSuccess: (data) => {
      utils.orders.getById.invalidate({ id: orderId });
      if (data.batchId) {
        toast.success(`Lotto ${data.batchNumber} assegnato`);
      } else {
        toast.success("Lotto rimosso");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  // Se non editabile, mostra solo il lotto assegnato
  if (!canEdit) {
    if (item.batchNumber) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="font-mono text-xs">
                {item.batchNumber}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              Scad. {item.expirationDate ?? "—"}
              {(() => {
                const days = daysToExpiry(item.expirationDate);
                const cls = getExpiryColorClass(days);
                return cls ? <span className={`ml-1 ${cls}`}>({getExpiryLabel(days)})</span> : null;
              })()}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    return <span className="text-muted-foreground text-xs">—</span>;
  }

  // Editabile: mostra select
  return (
    <div className="min-w-[160px]">
      <Select
        value={item.batchId ?? NO_BATCH}
        onValueChange={(val) => {
          assignBatch.mutate({
            orderItemId: item.id,
            batchId: val === NO_BATCH ? null : val,
          });
        }}
        disabled={assignBatch.isPending}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="Seleziona lotto..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_BATCH}>
            <span className="text-muted-foreground">Nessun lotto</span>
          </SelectItem>
          {batchesQuery.data?.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              <span className="font-mono">{b.batchNumber}</span>
              <span className={`ml-2 text-xs ${getExpiryColorClass(daysToExpiry(b.expirationDate)) || 'text-muted-foreground'}`}>
                scad. {b.expirationDate}
                {(() => {
                  const days = daysToExpiry(b.expirationDate);
                  const label = getExpiryLabel(days);
                  return label ? ` (${label})` : '';
                })()}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function OrderDetail() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const orderQuery = trpc.orders.getById.useQuery(
    { id: params.id ?? "" },
    { enabled: !!params.id }
  );

  const updateStatus = trpc.orders.updateStatus.useMutation({
    onSuccess: (data) => {
      toast.success(`Stato aggiornato a: ${STATUS_CONFIG[data.status]?.label ?? data.status}`);
      utils.orders.getById.invalidate({ id: params.id ?? "" });
      utils.orders.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
    },
  });

  const generateProforma = trpc.orders.generateProforma.useMutation({
    onSuccess: (data) => {
      toast.success(`Proforma FiC generata: ${data.ficProformaNumber}`);
      utils.orders.getById.invalidate({ id: params.id ?? "" });
      utils.orders.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Errore generazione proforma: ${err.message}`);
    },
  });

  if (orderQuery.isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  if (!orderQuery.data) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <ShoppingCart className="h-10 w-10 mb-3 opacity-40" />
          <p>Ordine non trovato</p>
          <Button variant="link" onClick={() => setLocation("/orders")}>
            Torna alla lista
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  const order = orderQuery.data;
  const statusCfg = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = statusCfg.icon;
  const transitions = ALLOWED_TRANSITIONS[order.status] ?? [];
  const isCancelled = order.status === "cancelled";
  const isDelivered = order.status === "delivered";
  const canEditBatches = !isCancelled && !isDelivered;

  // Determina quale step della timeline è attivo
  const activeStepIndex = isCancelled
    ? -1
    : TIMELINE_STEPS.findIndex((s) => s.key === order.status);

  // Conteggio items senza lotto assegnato
  const unassignedCount = order.items.filter((it) => !it.batchId).length;
  const totalItems = order.items.length;
  const assignedCount = totalItems - unassignedCount;

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/orders")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight font-mono">
                {order.orderNumber}
              </h1>
              <Badge variant={statusCfg.variant} className="gap-1">
                <StatusIcon className="h-3 w-3" />
                {statusCfg.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {order.retailerName} — creato il{" "}
              {order.createdAt
                ? format(new Date(order.createdAt), "dd MMMM yyyy 'alle' HH:mm", { locale: it })
                : "—"}
            </p>
          </div>
        </div>

        {/* Timeline status */}
        {!isCancelled && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                {TIMELINE_STEPS.map((step, idx) => {
                  const isCompleted = idx <= activeStepIndex;
                  const isCurrent = idx === activeStepIndex;
                  const ts = (order as any)[step.tsField];
                  return (
                    <div key={step.key} className="flex-1 flex flex-col items-center relative">
                      {/* Linea connettore */}
                      {idx > 0 && (
                        <div
                          className={`absolute top-4 right-1/2 w-full h-0.5 -translate-y-1/2 ${
                            isCompleted ? "bg-primary" : "bg-muted"
                          }`}
                          style={{ zIndex: 0 }}
                        />
                      )}
                      {/* Cerchio */}
                      <div
                        className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center border-2 ${
                          isCompleted
                            ? "bg-primary border-primary text-primary-foreground"
                            : "bg-background border-muted text-muted-foreground"
                        } ${isCurrent ? "ring-2 ring-primary/30" : ""}`}
                      >
                        {isCompleted ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <span className="text-xs font-medium">{idx + 1}</span>
                        )}
                      </div>
                      <span
                        className={`mt-2 text-xs font-medium ${
                          isCurrent ? "text-primary" : isCompleted ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {step.label}
                      </span>
                      {ts && (
                        <span className="text-[10px] text-muted-foreground mt-0.5">
                          {format(new Date(ts), "dd/MM HH:mm")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cancelled banner */}
        {isCancelled && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="pt-6 flex items-center gap-3">
              <XCircle className="h-5 w-5 text-destructive" />
              <div>
                <p className="font-medium text-destructive">Ordine annullato</p>
                {order.cancelledAt && (
                  <p className="text-sm text-muted-foreground">
                    Annullato il {format(new Date(order.cancelledAt), "dd MMMM yyyy 'alle' HH:mm", { locale: it })}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Warning: items senza lotto */}
        {canEditBatches && unassignedCount > 0 && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="pt-6 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <div>
                <p className="font-medium text-amber-600 dark:text-amber-400">
                  {unassignedCount} item{unassignedCount > 1 ? "s" : ""} senza lotto assegnato
                </p>
                <p className="text-sm text-muted-foreground">
                  Assegna i lotti prima di spedire l'ordine. Seleziona il lotto dalla colonna "Lotto" nella tabella sottostante.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Colonna sinistra: items + note */}
          <div className="lg:col-span-2 space-y-6">
            {/* Items */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Righe ordine</CardTitle>
                {totalItems > 0 && (
                  <div className="flex items-center gap-2">
                    {assignedCount > 0 && (
                      <Badge variant="outline" className="text-xs gap-1 text-emerald-500 border-emerald-500/30">
                        <Check className="h-3 w-3" />
                        {assignedCount}/{totalItems} con lotto
                      </Badge>
                    )}
                    {unassignedCount > 0 && canEditBatches && (
                      <Badge variant="outline" className="text-xs gap-1 text-amber-500 border-amber-500/30">
                        <AlertTriangle className="h-3 w-3" />
                        {unassignedCount} senza lotto
                      </Badge>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Prodotto</TableHead>
                        <TableHead className="text-right">Qtà</TableHead>
                        <TableHead className="text-right">Prezzo finale</TableHead>
                        <TableHead className="text-right">IVA</TableHead>
                        <TableHead className="text-right">Totale lordo</TableHead>
                        <TableHead>Lotto</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-mono text-xs">{item.productSku}</TableCell>
                          <TableCell className="text-sm">{item.productName}</TableCell>
                          <TableCell className="text-right">{item.quantity}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            € {parseFloat(item.unitPriceFinal).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {parseFloat(item.vatRate).toFixed(0)}%
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-medium">
                            € {parseFloat(item.lineTotalGross).toFixed(2)}
                          </TableCell>
                          <TableCell>
                            <BatchSelector
                              item={item}
                              canEdit={canEditBatches}
                              orderId={order.id}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Note */}
            {(order.notes || order.notesInternal) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Note</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {order.notes && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Note ordine</p>
                      <p className="text-sm whitespace-pre-wrap">{order.notes}</p>
                    </div>
                  )}
                  {order.notesInternal && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Note interne</p>
                      <p className="text-sm whitespace-pre-wrap text-amber-500/80">{order.notesInternal}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Colonna destra: riepilogo + azioni */}
          <div className="space-y-6">
            {/* Riepilogo totali */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Riepilogo</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 text-sm">
                  {parseFloat(order.discountPercent) > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Sconto pacchetto</span>
                      <span className="text-green-500">-{parseFloat(order.discountPercent).toFixed(0)}%</span>
                    </div>
                  )}
                  <div className="flex justify-between text-muted-foreground">
                    <span>Subtotale netto</span>
                    <span className="font-mono">€ {parseFloat(order.subtotalNet).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>IVA</span>
                    <span className="font-mono">€ {parseFloat(order.vatAmount).toFixed(2)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between font-semibold text-lg">
                    <span>Totale lordo</span>
                    <span className="font-mono">€ {parseFloat(order.totalGross).toFixed(2)}</span>
                  </div>
                </div>

                {/* Proforma FiC */}
                {order.ficProformaNumber && (
                  <div className="mt-4 p-3 bg-muted/50 rounded-md">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Proforma FiC</p>
                    <p className="text-sm font-mono font-medium">{order.ficProformaNumber}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Azioni */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Azioni</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Transizioni status */}
                {transitions.map((t) => (
                  <Button
                    key={t.status}
                    variant={t.variant}
                    className="w-full justify-start gap-2"
                    disabled={updateStatus.isPending}
                    onClick={() => {
                      if (t.status === "cancelled") {
                        if (!confirm("Sei sicuro di voler annullare questo ordine?")) return;
                      }
                      updateStatus.mutate({
                        orderId: order.id,
                        newStatus: t.status as any,
                      });
                    }}
                  >
                    {updateStatus.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : t.status === "cancelled" ? (
                      <XCircle className="h-4 w-4" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    {t.label}
                  </Button>
                ))}

                {transitions.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-2">
                    Nessuna azione disponibile
                  </p>
                )}

                <Separator />

                {/* Genera proforma FiC */}
                {!order.ficProformaId && (
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    disabled={generateProforma.isPending}
                    onClick={() => generateProforma.mutate({ orderId: order.id })}
                  >
                    {generateProforma.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                    Genera Proforma FiC
                  </Button>
                )}

                {order.ficProformaId && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    Proforma già generata
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
