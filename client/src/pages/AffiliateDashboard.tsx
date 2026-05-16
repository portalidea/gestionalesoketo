/**
 * M7-B — AffiliateDashboard
 * Dashboard portale affiliati: stats, grafico mensile, breakdown retailer.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import AffiliateLayout from "@/components/AffiliateLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowRight,
  Euro,
  Clock,
  XCircle,
  Store,
} from "lucide-react";

export default function AffiliateDashboard() {
  const { data: stats, isLoading: loadingStats } = trpc.affiliatePortal.dashboardStats.useQuery();
  const { data: chartData, isLoading: loadingChart } = trpc.affiliatePortal.dashboardMonthlyChart.useQuery();
  const { data: retailers, isLoading: loadingRetailers } = trpc.affiliatePortal.dashboardRetailersBreakdown.useQuery();

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(amount);

  const formatDate = (date: Date | string | null) => {
    if (!date) return "-";
    return new Date(date).toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  // Simple bar chart using CSS
  const maxChartValue = useMemo(() => {
    if (!chartData) return 1;
    return Math.max(...chartData.map((d) => d.paidAmount + d.pendingAmount), 1);
  }, [chartData]);

  return (
    <AffiliateLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">Panoramica del tuo programma affiliati</p>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Guadagnato</CardTitle>
              <Euro className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {loadingStats ? "..." : formatCurrency(stats?.totalEarned ?? 0)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats?.commissionsCount?.paid ?? 0} commissioni pagate
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">In Attesa</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600">
                {loadingStats ? "..." : formatCurrency(stats?.totalPending ?? 0)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats?.commissionsCount?.pending ?? 0} commissioni pending
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Annullato</CardTitle>
              <XCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">
                {loadingStats ? "..." : formatCurrency(stats?.totalVoided ?? 0)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats?.commissionsCount?.voided ?? 0} annullate
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Retailer</CardTitle>
              <Store className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {loadingStats ? "..." : stats?.retailersCount ?? 0}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats?.lastPaymentDate
                  ? `Ultimo pagamento: ${formatDate(stats.lastPaymentDate)}`
                  : "Nessun pagamento ancora"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Monthly Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Commissioni ultimi 12 mesi</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingChart ? (
              <div className="h-48 flex items-center justify-center text-muted-foreground">
                Caricamento...
              </div>
            ) : !chartData || chartData.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-muted-foreground">
                Nessun dato disponibile
              </div>
            ) : (
              <div className="flex items-end gap-1 h-48">
                {chartData.map((d) => {
                  const total = d.paidAmount + d.pendingAmount;
                  const heightPercent = (total / maxChartValue) * 100;
                  const paidPercent = total > 0 ? (d.paidAmount / total) * 100 : 0;
                  return (
                    <div
                      key={d.month}
                      className="flex-1 flex flex-col items-center gap-1"
                    >
                      <div
                        className="w-full rounded-t-sm relative overflow-hidden min-h-[2px]"
                        style={{ height: `${Math.max(heightPercent, 2)}%` }}
                      >
                        <div
                          className="absolute bottom-0 left-0 right-0 bg-green-500"
                          style={{ height: `${paidPercent}%` }}
                        />
                        <div
                          className="absolute top-0 left-0 right-0 bg-amber-400"
                          style={{ height: `${100 - paidPercent}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground rotate-[-45deg] origin-top-left whitespace-nowrap">
                        {d.month.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-4 mt-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-sm bg-green-500" />
                <span>Pagate</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-sm bg-amber-400" />
                <span>In attesa</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Retailers Breakdown */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">I miei Retailer</CardTitle>
            <Link href="/affiliate-portal/commissions">
              <Button variant="ghost" size="sm">
                Vedi commissioni <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {loadingRetailers ? (
              <p className="text-muted-foreground text-center py-4">Caricamento...</p>
            ) : !retailers || retailers.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">
                Nessun retailer associato ancora.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Retailer</TableHead>
                    <TableHead className="text-right">Ordini</TableHead>
                    <TableHead className="text-right">Commissioni</TableHead>
                    <TableHead className="text-right">Ultimo ordine</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {retailers.map((r) => (
                    <TableRow key={r.retailerId}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{r.retailerName}</p>
                          <p className="text-xs text-muted-foreground">
                            Assegnato: {formatDate(r.affiliateAssignedAt)}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{r.totalOrders}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(r.totalCommissionAmount)}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {formatDate(r.lastOrderDate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AffiliateLayout>
  );
}
