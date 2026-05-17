import { useState, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { toast } from "sonner";
import {
  ArrowLeft,
  ShoppingCart,
  RefreshCw,
  Search,
  Eye,
  RotateCcw,
} from "lucide-react";

const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "In Attesa", variant: "secondary" },
  processed: { label: "Processato", variant: "default" },
  partial: { label: "Parziale", variant: "outline" },
  failed: { label: "Fallito", variant: "destructive" },
};

export default function MarketplaceShopifyOrders() {
  const searchString = useSearch();
  const params = useMemo(() => new URLSearchParams(searchString), [searchString]);
  const initialStatus = params.get("status") as any;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(initialStatus || "__all__");
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const { data, isLoading, refetch } = trpc.shopify.orders.list.useQuery({
    search: search || undefined,
    status: status === "__all__" ? undefined : (status as any),
    limit: pageSize,
    offset: page * pageSize,
  });

  const retryAllMutation = trpc.shopify.orders.retryAllFailed.useMutation({
    onSuccess: (data) => {
      toast.success(`Retry completato: ${data.succeeded}/${data.retried} riusciti`);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const totalPages = Math.ceil((data?.totalCount ?? 0) / pageSize);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/marketplace/shopify">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <ShoppingCart className="h-6 w-6" />
                Ordini Shopify
              </h1>
              <p className="text-muted-foreground">
                {data?.totalCount ?? 0} ordini importati
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => retryAllMutation.mutate()}
            disabled={retryAllMutation.isPending}
          >
            <RotateCcw className={`h-4 w-4 mr-1 ${retryAllMutation.isPending ? "animate-spin" : ""}`} />
            Retry Tutti Falliti
          </Button>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-4 items-end">
              <div className="flex-1 min-w-[200px]">
                <Label className="text-xs">Cerca ordine / cliente</Label>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="N. ordine, email, nome..."
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                    className="pl-8"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Stato Stock</Label>
                <Select
                  value={status}
                  onValueChange={(v) => { setStatus(v); setPage(0); }}
                >
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Tutti</SelectItem>
                    <SelectItem value="pending">In Attesa</SelectItem>
                    <SelectItem value="processed">Processato</SelectItem>
                    <SelectItem value="partial">Parziale</SelectItem>
                    <SelectItem value="failed">Fallito</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>N. Ordine</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Totale</TableHead>
                  <TableHead className="text-center">Stato Stock</TableHead>
                  <TableHead className="text-center">Tentativi</TableHead>
                  <TableHead className="text-right">Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Caricamento...
                    </TableCell>
                  </TableRow>
                ) : data?.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Nessun ordine trovato
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.items.map((o) => {
                    const statusInfo = statusLabels[o.stockProcessingStatus || "pending"];
                    return (
                      <TableRow key={o.id}>
                        <TableCell className="font-mono font-medium">
                          #{o.channelOrderNumber}
                        </TableCell>
                        <TableCell>
                          <div>
                            <p className="text-sm">{o.customerName || "—"}</p>
                            <p className="text-xs text-muted-foreground">{o.customerEmail || ""}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {o.orderDate
                            ? new Date(o.orderDate).toLocaleDateString("it-IT")
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          €{parseFloat(o.totalGross || "0").toFixed(2)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant={statusInfo?.variant || "secondary"}>
                            {statusInfo?.label || o.stockProcessingStatus}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          {o.stockProcessingAttempts || 0}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link href={`/marketplace/shopify/orders/${o.id}`}>
                            <Button variant="ghost" size="sm">
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Pagina {page + 1} di {totalPages} ({data?.totalCount} risultati)
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Precedente
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
              >
                Successiva
              </Button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
