import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import {
  ReportLayout,
  StatCardWithDelta,
  getDefaultDateRange,
  downloadCsv,
  formatEur,
  formatNum,
  formatPct,
  formatDateIT,
  formatDateShort,
} from "@/components/reports";
import type { DateRange } from "@/components/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DollarSign, ShoppingCart, Users, TrendingUp } from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

const COLORS = ["#2D5A27", "#7AB648", "#F5A623", "#E74C3C", "#3498DB", "#9B59B6", "#1ABC9C", "#F39C12"];

const STATUS_LABELS: Record<string, string> = {
  pending: "In attesa",
  transferring: "In trasferimento",
  shipped: "Spedito",
  delivered: "Consegnato",
  cancelled: "Annullato",
};

export default function SalesReport() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [ordersPage, setOrdersPage] = useState(0);
  const [productTab, setProductTab] = useState<"revenue" | "units">("revenue");

  const overview = trpc.reports.sales.getOverview.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
  });

  const ordersTable = trpc.reports.sales.getOrdersTable.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    limit: 50,
    offset: ordersPage * 50,
  });

  const retailerBreakdown = trpc.reports.sales.getRetailerBreakdown.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    limit: 20,
  });

  const csvExport = trpc.reports.export.toCsv.useMutation({
    onSuccess: (data) => {
      downloadCsv(data.csvContent, data.filename);
    },
  });

  const handleExportCsv = (dataset: string) => {
    csvExport.mutate({
      reportType: "sales",
      dataset,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
    });
  };

  const data = overview.data;
  const isLoading = overview.isLoading;
  const overviewError = overview.error;

  const topRetailerName = data?.topRetailers?.[0]?.name ?? "-";
  const topRetailerRevenue = data?.topRetailers?.[0]?.revenue ?? 0;

  return (
    <DashboardLayout>
    <ReportLayout
      title="Report Vendite & Ordini"
      dateRange={dateRange}
      onDateRangeChange={setDateRange}
      onExportCsv={handleExportCsv}
      csvDatasets={[
        { key: "orders", label: "Ordini" },
        { key: "topRetailers", label: "Retailer" },
      ]}
      exportLoading={csvExport.isPending}
    >
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Caricamento...</div>
      ) : overviewError ? (
        <div className="text-center py-12 text-red-500">Errore: {overviewError.message}</div>
      ) : !data ? (
        <div className="text-center py-12 text-muted-foreground">Nessun dato disponibile</div>
      ) : (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCardWithDelta
              title="Fatturato lordo"
              value={formatEur(data.revenue.grossTotal)}
              currentValue={data.revenue.grossTotal}
              previousValue={data.revenue.previousPeriod.grossTotal}
              icon={<DollarSign className="h-4 w-4" />}
              accent="green"
            />
            <StatCardWithDelta
              title="Fatturato netto"
              value={formatEur(data.revenue.netTotal)}
              currentValue={data.revenue.netTotal}
              previousValue={data.revenue.previousPeriod.netTotal}
              accent="green"
            />
            <StatCardWithDelta
              title="IVA totale"
              value={formatEur(data.revenue.vatTotal)}
              accent="default"
            />
            <StatCardWithDelta
              title="Numero ordini"
              value={formatNum(data.orders.total)}
              currentValue={data.orders.total}
              previousValue={data.orders.previousPeriod.total}
              icon={<ShoppingCart className="h-4 w-4" />}
              accent="default"
            />
            <StatCardWithDelta
              title="AOV"
              value={formatEur(data.orders.avgOrderValue)}
              currentValue={data.orders.avgOrderValue}
              previousValue={data.orders.previousPeriod.avgOrderValue}
              icon={<TrendingUp className="h-4 w-4" />}
              accent="default"
            />
            <StatCardWithDelta
              title="Top retailer"
              value={topRetailerName}
              subtitle={formatEur(topRetailerRevenue)}
              icon={<Users className="h-4 w-4" />}
              accent="default"
            />
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Revenue Time Series */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Fatturato giornaliero</CardTitle>
              </CardHeader>
              <CardContent>
                {data.revenueTimeSeries.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Nessun ordine nel periodo
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={data.revenueTimeSeries}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tickFormatter={formatDateShort} fontSize={11} />
                      <YAxis fontSize={11} tickFormatter={(v) => `€${Math.round(v)}`} />
                      <Tooltip
                        labelFormatter={formatDateIT}
                        formatter={(v: number) => formatEur(v)}
                      />
                      <Legend />
                      <Line type="monotone" dataKey="gross" stroke="#2D5A27" name="Lordo" strokeWidth={2} />
                      <Line type="monotone" dataKey="net" stroke="#7AB648" name="Netto" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Top Retailers Bar */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top 10 retailer per fatturato</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topRetailers.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">Nessun dato</div>
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={data.topRetailers} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tickFormatter={(v) => `€${Math.round(v)}`} fontSize={10} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={120}
                        fontSize={10}
                        tickFormatter={(v: string) => v.length > 18 ? v.slice(0, 18) + "…" : v}
                      />
                      <Tooltip formatter={(v: number) => formatEur(v)} />
                      <Bar dataKey="revenue" fill="#7AB648" name="Fatturato" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Status Distribution Pie */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Distribuzione status ordini</CardTitle>
            </CardHeader>
            <CardContent>
              {data.statusDistribution.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Nessun dato</div>
              ) : (
                <div className="flex flex-col md:flex-row items-center gap-6">
                  <ResponsiveContainer width="100%" height={200} className="max-w-[300px]">
                    <PieChart>
                      <Pie
                        data={data.statusDistribution}
                        dataKey="count"
                        nameKey="status"
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        label={(entry) => `${STATUS_LABELS[entry.status] ?? entry.status}: ${entry.count}`}
                        labelLine={false}
                        fontSize={10}
                      >
                        {data.statusDistribution.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-2">
                    {data.statusDistribution.map((item, i) => (
                      <div key={item.status} className="flex items-center gap-2 text-sm">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                        <span>{STATUS_LABELS[item.status] ?? item.status}</span>
                        <span className="text-muted-foreground">({item.count} ordini, {formatEur(item.value)})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top Products */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Top prodotti venduti</CardTitle>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={productTab === "revenue" ? "default" : "outline"}
                    onClick={() => setProductTab("revenue")}
                  >
                    Per fatturato
                  </Button>
                  <Button
                    size="sm"
                    variant={productTab === "units" ? "default" : "outline"}
                    onClick={() => setProductTab("units")}
                  >
                    Per quantità
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {(() => {
                const products = productTab === "revenue" ? data.topProductsByRevenue : data.topProductsByUnits;
                if (products.length === 0) {
                  return <div className="text-center py-4 text-muted-foreground text-sm">Nessun dato</div>;
                }
                return (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Prodotto</TableHead>
                        <TableHead className="text-right">Quantità</TableHead>
                        <TableHead className="text-right">Fatturato</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {products.map((p, i) => (
                        <TableRow key={p.productId}>
                          <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                          <TableCell className="font-medium">{p.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.units}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatEur(p.revenue)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                );
              })()}
            </CardContent>
          </Card>

          {/* Retailer Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Estratto per retailer</CardTitle>
            </CardHeader>
            <CardContent>
              {retailerBreakdown.isLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Caricamento...</div>
              ) : !retailerBreakdown.data || retailerBreakdown.data.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Nessun dato</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Retailer</TableHead>
                        <TableHead className="text-right">Fatturato</TableHead>
                        <TableHead className="text-right">Ordini</TableHead>
                        <TableHead className="text-right">AOV</TableHead>
                        <TableHead>Ultimo ordine</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {retailerBreakdown.data.map((r) => (
                        <TableRow key={r.retailerId}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatEur(r.totalRevenue)}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.orderCount}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatEur(r.avgOrderValue)}</TableCell>
                          <TableCell className="text-xs">{r.lastOrderDate ? formatDateIT(r.lastOrderDate) : "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Orders Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Elenco ordini</CardTitle>
            </CardHeader>
            <CardContent>
              {ordersTable.isLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Caricamento...</div>
              ) : !ordersTable.data || ordersTable.data.items.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  Nessun ordine nel periodo selezionato
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Numero</TableHead>
                          <TableHead>Data</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Retailer</TableHead>
                          <TableHead className="text-right">Netto</TableHead>
                          <TableHead className="text-right">Lordo</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ordersTable.data.items.map((o: any) => (
                          <TableRow key={o.id}>
                            <TableCell className="font-mono text-xs">{o.orderNumber}</TableCell>
                            <TableCell className="text-xs tabular-nums">{formatDateIT(o.createdAt)}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {STATUS_LABELS[o.status] ?? o.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm">{o.retailerName ?? o.eventName ?? "-"}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatEur(o.subtotalNet)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatEur(o.totalGross)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-muted-foreground">
                      {ordersTable.data.total} ordini totali
                    </span>
                    <div className="flex gap-2">
                      <button
                        className="text-xs px-2 py-1 border rounded disabled:opacity-50"
                        disabled={ordersPage === 0}
                        onClick={() => setOrdersPage(ordersPage - 1)}
                      >
                        ← Prec
                      </button>
                      <button
                        className="text-xs px-2 py-1 border rounded disabled:opacity-50"
                        disabled={(ordersPage + 1) * 50 >= ordersTable.data.total}
                        onClick={() => setOrdersPage(ordersPage + 1)}
                      >
                        Succ →
                      </button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </ReportLayout>
    </DashboardLayout>
  );
}
