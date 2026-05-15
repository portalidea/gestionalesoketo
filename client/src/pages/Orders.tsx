/**
 * M6.2.A — Orders list page (Admin)
 * Lista ordini con filtri status, retailer, date range.
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  ShoppingCart,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  SortableTableHead,
  sortData,
  type SortConfig,
} from "@/components/SortableTableHead";

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "In attesa", variant: "outline" },
  paid: { label: "Pagato", variant: "default" },
  transferring: { label: "In trasferimento", variant: "secondary" },
  shipped: { label: "Spedito", variant: "secondary" },
  delivered: { label: "Consegnato", variant: "default" },
  cancelled: { label: "Annullato", variant: "destructive" },
};

const ALL_STATUSES = "ALL_STATUSES";

export default function Orders() {
  const [, setLocation] = useLocation();
  const [sort, setSort] = useState<SortConfig>(null);
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);
  const [retailerFilter, setRetailerFilter] = useState<string>("ALL_RETAILERS");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const retailers = trpc.retailers.list.useQuery();

  const ordersQuery = trpc.orders.list.useQuery({
    status: statusFilter !== ALL_STATUSES ? (statusFilter as any) : undefined,
    retailerId: retailerFilter !== "ALL_RETAILERS" ? retailerFilter : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    limit: pageSize,
    offset: page * pageSize,
  });

  const totalPages = Math.ceil((ordersQuery.data?.total ?? 0) / pageSize);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShoppingCart className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Ordini</h1>
              <p className="text-sm text-muted-foreground">
                Gestione ordini B2B retailer
              </p>
            </div>
          </div>
          <Button onClick={() => setLocation("/orders/new")} className="gap-2">
            <Plus className="h-4 w-4" />
            Nuovo Ordine
          </Button>
        </div>

        {/* Filtri */}
        <Card>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>Stato</Label>
                <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Tutti gli stati" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_STATUSES}>Tutti gli stati</SelectItem>
                    {Object.entries(STATUS_LABELS).map(([key, { label }]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Rivenditore</Label>
                <Select value={retailerFilter} onValueChange={(v) => { setRetailerFilter(v); setPage(0); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Tutti i rivenditori" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL_RETAILERS">Tutti i rivenditori</SelectItem>
                    {retailers.data?.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Data da</Label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
                />
              </div>

              <div className="space-y-2">
                <Label>Data a</Label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabella ordini */}
        <Card>
          <CardContent className="p-0">
            {ordersQuery.isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : ordersQuery.data?.orders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <ShoppingCart className="h-10 w-10 mb-3 opacity-40" />
                <p className="text-sm">Nessun ordine trovato</p>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTableHead sortKey="orderNumber" sort={sort} onSort={setSort}>N. Ordine</SortableTableHead>
                      <SortableTableHead sortKey="retailerName" sort={sort} onSort={setSort}>Rivenditore</SortableTableHead>
                      <SortableTableHead sortKey="status" sort={sort} onSort={setSort}>Stato</SortableTableHead>
                      <SortableTableHead sortKey="totalGross" sort={sort} onSort={setSort} className="text-right">Totale lordo</SortableTableHead>
                      <SortableTableHead sortKey="ficProformaNumber" sort={sort} onSort={setSort}>Proforma FiC</SortableTableHead>
                      <SortableTableHead sortKey="createdAt" sort={sort} onSort={setSort}>Data</SortableTableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(sort
                      ? sortData(ordersQuery.data?.orders ?? [], sort, (item, key) => {
                          switch (key) {
                            case "orderNumber": return item.orderNumber;
                            case "retailerName": return item.retailerName;
                            case "status": return item.status;
                            case "totalGross": return parseFloat(item.totalGross);
                            case "ficProformaNumber": return item.ficProformaNumber ?? "";
                            case "createdAt": return item.createdAt ? new Date(item.createdAt) : null;
                            default: return null;
                          }
                        })
                      : ordersQuery.data?.orders ?? []
                    ).map((order) => {
                      const st = STATUS_LABELS[order.status] ?? { label: order.status, variant: "outline" as const };
                      return (
                        <TableRow
                          key={order.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => setLocation(`/orders/${order.id}`)}
                        >
                          <TableCell className="font-mono text-sm font-medium">
                            {order.orderNumber}
                          </TableCell>
                          <TableCell>{order.retailerName}</TableCell>
                          <TableCell>
                            <Badge variant={st.variant}>{st.label}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            € {parseFloat(order.totalGross).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {order.ficProformaNumber ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {order.createdAt
                              ? format(new Date(order.createdAt), "dd MMM yyyy HH:mm", { locale: it })
                              : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>

                {/* Paginazione */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t">
                    <p className="text-sm text-muted-foreground">
                      Pagina {page + 1} di {totalPages} ({ordersQuery.data?.total} ordini)
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page === 0}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= totalPages - 1}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
