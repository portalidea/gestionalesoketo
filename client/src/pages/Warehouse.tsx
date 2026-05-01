import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
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
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";

export default function Warehouse() {
  const [, setLocation] = useLocation();
  const { data: overview, isLoading } = trpc.warehouse.getStockOverview.useQuery();
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  const totalProducts = overview?.length ?? 0;
  let totalActiveBatches = 0;
  let totalStock = 0;
  let expiringBatches = 0;
  const now = Date.now();

  if (overview) {
    for (const p of overview) {
      totalActiveBatches += p.activeBatchCount;
      totalStock += p.totalStock;
      for (const b of p.batches) {
        if (b.quantity > 0) {
          const days = Math.floor(
            (new Date(b.expirationDate).getTime() - now) / 86_400_000,
          );
          if (days > 0 && days <= 30) expiringBatches++;
        }
      }
    }
  }

  const formatDate = (d: string | null) =>
    d ? format(new Date(d), "dd/MM/yyyy") : "-";

  const expirationBadge = (expirationDate: string | null, qty: number) => {
    if (!expirationDate || qty <= 0) return null;
    const days = Math.floor(
      (new Date(expirationDate).getTime() - now) / 86_400_000,
    );
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

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">
            Magazzino Centrale
          </h1>
          <p className="text-muted-foreground">
            Stock SoKeto E-Keto Food per prodotto e lotto. Click su una riga per
            vedere il dettaglio dei lotti.
          </p>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Prodotti a magazzino</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Package className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold text-foreground">
                  {totalProducts}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Lotti attivi</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <WarehouseIcon className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold text-foreground">
                  {totalActiveBatches}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>Stock complessivo</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Package className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold text-foreground">
                  {totalStock}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardDescription>In scadenza &lt; 30gg</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-orange-500" />
                <span className="text-2xl font-bold text-foreground">
                  {expiringBatches}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabella prodotti */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : overview && overview.length > 0 ? (
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>Prodotti a magazzino</CardTitle>
              <CardDescription>
                Stock totale e lotti per ogni prodotto presente in magazzino
                centrale
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Prodotto</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Lotti attivi</TableHead>
                    <TableHead>Scadenza più vicina</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.map((p) => {
                    const isExpanded = expandedProductId === p.productId;
                    const nearestDays = p.nearestExpiration
                      ? Math.floor(
                          (new Date(p.nearestExpiration).getTime() - now) /
                            86_400_000,
                        )
                      : null;
                    const nearestColor =
                      nearestDays === null
                        ? "text-muted-foreground"
                        : nearestDays <= 0
                          ? "text-destructive font-semibold"
                          : nearestDays <= 30
                            ? "text-orange-500 font-semibold"
                            : "text-foreground";
                    return (
                      <>
                        <TableRow
                          key={p.productId}
                          className="cursor-pointer hover:bg-accent/50"
                          onClick={() =>
                            setExpandedProductId(isExpanded ? null : p.productId)
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
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setLocation(`/products/${p.productId}`);
                              }}
                              className="text-left hover:text-primary transition-colors"
                            >
                              {p.productName}
                            </button>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {p.productSku}
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {p.totalStock}
                            {p.productUnit && (
                              <span className="text-muted-foreground ml-1 font-normal">
                                {p.productUnit}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {p.activeBatchCount}
                          </TableCell>
                          <TableCell className={nearestColor}>
                            {formatDate(p.nearestExpiration)}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow key={`${p.productId}-detail`}>
                            <TableCell></TableCell>
                            <TableCell colSpan={5} className="bg-accent/20 py-4">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Batch</TableHead>
                                    <TableHead>Produttore</TableHead>
                                    <TableHead>Scadenza</TableHead>
                                    <TableHead className="text-right">Qty iniziale</TableHead>
                                    <TableHead className="text-right">Stock residuo</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {p.batches.map((b) => (
                                    <TableRow key={b.batchId}>
                                      <TableCell className="font-mono text-xs">
                                        {b.batchNumber}
                                      </TableCell>
                                      <TableCell className="text-muted-foreground">
                                        {b.producerName ?? "-"}
                                      </TableCell>
                                      <TableCell>
                                        <div className="flex items-center gap-2">
                                          <span>{formatDate(b.expirationDate)}</span>
                                          {expirationBadge(
                                            b.expirationDate,
                                            b.quantity,
                                          )}
                                        </div>
                                      </TableCell>
                                      <TableCell className="text-right text-muted-foreground">
                                        {b.initialQuantity}
                                      </TableCell>
                                      <TableCell className="text-right font-semibold">
                                        {b.quantity}
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
              <WarehouseIcon className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Magazzino centrale vuoto
              </h3>
              <p className="text-muted-foreground text-center max-w-md">
                Nessuno stock presente. Per registrare un ingresso vai nella
                pagina di un prodotto e clicca su <strong>+ Aggiungi lotto</strong>.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
