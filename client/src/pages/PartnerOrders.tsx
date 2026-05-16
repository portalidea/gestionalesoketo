/**
 * M6.2.B Parte B — PartnerOrders
 * Lista ordini del retailer con filtri per stato e paginazione.
 * Usa retailerSelfService.ordersList.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  ShoppingCart,
} from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "In attesa", color: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30" },
  paid: { label: "Pagato", color: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30" },
  approved_for_shipping: { label: "Approvato", color: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/30" },
  transferring: { label: "In preparazione", color: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/30" },
  shipped: { label: "Spedito", color: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/30" },
  delivered: { label: "Consegnato", color: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30" },
  paid_on_delivery: { label: "Pagato (consegna)", color: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  cancelled: { label: "Cancellato", color: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30" },
};

export default function PartnerOrders() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const pageSize = 10;

  type OrderStatus = "pending" | "paid" | "approved_for_shipping" | "transferring" | "shipped" | "delivered" | "paid_on_delivery" | "cancelled";

  const ordersQuery = trpc.retailerSelfService.ordersList.useQuery({
    limit: pageSize,
    offset: (page - 1) * pageSize,
    status: status ? [status as OrderStatus] : undefined,
  });

  const ordersList = ordersQuery.data?.orders ?? [];
  const totalCount = ordersQuery.data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  return (
    <PartnerLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">I miei ordini</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {totalCount} {totalCount === 1 ? "ordine" : "ordini"} totali
            </p>
          </div>
          <Button
            className="bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
            onClick={() => setLocation("/partner-portal/catalog")}
          >
            <ShoppingCart className="h-4 w-4 mr-2" />
            Nuovo ordine
          </Button>
        </div>

        {/* Filtro stato */}
        <div className="flex gap-3">
          <Select
            value={status || "all"}
            onValueChange={(v) => {
              setStatus(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Tutti gli stati" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti gli stati</SelectItem>
              <SelectItem value="pending">In attesa</SelectItem>
              <SelectItem value="paid">Pagato</SelectItem>
              <SelectItem value="approved_for_shipping">Approvato</SelectItem>
              <SelectItem value="transferring">In preparazione</SelectItem>
              <SelectItem value="shipped">Spedito</SelectItem>
              <SelectItem value="delivered">Consegnato</SelectItem>
              <SelectItem value="paid_on_delivery">Pagato (consegna)</SelectItem>
              <SelectItem value="cancelled">Cancellato</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Loading */}
        {ordersQuery.isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
          </div>
        )}

        {/* Empty */}
        {!ordersQuery.isLoading && ordersList.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-2">Nessun ordine</h3>
            <p className="text-muted-foreground text-sm mb-4">
              {status
                ? "Nessun ordine con questo stato."
                : "Non hai ancora effettuato ordini."}
            </p>
            <Button
              onClick={() => setLocation("/partner-portal/catalog")}
              className="bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
            >
              Vai al catalogo
            </Button>
          </div>
        )}

        {/* Lista ordini */}
        {!ordersQuery.isLoading && ordersList.length > 0 && (
          <div className="space-y-3">
            {ordersList.map((order) => {
              const statusInfo = STATUS_LABELS[order.status] ?? { label: order.status, color: "" };
              return (
                <Card
                  key={order.id}
                  className="cursor-pointer hover:shadow-md transition-all"
                  onClick={() => setLocation(`/partner-portal/orders/${order.id}`)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3 mb-1">
                          <p className="font-semibold text-sm">
                            #{order.orderNumber}
                          </p>
                          <Badge variant="outline" className={`text-xs ${statusInfo.color}`}>
                            {statusInfo.label}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>
                            {new Date(order.createdAt).toLocaleDateString("it-IT", {
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                          <span>{order.itemCount} {order.itemCount === 1 ? "prodotto" : "prodotti"}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-lg font-bold text-[#2D5A27] dark:text-[#7AB648]">
                          &euro;{parseFloat(order.totalAmount).toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Paginazione */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Pagina {page} di {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </PartnerLayout>
  );
}
