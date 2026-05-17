import { Link, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft,
  ShoppingCart,
  RotateCcw,
  Package,
  ArrowDownUp,
  AlertTriangle,
} from "lucide-react";

const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "In Attesa", variant: "secondary" },
  processed: { label: "Processato", variant: "default" },
  partial: { label: "Parziale", variant: "outline" },
  failed: { label: "Fallito", variant: "destructive" },
};

export default function MarketplaceShopifyOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, refetch } = trpc.shopify.orders.getById.useQuery(
    { marketplaceOrderId: id! },
    { enabled: !!id },
  );

  const retryMutation = trpc.shopify.orders.retry.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success("Stock processato con successo!");
      } else {
        toast.error(`Retry fallito: ${result.errors?.join(", ") || result.status}`);
      }
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-64" />
            <div className="h-48 bg-muted rounded" />
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (!data) {
    return (
      <DashboardLayout>
        <div className="p-6 text-center py-12">
          <p className="text-muted-foreground">Ordine non trovato</p>
          <Link href="/marketplace/shopify/orders">
            <Button variant="outline" className="mt-4">Torna alla lista</Button>
          </Link>
        </div>
      </DashboardLayout>
    );
  }

  const { order, items, stockMovements, canRetry } = data;
  const statusInfo = statusLabels[order.stockProcessingStatus || "pending"];

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/marketplace/shopify/orders">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <ShoppingCart className="h-6 w-6" />
                Ordine #{order.channelOrderNumber}
              </h1>
              <p className="text-muted-foreground">
                Shopify ID: {order.channelOrderId}
              </p>
            </div>
          </div>
          {canRetry && (
            <Button
              onClick={() => retryMutation.mutate({ marketplaceOrderId: order.id })}
              disabled={retryMutation.isPending}
            >
              <RotateCcw className={`h-4 w-4 mr-1 ${retryMutation.isPending ? "animate-spin" : ""}`} />
              Retry Stock
            </Button>
          )}
        </div>

        {/* Order Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Informazioni Ordine</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Cliente</span>
                <span className="text-sm font-medium">{order.customerName || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Email</span>
                <span className="text-sm">{order.customerEmail || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Data Ordine</span>
                <span className="text-sm">
                  {order.orderDate
                    ? new Date(order.orderDate).toLocaleString("it-IT")
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Totale</span>
                <span className="text-sm font-mono font-bold">
                  €{parseFloat(order.totalGross || "0").toFixed(2)} {order.currency}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Sincronizzato</span>
                <span className="text-sm">
                  {order.syncedAt
                    ? new Date(order.syncedAt).toLocaleString("it-IT")
                    : "—"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Stato Elaborazione Stock</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Stato</span>
                <Badge variant={statusInfo?.variant || "secondary"}>
                  {statusInfo?.label || order.stockProcessingStatus}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Tentativi</span>
                <span className="text-sm">{order.stockProcessingAttempts || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Processato il</span>
                <span className="text-sm">
                  {order.stockProcessedAt
                    ? new Date(order.stockProcessedAt).toLocaleString("it-IT")
                    : "Non ancora"}
                </span>
              </div>
              {order.stockProcessingError && (
                <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-md">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-red-700 font-mono break-all">
                      {order.stockProcessingError}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Line Items */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4" />
              Righe Ordine ({items.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU Shopify</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Prodotto Interno</TableHead>
                  <TableHead className="text-center">Qtà Shopify</TableHead>
                  <TableHead className="text-center">Pezzi Interni</TableHead>
                  <TableHead className="text-right">Prezzo</TableHead>
                  <TableHead className="text-right">Totale Riga</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-sm">{item.channelSku}</TableCell>
                    <TableCell className="max-w-[150px] truncate">{item.displayName}</TableCell>
                    <TableCell>
                      {item.productName ? (
                        <span className="text-sm">
                          {item.productName}{" "}
                          <span className="text-muted-foreground">({item.productSku})</span>
                        </span>
                      ) : (
                        <Badge variant="destructive" className="text-xs">Non mappato</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center">{item.channelQuantity}</TableCell>
                    <TableCell className="text-center font-medium">{item.piecesQuantity}</TableCell>
                    <TableCell className="text-right font-mono">
                      €{parseFloat(item.unitPrice || "0").toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      €{parseFloat(item.lineTotal || "0").toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Stock Movements */}
        {stockMovements.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowDownUp className="h-4 w-4" />
                Movimenti Stock Generati ({stockMovements.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Prodotto</TableHead>
                    <TableHead className="text-center">Quantità</TableHead>
                    <TableHead className="text-center">Prima</TableHead>
                    <TableHead className="text-center">Dopo</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stockMovements.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {m.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{m.productId?.slice(0, 8)}...</TableCell>
                      <TableCell className="text-center font-mono">{m.quantity}</TableCell>
                      <TableCell className="text-center text-muted-foreground">
                        {m.previousQuantity ?? "—"}
                      </TableCell>
                      <TableCell className="text-center font-medium">
                        {m.newQuantity ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {m.timestamp
                          ? new Date(m.timestamp).toLocaleString("it-IT")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[150px] truncate">
                        {m.notesInternal || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
