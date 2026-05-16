/**
 * M7-B — AffiliateCommissions
 * Lista commissioni con filtri, dettaglio ordine, export CSV.
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import AffiliateLayout from "@/components/AffiliateLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Download, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

type CommissionStatus = "pending" | "paid" | "voided";

export default function AffiliateCommissions() {
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<CommissionStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const limit = 20;

  const queryInput = useMemo(
    () => ({
      status: statusFilter === "all" ? undefined : [statusFilter] as CommissionStatus[],
      limit,
      offset,
    }),
    [offset, statusFilter],
  );

  const { data, isLoading } = trpc.affiliatePortal.commissionsList.useQuery(queryInput);
  const { data: detail, isLoading: loadingDetail } =
    trpc.affiliatePortal.commissionsGetById.useQuery(
      { commissionId: selectedId! },
      { enabled: Boolean(selectedId) },
    );

  const exportMutation = trpc.affiliatePortal.commissionsExportCSV.useMutation();

  const formatCurrency = (amount: number | string) => {
    const num = typeof amount === "string" ? parseFloat(amount) : amount;
    return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(num);
  };

  const formatDate = (date: Date | string | null) => {
    if (!date) return "-";
    return new Date(date).toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  const statusBadge = (s: CommissionStatus) => {
    const map: Record<CommissionStatus, { label: string; variant: "default" | "secondary" | "destructive" }> = {
      pending: { label: "In attesa", variant: "secondary" },
      paid: { label: "Pagata", variant: "default" },
      voided: { label: "Annullata", variant: "destructive" },
    };
    const { label, variant } = map[s];
    return <Badge variant={variant}>{label}</Badge>;
  };

  const handleExport = async () => {
    try {
      const result = await exportMutation.mutateAsync({
        status: statusFilter === "all" ? undefined : [statusFilter],
      });
      // result is the CSV content object with { csv } or string
      const csvContent = typeof result === "string" ? result : (result as any).csv || JSON.stringify(result);
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `commissioni_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Export CSV completato");
    } catch {
      toast.error("Errore durante l'export");
    }
  };

  const page = Math.floor(offset / limit) + 1;
  const totalPages = data ? Math.ceil(data.totalCount / limit) : 1;

  return (
    <AffiliateLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Commissioni</h1>
            <p className="text-muted-foreground">Storico completo delle tue commissioni</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exportMutation.isPending}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v as CommissionStatus | "all");
                  setOffset(0);
                }}
              >
                <SelectTrigger className="sm:w-[180px]">
                  <SelectValue placeholder="Tutti gli stati" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tutti gli stati</SelectItem>
                  <SelectItem value="pending">In attesa</SelectItem>
                  <SelectItem value="paid">Pagate</SelectItem>
                  <SelectItem value="voided">Annullate</SelectItem>
                </SelectContent>
              </Select>
              {data && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground ml-auto">
                  Totale: <span className="font-medium text-foreground">{formatCurrency(data.totalAmount)}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Caricamento...</div>
            ) : !data || data.items.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                Nessuna commissione trovata.
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead>Retailer</TableHead>
                      <TableHead>Ordine</TableHead>
                      <TableHead className="text-right">Importo ordine</TableHead>
                      <TableHead className="text-right">Commissione</TableHead>
                      <TableHead>Stato</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-sm">
                          {formatDate(c.pendingAt)}
                        </TableCell>
                        <TableCell className="font-medium">{c.retailerName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          #{c.orderNumber}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {formatCurrency(c.orderTotal)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(c.commissionAmount)}
                        </TableCell>
                        <TableCell>{statusBadge(c.status as CommissionStatus)}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSelectedId(c.id)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Pagination */}
                <div className="flex items-center justify-between px-4 py-3 border-t">
                  <p className="text-sm text-muted-foreground">
                    {data.totalCount} commissioni totali
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={offset <= 0}
                      onClick={() => setOffset((o) => Math.max(0, o - limit))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm">
                      {page} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={page >= totalPages}
                      onClick={() => setOffset((o) => o + limit)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Detail Dialog */}
        <Dialog open={Boolean(selectedId)} onOpenChange={(open) => !open && setSelectedId(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Dettaglio Commissione</DialogTitle>
            </DialogHeader>
            {loadingDetail ? (
              <div className="py-8 text-center text-muted-foreground">Caricamento...</div>
            ) : detail ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Retailer</p>
                    <p className="font-medium">{detail.retailer.name}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Stato</p>
                    <div>{statusBadge(detail.status as CommissionStatus)}</div>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Ordine</p>
                    <p className="font-medium">#{detail.order.number}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Data ordine</p>
                    <p>{formatDate(detail.order.date)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Importo ordine</p>
                    <p className="font-medium">{formatCurrency(detail.order.totalNet)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Commissione</p>
                    <p className="font-medium text-green-600">
                      {formatCurrency(detail.commissionAmount)} ({detail.commissionRate}%)
                    </p>
                  </div>
                  {detail.paidAt && (
                    <div>
                      <p className="text-muted-foreground">Pagata il</p>
                      <p>{formatDate(detail.paidAt)}</p>
                    </div>
                  )}
                  {detail.isFirstOrder && (
                    <div>
                      <p className="text-muted-foreground">Tipo</p>
                      <Badge variant="secondary">Primo ordine</Badge>
                    </div>
                  )}
                </div>

                {/* Order items */}
                {detail.order.items && detail.order.items.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">Prodotti nell'ordine:</p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Prodotto</TableHead>
                          <TableHead className="text-right">Qtà</TableHead>
                          <TableHead className="text-right">Prezzo</TableHead>
                          <TableHead className="text-right">Totale</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.order.items.map((item: { productName: string; quantity: number; unitPrice: string; totalPrice: string }, idx: number) => (
                          <TableRow key={idx}>
                            <TableCell className="text-sm">{item.productName}</TableCell>
                            <TableCell className="text-right">{item.quantity}</TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(item.unitPrice)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(item.totalPrice)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </AffiliateLayout>
  );
}
