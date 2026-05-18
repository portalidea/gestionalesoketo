/**
 * M6.2.B — OrderDetail page (Admin)
 * Dettaglio ordine con:
 * - Header: orderNumber, retailer, status badge, paymentTerms, totali
 * - Timeline status dinamica (basata su paymentTerms)
 * - Tabella items con snapshot prezzi + assegnazione lotti differita
 * - Card Documenti FiC (proforma + invoice)
 * - Card Azioni con state machine (nuove procedure)
 * - Note interne/esterne
 */
import { useState, useMemo, useCallback } from "react";
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
import { Input } from "@/components/ui/input";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
  Pencil,
  Plus,
  Receipt,
  ShoppingCart,
  RefreshCw,
  Trash2,
  Truck,
  XCircle,
} from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ChevronsUpDown } from "lucide-react";
import { getEventTypeLabel, getEventTypeColor } from "../../../shared/eventTypeLabels";

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
  approved_for_shipping: { label: "Approvato per spedizione", variant: "default", icon: Check, color: "text-green-600" },
  transferring: { label: "In trasferimento", variant: "secondary", icon: Package, color: "text-blue-500" },
  shipped: { label: "Spedito", variant: "secondary", icon: Truck, color: "text-indigo-500" },
  delivered: { label: "Consegnato", variant: "default", icon: CheckCircle2, color: "text-emerald-500" },
  paid_on_delivery: { label: "Pagato alla consegna", variant: "default", icon: CreditCard, color: "text-emerald-600" },
  cancelled: { label: "Annullato", variant: "destructive", icon: XCircle, color: "text-destructive" },
};

const PAYMENT_TERMS_LABELS: Record<string, string> = {
  advance_transfer: "Bonifico anticipato",
  on_delivery: "Pagamento alla consegna",
  credit_card: "Carta di credito",
};

// FSM: transizioni consentite — context-aware (dipende da paymentTerms)
function getAllowedTransitions(status: string, paymentTerms?: string | null): { status: string; label: string; variant: "default" | "destructive" | "outline"; mutation: string }[] {
  switch (status) {
    case "pending":
      if (paymentTerms === "on_delivery") {
        return [
          { status: "approved_for_shipping", label: "Approva per Spedizione", variant: "default", mutation: "approveForShipping" },
          { status: "cancelled", label: "Annulla Ordine", variant: "destructive", mutation: "cancelOrder" },
        ];
      }
      return [
        { status: "paid", label: "Conferma Pagamento", variant: "default", mutation: "confirmPayment" },
        { status: "cancelled", label: "Annulla Ordine", variant: "destructive", mutation: "cancelOrder" },
      ];
    case "paid":
      return [
        { status: "transferring", label: "Avvia Trasferimento", variant: "default", mutation: "startTransfer" },
        { status: "cancelled", label: "Annulla Ordine", variant: "destructive", mutation: "cancelOrder" },
      ];
    case "approved_for_shipping":
      return [
        { status: "transferring", label: "Avvia Trasferimento", variant: "default", mutation: "startTransfer" },
        { status: "cancelled", label: "Annulla Ordine", variant: "destructive", mutation: "cancelOrder" },
      ];
    case "transferring":
      return [
        { status: "shipped", label: "Segna come Spedito", variant: "default", mutation: "markShipped" },
      ];
    case "shipped":
      return [
        { status: "delivered", label: "Segna come Consegnato", variant: "default", mutation: "markDelivered" },
      ];
    case "delivered":
      if (paymentTerms === "on_delivery") {
        return [
          { status: "paid_on_delivery", label: "Conferma Pagamento alla Consegna", variant: "default", mutation: "confirmPaymentOnDelivery" },
        ];
      }
      return [];
    default:
      return [];
  }
}

// Timeline steps — dynamic based on payment terms
function getTimelineSteps(paymentTerms?: string | null) {
  const base: { key: string; label: string; tsField: string }[] = [
    { key: "pending", label: "Creato", tsField: "createdAt" },
  ];
  if (paymentTerms === "on_delivery") {
    base.push({ key: "approved_for_shipping", label: "Approvato", tsField: "approvedForShippingAt" });
  } else {
    base.push({ key: "paid", label: "Pagato", tsField: "paidAt" });
  }
  base.push(
    { key: "transferring", label: "In trasferimento", tsField: "transferringAt" },
    { key: "shipped", label: "Spedito", tsField: "shippedAt" },
    { key: "delivered", label: "Consegnato", tsField: "deliveredAt" },
  );
  if (paymentTerms === "on_delivery") {
    base.push({ key: "paid_on_delivery", label: "Pagato", tsField: "paidAt" });
  }
  return base;
}

/**
 * Sub-component: Combobox per selezione prodotto con search
 */
function ProductCombobox({
  products,
  value,
  onSelect,
}: {
  products: Array<{ id: string; sku: string; name: string; unitPrice?: string | null; vatRate?: string | null }>;
  value: string;
  onSelect: (productId: string, unitPrice: number, vatRate: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = products.find((p) => p.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between h-9 text-sm font-normal"
        >
          {selected ? (
            <span className="truncate">
              <span className="font-mono text-xs text-muted-foreground mr-1.5">{selected.sku}</span>
              {selected.name}
            </span>
          ) : (
            <span className="text-muted-foreground">Seleziona prodotto...</span>
          )}
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Cerca prodotto (SKU o nome)..." />
          <CommandList>
            <CommandEmpty>Nessun prodotto trovato.</CommandEmpty>
            <CommandGroup>
              {products.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.sku} ${p.name}`}
                  onSelect={() => {
                    const unitPrice = parseFloat(p.unitPrice || "0");
                    const vatRate = parseFloat(p.vatRate || "10");
                    onSelect(p.id, unitPrice, vatRate);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={`mr-2 h-4 w-4 ${value === p.id ? "opacity-100" : "opacity-0"}`}
                  />
                  <span className="font-mono text-xs text-muted-foreground mr-2">{p.sku}</span>
                  <span className="truncate">{p.name}</span>
                  {p.unitPrice && (
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      € {parseFloat(p.unitPrice).toFixed(2)}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

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
  const [cancelReason, setCancelReason] = useState("");
  const [editItemsOpen, setEditItemsOpen] = useState(false);
  const [editItems, setEditItems] = useState<Array<{ productId: string; quantity: number; unitPrice: number; vatRate: number }>>([]);

  const orderQuery = trpc.orders.getById.useQuery(
    { id: params.id ?? "" },
    { enabled: !!params.id }
  );

  // State machine mutations
  const confirmPayment = trpc.orders.confirmPayment.useMutation({
    onSuccess: () => { toast.success("Pagamento confermato"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });
  const approveForShipping = trpc.orders.approveForShipping.useMutation({
    onSuccess: () => { toast.success("Ordine approvato per spedizione"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });
  const startTransfer = trpc.orders.startTransfer.useMutation({
    onSuccess: () => { toast.success("Trasferimento avviato"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });
  const markShipped = trpc.orders.markShipped.useMutation({
    onSuccess: () => { toast.success("Ordine spedito"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });
  const markDelivered = trpc.orders.markDelivered.useMutation({
    onSuccess: () => { toast.success("Ordine consegnato"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });
  const confirmPaymentOnDelivery = trpc.orders.confirmPaymentOnDelivery.useMutation({
    onSuccess: () => { toast.success("Pagamento alla consegna confermato"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });
  const cancelOrder = trpc.orders.cancelOrder.useMutation({
    onSuccess: () => { toast.success("Ordine annullato"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });
  const deliverEventOrder = trpc.orders.deliverEventOrder.useMutation({
    onSuccess: () => { toast.success("Ordine evento consegnato"); invalidateOrder(); },
    onError: (err) => toast.error(err.message),
  });

  const generateProforma = trpc.orders.generateProforma.useMutation({
    onSuccess: (data) => {
      toast.success(`Proforma FiC generata: ${data.ficProformaNumber}`);
      invalidateOrder();
    },
    onError: (err) => toast.error(`Errore generazione proforma: ${err.message}`),
  });

  const regenerateProforma = trpc.orders.regenerateProforma.useMutation({
    onSuccess: (data) => {
      toast.success(`Proforma rigenerata: ${data.ficProformaNumber}`);
      invalidateOrder();
    },
    onError: (err) => toast.error(`Errore rigenerazione proforma: ${err.message}`),
  });

  // Products list for edit dialog
  const productsQuery = trpc.products.list.useQuery(undefined, { enabled: editItemsOpen });

  const modifyItemsMutation = trpc.orders.modifyOrderItems.useMutation({
    onSuccess: (data) => {
      toast.success(`Items aggiornati. Nuovo totale: € ${parseFloat(data.totalGross).toFixed(2)}`);
      if (data.warnings.length > 0) {
        data.warnings.forEach((w) => toast.warning(w));
      }
      if (data.ficUpdated) toast.info("Proforma FiC aggiornata");
      if (data.commissionRecalculated) toast.info("Commissione affiliato ricalcolata");
      setEditItemsOpen(false);
      invalidateOrder();
    },
    onError: (err) => toast.error(`Errore modifica items: ${err.message}`),
  });

  function invalidateOrder() {
    utils.orders.getById.invalidate({ id: params.id ?? "" });
    utils.orders.list.invalidate();
  }

  const mutationMap: Record<string, any> = {
    confirmPayment,
    approveForShipping,
    startTransfer,
    markShipped,
    markDelivered,
    confirmPaymentOnDelivery,
    cancelOrder,
  };

  const isAnyMutationPending = Object.values(mutationMap).some((m: any) => m.isPending);

  // Compute totals for edit dialog (must be before early returns to avoid React #310)
  const editSubtotalNet = useMemo(
    () => editItems.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0),
    [editItems]
  );
  const editVatAmount = useMemo(
    () => editItems.reduce((sum, it) => sum + it.quantity * it.unitPrice * (it.vatRate / 100), 0),
    [editItems]
  );
  const editTotalGross = editSubtotalNet + editVatAmount;
  const originalTotalGross = parseFloat(orderQuery.data?.totalGross ?? "0");

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
  const transitions = getAllowedTransitions(order.status, (order as any).paymentTerms);
  const isCancelled = order.status === "cancelled";
  const isDelivered = order.status === "delivered";
  const isPaidOnDelivery = order.status === "paid_on_delivery";
  const canEditBatches = !isCancelled && !isDelivered && !isPaidOnDelivery;
  const canEditItems = ["pending", "paid", "approved_for_shipping"].includes(order.status);

  function openEditItemsDialog() {
    // Pre-populate with current items including prices
    setEditItems(
      order.items.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        unitPrice: parseFloat(it.unitPriceFinal),
        vatRate: parseFloat(it.vatRate),
      }))
    );
    setEditItemsOpen(true);
  }

  function handleSaveEditItems() {
    const validItems = editItems.filter((it) => it.productId && it.quantity > 0);
    if (validItems.length === 0) {
      toast.error("Almeno un item richiesto");
      return;
    }
    modifyItemsMutation.mutate({
      orderId: order.id,
      items: validItems.map((it) => ({ productId: it.productId, quantity: it.quantity })),
    });
  }

  function updateEditItem(idx: number, patch: Partial<{ productId: string; quantity: number; unitPrice: number; vatRate: number }>) {
    setEditItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  // Timeline dinamica
  const timelineSteps = getTimelineSteps((order as any).paymentTerms);
  const activeStepIndex = isCancelled
    ? -1
    : timelineSteps.findIndex((s) => s.key === order.status);

  // Conteggio items senza lotto assegnato
  const unassignedCount = order.items.filter((it) => !it.batchId).length;
  const totalItems = order.items.length;
  const assignedCount = totalItems - unassignedCount;

  function handleTransition(mutation: string, orderId: string) {
    if (mutation === "cancelOrder") {
      cancelOrder.mutate({ orderId, reason: cancelReason || undefined });
    } else {
      mutationMap[mutation]?.mutate({ orderId });
    }
  }

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
              {(order as any).paymentTerms && (
                <Badge variant="outline" className="text-xs">
                  {PAYMENT_TERMS_LABELS[(order as any).paymentTerms] ?? (order as any).paymentTerms}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {(order as any).eventType ? (
                <>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mr-2 ${getEventTypeColor((order as any).eventType)}`}>
                    {getEventTypeLabel((order as any).eventType)}
                  </span>
                  {(order as any).eventName}
                  {(order as any).eventDate && ` — ${format(new Date((order as any).eventDate), "dd/MM/yyyy")}`}
                </>
              ) : (
                <>{order.retailerName}</>  
              )}
              {" "}— creato il{" "}
              {order.createdAt
                ? format(new Date(order.createdAt), "dd MMMM yyyy 'alle' HH:mm", { locale: it })
                : "—"}
            </p>
            {(order as any).fiscalReceiptRef && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Rif. scontrino: <span className="font-mono">{(order as any).fiscalReceiptRef}</span>
              </p>
            )}
          </div>
        </div>

        {/* Timeline status */}
        {!isCancelled && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                {timelineSteps.map((step, idx) => {
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
                {(order as any).cancelledReason && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Motivo: {(order as any).cancelledReason}
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
                <div className="flex items-center gap-2">
                  {canEditItems && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={openEditItemsDialog}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Modifica Items
                    </Button>
                  )}
                  {totalItems > 0 && (
                    <>
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
                    </>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Prodotto</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Prezzo unit.</TableHead>
                        <TableHead className="text-right">Totale netto</TableHead>
                        <TableHead>Lotto</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-mono text-xs">{item.productSku}</TableCell>
                          <TableCell className="font-medium text-sm">{item.productName}</TableCell>
                          <TableCell className="text-right font-mono">{item.quantity}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            € {parseFloat(item.unitPriceFinal).toFixed(2)}
                            {parseFloat(item.discountPercent) > 0 && (
                              <span className="text-xs text-muted-foreground line-through ml-1">
                                € {parseFloat(item.unitPriceBase).toFixed(2)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            € {parseFloat(item.lineTotalNet).toFixed(2)}
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
                <CardContent className="space-y-3">
                  {order.notes && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Note cliente</p>
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

          {/* Colonna destra: riepilogo + documenti + azioni */}
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
              </CardContent>
            </Card>

            {/* Documenti FiC */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Documenti FiC
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Proforma */}
                {order.ficProformaNumber && (
                  <div className="p-3 bg-muted/50 rounded-md">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Proforma</p>
                    <p className="text-sm font-mono font-medium">{order.ficProformaNumber}</p>
                  </div>
                )}

                {/* Invoice */}
                {(order as any).ficInvoiceNumber && (
                  <div className="p-3 bg-green-500/5 border border-green-500/20 rounded-md">
                    <p className="text-xs font-medium text-green-600 mb-1 flex items-center gap-1">
                      <Receipt className="h-3 w-3" /> Fattura
                    </p>
                    <p className="text-sm font-mono font-medium">{(order as any).ficInvoiceNumber}</p>
                  </div>
                )}

                {/* Azioni proforma */}
                {!order.ficProformaId && !isCancelled && (
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
                    Genera Proforma
                  </Button>
                )}

                {order.ficProformaId && !isCancelled && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      Proforma generata
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full justify-start gap-2 text-muted-foreground"
                          disabled={regenerateProforma.isPending}
                        >
                          {regenerateProforma.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Rigenera Proforma
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Rigenera proforma?</AlertDialogTitle>
                          <AlertDialogDescription>
                            La proforma precedente verrà eliminata da FiC e ne verrà creata una nuova con i dati aggiornati.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Annulla</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => regenerateProforma.mutate({ orderId: order.id })}
                          >
                            Rigenera
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}

                {!order.ficProformaId && !order.ficProformaNumber && !(order as any).ficInvoiceNumber && (
                  <p className="text-sm text-muted-foreground text-center py-1">
                    Nessun documento
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Azioni */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Azioni</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Transizioni status via state machine */}
                {transitions.map((t) => {
                  if (t.mutation === "cancelOrder") {
                    return (
                      <AlertDialog key={t.status}>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="destructive"
                            className="w-full justify-start gap-2"
                            disabled={isAnyMutationPending}
                          >
                            <XCircle className="h-4 w-4" />
                            {t.label}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Annullare l'ordine?</AlertDialogTitle>
                            <AlertDialogDescription>
                              L'ordine verrà annullato e la proforma eliminata da FiC (se presente).
                              Questa azione non è reversibile.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <div className="px-6">
                            <Input
                              placeholder="Motivo annullamento (opzionale)"
                              value={cancelReason}
                              onChange={(e) => setCancelReason(e.target.value)}
                            />
                          </div>
                          <AlertDialogFooter>
                            <AlertDialogCancel onClick={() => setCancelReason("")}>Indietro</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => {
                                handleTransition("cancelOrder", order.id);
                                setCancelReason("");
                              }}
                            >
                              Conferma Annullamento
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    );
                  }

                  return (
                    <Button
                      key={t.status}
                      variant={t.variant}
                      className="w-full justify-start gap-2"
                      disabled={isAnyMutationPending}
                      onClick={() => handleTransition(t.mutation, order.id)}
                    >
                      {isAnyMutationPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      {t.label}
                    </Button>
                  );
                })}

                {/* Deliver event order button */}
                {(order as any).eventType && order.status === "pending" && (
                  <Button
                    variant="default"
                    className="w-full justify-start gap-2"
                    disabled={isAnyMutationPending || deliverEventOrder.isPending}
                    onClick={() => deliverEventOrder.mutate({ orderId: order.id })}
                  >
                    {deliverEventOrder.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    Consegna Ordine Evento
                  </Button>
                )}
                {transitions.length === 0 && !(order as any).eventType && (
                  <p className="text-sm text-muted-foreground text-center py-2">
                    Nessuna azione disponibile
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Edit Items Dialog */}
      <Dialog open={editItemsOpen} onOpenChange={setEditItemsOpen}>
        <DialogContent className="!max-w-[1400px] w-[95vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Modifica Items - Ordine #{order.id.slice(0, 8)}</DialogTitle>
            <DialogDescription>
              Aggiungi, rimuovi o modifica le quantità. Il pricing verrà ricalcolato
              automaticamente con lo sconto del retailer. Lo stock non viene verificato
              (backorder consentito).
            </DialogDescription>
          </DialogHeader>

          {/* TABELLA ITEMS — ogni riga è un item dell'ordine */}
          <div className="mt-4 border rounded-lg overflow-hidden">
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{width: 'auto'}} />
                <col style={{width: '140px'}} />
                <col style={{width: '140px'}} />
                <col style={{width: '140px'}} />
                <col style={{width: '60px'}} />
              </colgroup>
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 text-sm font-medium">Prodotto</th>
                  <th className="text-right p-3 text-sm font-medium w-32">Quantità</th>
                  <th className="text-right p-3 text-sm font-medium w-32">Prezzo unit.</th>
                  <th className="text-right p-3 text-sm font-medium w-32">Totale</th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {editItems.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-muted-foreground">
                      Nessun item. Click "Aggiungi prodotto" per iniziare.
                    </td>
                  </tr>
                ) : editItems.map((item, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2">
                      <Select
                        value={item.productId || "_empty"}
                        onValueChange={(v) => {
                          if (v === "_empty") return;
                          const product = productsQuery.data?.find((p: any) => p.id === v);
                          const unitPrice = product ? parseFloat(product.unitPrice || "0") : 0;
                          const vatRate = product ? parseFloat(product.vatRate || "10") : 10;
                          updateEditItem(idx, { productId: v, unitPrice, vatRate });
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Seleziona prodotto..." />
                        </SelectTrigger>
                        <SelectContent>
                          {productsQuery.data?.map((p: any) => (
                            <SelectItem key={p.id} value={p.id}>
                              <span className="font-mono text-xs mr-2">{p.sku}</span>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        min={1}
                        value={item.quantity}
                        onChange={(e) => updateEditItem(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                        className="text-right tabular-nums w-full qty-input"
                      />
                    </td>
                    <td className="p-3 text-right tabular-nums text-sm">
                      {item.unitPrice > 0 ? `€ ${item.unitPrice.toFixed(2)}` : "—"}
                    </td>
                    <td className="p-3 text-right tabular-nums font-medium">
                      {item.unitPrice > 0 ? `€ ${(item.quantity * item.unitPrice).toFixed(2)}` : "—"}
                    </td>
                    <td className="p-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditItems(editItems.filter((_, i) => i !== idx))}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* PULSANTE AGGIUNGI */}
          <Button
            variant="outline"
            onClick={() => setEditItems([...editItems, { productId: "", quantity: 1, unitPrice: 0, vatRate: 10 }])}
            className="mt-4"
          >
            <Plus className="mr-2 h-4 w-4" />
            Aggiungi prodotto
          </Button>

          {/* BOX TOTALI */}
          <div className="mt-6 ml-auto w-full sm:w-80 bg-muted/50 p-4 rounded-lg">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotale netto:</span>
              <span className="tabular-nums">€ {editSubtotalNet.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="text-muted-foreground">IVA:</span>
              <span className="tabular-nums">€ {editVatAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold text-lg mt-2 pt-2 border-t">
              <span>Totale:</span>
              <span className="tabular-nums">€ {editTotalGross.toFixed(2)}</span>
            </div>
            {Math.abs(editTotalGross - originalTotalGross) > 0.01 && (
              <div className="mt-3 pt-3 border-t text-sm text-orange-600 dark:text-orange-400">
                Delta vs ordine corrente:{" "}
                <span className="font-medium tabular-nums ml-2">
                  {editTotalGross > originalTotalGross ? "+" : ""}
                  € {(editTotalGross - originalTotalGross).toFixed(2)}
                </span>
              </div>
            )}
          </div>

          {/* WARNING SE ORDINE PAID */}
          {order.status === "paid" && Math.abs(editTotalGross - originalTotalGross) > 0.01 && (
            <Alert className="mt-4 border-orange-500/30">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Ordine già pagato</AlertTitle>
              <AlertDescription>
                La modifica genererà differenza vs importo bonificato.{" "}
                {editTotalGross > originalTotalGross
                  ? `Il retailer dovrà integrare € ${(editTotalGross - originalTotalGross).toFixed(2)}.`
                  : `Va rimborsato al retailer € ${(originalTotalGross - editTotalGross).toFixed(2)}.`
                }
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={() => setEditItemsOpen(false)}>
              Annulla
            </Button>
            <Button
              onClick={handleSaveEditItems}
              disabled={
                modifyItemsMutation.isPending ||
                editItems.length === 0 ||
                editItems.some((it) => !it.productId || it.quantity <= 0)
              }
            >
              {modifyItemsMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
