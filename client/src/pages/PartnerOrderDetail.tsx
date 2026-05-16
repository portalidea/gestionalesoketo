/**
 * M6.2.B Parte B — PartnerOrderDetail
 * Dettaglio ordine retailer: items con lotti, timeline stato, proforma, azioni (modifica/cancella).
 * Usa retailerSelfService.orderDetail + cancelOrder.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Clock,
  CreditCard,
  Edit,
  FileText,
  Loader2,
  Package,
  Truck,
  XCircle,
} from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "In attesa pagamento", color: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30" },
  paid: { label: "Pagato", color: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30" },
  approved_for_shipping: { label: "Approvato per spedizione", color: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/30" },
  transferring: { label: "In preparazione", color: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/30" },
  shipped: { label: "Spedito", color: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/30" },
  delivered: { label: "Consegnato", color: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30" },
  paid_on_delivery: { label: "Pagato alla consegna", color: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  cancelled: { label: "Cancellato", color: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30" },
};

const TIMELINE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  pending: Clock,
  paid: CreditCard,
  approved_for_shipping: CheckCircle2,
  transferring: Package,
  shipped: Truck,
  delivered: CheckCircle2,
  paid_on_delivery: CreditCard,
  cancelled: XCircle,
};

export default function PartnerOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const orderQuery = trpc.retailerSelfService.ordersGetById.useQuery(
    { orderId: id! },
    { enabled: Boolean(id) },
  );

  const cancelMutation = trpc.retailerSelfService.ordersCancel.useMutation({
    onSuccess: () => {
      toast.success("Ordine cancellato");
      utils.retailerSelfService.ordersGetById.invalidate({ orderId: id! });
      utils.retailerSelfService.ordersList.invalidate();
    },
    onError: (err) => {
      toast.error("Errore cancellazione", { description: err.message });
    },
  });

  const orderData = orderQuery.data;
  const order = orderData?.order;
  const canModify = orderData?.canModify ?? false;
  const canCancel = orderData?.canCancel ?? false;

  if (orderQuery.isLoading) {
    return (
      <PartnerLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
        </div>
      </PartnerLayout>
    );
  }

  if (!order || !orderData) {
    return (
      <PartnerLayout>
        <div className="text-center py-16">
          <p className="text-muted-foreground">Ordine non trovato.</p>
          <Button
            variant="ghost"
            className="mt-4"
            onClick={() => setLocation("/partner-portal/orders")}
          >
            Torna agli ordini
          </Button>
        </div>
      </PartnerLayout>
    );
  }

  const statusInfo = STATUS_LABELS[order.status] ?? { label: order.status, color: "" };
  const items = orderData.items ?? [];
  const statusHistory = orderData.statusHistory ?? [];

  return (
    <PartnerLayout>
      <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/partner-portal/orders")}
              className="gap-1"
            >
              <ArrowLeft className="h-4 w-4" />
              Ordini
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Ordine #{order.orderNumber}</h1>
              <Badge variant="outline" className={`mt-1 ${statusInfo.color}`}>
                {statusInfo.label}
              </Badge>
            </div>
          </div>
          {(canModify || canCancel) && (
            <div className="flex gap-2">
              {canModify && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocation(`/partner-portal/orders/${id}/edit`)}
                >
                  <Edit className="h-4 w-4 mr-1" />
                  Modifica
                </Button>
              )}
              {canCancel && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm">
                      <XCircle className="h-4 w-4 mr-1" />
                      Cancella
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancellare l'ordine?</AlertDialogTitle>
                      <AlertDialogDescription>
                        L'ordine #{order.orderNumber} verrà cancellato. Questa azione non è reversibile.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Annulla</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => cancelMutation.mutate({ orderId: id! })}
                      >
                        Conferma cancellazione
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}
        </div>

        {/* Cancelled reason */}
        {order.status === "cancelled" && order.cancelledReason && (
          <div className="bg-destructive/5 border border-destructive/20 rounded-lg p-4">
            <p className="text-sm text-destructive font-medium">Motivo cancellazione:</p>
            <p className="text-sm text-muted-foreground mt-1">{order.cancelledReason}</p>
          </div>
        )}

        {/* Timeline */}
        {statusHistory.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Stato ordine</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 flex-wrap">
                {statusHistory.map((step: any, i: number) => {
                  const Icon = TIMELINE_ICONS[step.status] ?? Circle;
                  const isActive = step.timestamp != null;
                  const isCurrent = step.status === order.status;
                  return (
                    <div key={step.status} className="flex items-center gap-2">
                      {i > 0 && (
                        <div
                          className={`h-px w-6 ${isActive ? "bg-[#7AB648]" : "bg-border"}`}
                        />
                      )}
                      <div
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${
                          isCurrent
                            ? "bg-[#7AB648]/10 text-[#7AB648] border border-[#7AB648]/30"
                            : isActive
                              ? "text-muted-foreground"
                              : "text-muted-foreground/40"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span>{STATUS_LABELS[step.status]?.label ?? step.status}</span>
                        {step.timestamp && (
                          <span className="text-[10px] opacity-70 ml-1">
                            {new Date(step.timestamp).toLocaleDateString("it-IT", {
                              day: "2-digit",
                              month: "short",
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Items */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prodotti ordinati</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prodotto</TableHead>
                  <TableHead className="text-center">Qtà</TableHead>
                  <TableHead className="text-right">Prezzo</TableHead>
                  <TableHead className="text-right">Totale</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item: any, idx: number) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{item.productName}</p>
                        <p className="text-xs text-muted-foreground">{item.productSku}</p>
                        {item.batchNumber && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Lotto {item.batchNumber}
                            {item.expirationDate && (
                              <> — Scad: {new Date(item.expirationDate).toLocaleDateString("it-IT")}</>
                            )}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">{item.quantity}</TableCell>
                    <TableCell className="text-right text-sm">
                      &euro;{parseFloat(item.unitPriceFinal).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-medium text-sm">
                      &euro;{(parseFloat(item.unitPriceFinal) * item.quantity).toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Totali + Proforma */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Totali</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotale netto</span>
                <span>&euro;{parseFloat(order.subtotalNet).toFixed(2)}</span>
              </div>
              {parseFloat(order.discountPercent ?? "0") > 0 && (
                <div className="flex justify-between text-sm text-[#7AB648]">
                  <span>Sconto: {order.discountPercent}%</span>
                  <span>applicato</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">IVA</span>
                <span>&euro;{parseFloat(order.vatAmount).toFixed(2)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between text-lg font-bold">
                <span>Totale</span>
                <span className="text-[#2D5A27] dark:text-[#7AB648]">
                  &euro;{parseFloat(order.totalGross).toFixed(2)}
                </span>
              </div>
            </CardContent>
          </Card>

          {order.ficProformaNumber && order.ficProformaNumber !== null && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4 text-[#7AB648]" />
                  Documenti
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    Proforma n. <strong>{order.ficProformaNumber}</strong>
                  </span>
                </div>
                {order.ficInvoiceNumber && (
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-[#7AB648]" />
                    <span className="text-sm">
                      Fattura n. <strong>{order.ficInvoiceNumber}</strong>
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Payment info for advance_transfer pending */}
        {order.status === "pending" && order.paymentTerms === "advance_transfer" && (
          <Card className="border-[#2D5A27]/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#2D5A27] dark:text-[#7AB648]">
                Dati per il bonifico
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              <p><span className="text-muted-foreground">Intestatario:</span> SoKeto S.r.l.</p>
              <p><span className="text-muted-foreground">IBAN:</span> <span className="font-mono">IT60X0542811101000000123456</span></p>
              <p><span className="text-muted-foreground">BIC:</span> BPLOIT2L</p>
              <p><span className="text-muted-foreground">Causale:</span> Ordine {order.orderNumber}</p>
              <p><span className="text-muted-foreground">Importo:</span> <strong>&euro;{parseFloat(order.totalGross).toFixed(2)}</strong></p>
            </CardContent>
          </Card>
        )}

        {/* Note */}
        {order.notes && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Note</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{order.notes}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </PartnerLayout>
  );
}
