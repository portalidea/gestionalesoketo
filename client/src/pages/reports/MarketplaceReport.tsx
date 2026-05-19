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
import { ShoppingBag, Package, TrendingUp, BarChart3 } from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

export default function MarketplaceReport() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [ordersPage, setOrdersPage] = useState(0);

  const overview = trpc.reports.marketplace.getOverview.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
  });

  const ordersTable = trpc.reports.marketplace.getOrdersTable.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    limit: 50,
    offset: ordersPage * 50,
  });

  const csvExport = trpc.reports.export.toCsv.useMutation({
    onSuccess: (data) => {
      downloadCsv(data.csvContent, data.filename);
    },
  });

  const handleExportCsv = (dataset: string) => {
    csvExport.mutate({
      reportType: "marketplace",
      dataset,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
    });
  };

  const data = overview.data;
  const isLoading = overview.isLoading;
  const overviewError = overview.error;

  return (
    <DashboardLayout>
    <ReportLayout
      title="Report Marketplace"
      dateRange={dateRange}
      onDateRangeChange={setDateRange}
      onExportCsv={handleExportCsv}
      csvDatasets={[{ key: "orders", label: "Ordini Marketplace" }]}
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <StatCardWithDelta
              title="Vendite totali"
              value={formatEur(data.summary.totalGross)}
              currentValue={data.summary.totalGross}
              previousValue={data.summary.previousPeriod.totalGross}
              icon={<ShoppingBag className="h-4 w-4" />}
              accent="green"
            />
            <StatCardWithDelta
              title="Ordini"
              value={formatNum(data.summary.ordersCount)}
              currentValue={data.summary.ordersCount}
              previousValue={data.summary.previousPeriod.ordersCount}
              icon={<BarChart3 className="h-4 w-4" />}
              accent="default"
            />
            <StatCardWithDelta
              title="AOV"
              value={formatEur(data.summary.avgOrderValue)}
              currentValue={data.summary.avgOrderValue}
              previousValue={data.summary.previousPeriod.avgOrderValue}
              icon={<TrendingUp className="h-4 w-4" />}
              accent="default"
            />
            <StatCardWithDelta
              title="Pezzi venduti"
              value={formatNum(data.summary.unitsSold)}
              currentValue={data.summary.unitsSold}
              previousValue={data.summary.previousPeriod.unitsSold}
              icon={<Package className="h-4 w-4" />}
              accent="default"
            />
            <StatCardWithDelta
              title="Canali attivi"
              value={formatNum(data.byChannel.length)}
              subtitle={data.byChannel.map(c => c.channel).join(", ") || "Nessuno"}
              accent="default"
            />
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Revenue Time Series */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Vendite giornaliere</CardTitle>
              </CardHeader>
              <CardContent>
                {data.revenueTimeSeries.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Nessun ordine marketplace nel periodo
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
                      <Line type="monotone" dataKey="gross" stroke="#7AB648" name="Vendite" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Top SKU Bar */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top SKU per vendite</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topVariantsByUnits.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">Nessun dato</div>
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={data.topVariantsByUnits} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" fontSize={10} />
                      <YAxis
                        type="category"
                        dataKey="displayName"
                        width={130}
                        fontSize={10}
                        tickFormatter={(v: string) => v.length > 20 ? v.slice(0, 20) + "…" : v}
                      />
                      <Tooltip />
                      <Bar dataKey="units" fill="#F5A623" name="Pezzi venduti" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Retailer vs Marketplace Area Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Confronto Retailer vs Marketplace</CardTitle>
            </CardHeader>
            <CardContent>
              {data.retailerVsMarketplace.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Nessun dato per il confronto
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={250}>
                  <AreaChart data={data.retailerVsMarketplace}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tickFormatter={formatDateShort} fontSize={11} />
                    <YAxis fontSize={11} tickFormatter={(v) => `€${Math.round(v)}`} />
                    <Tooltip
                      labelFormatter={formatDateIT}
                      formatter={(v: number) => formatEur(v)}
                    />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="retailerRevenue"
                      stroke="#2D5A27"
                      fill="#2D5A27"
                      fillOpacity={0.3}
                      name="Retailer"
                      stackId="1"
                    />
                    <Area
                      type="monotone"
                      dataKey="marketplaceRevenue"
                      stroke="#F5A623"
                      fill="#F5A623"
                      fillOpacity={0.3}
                      name="Marketplace"
                      stackId="1"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Top Variants Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top varianti per fatturato</CardTitle>
            </CardHeader>
            <CardContent>
              {data.topVariantsByRevenue.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Nessun dato</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead className="text-right">Pezzi</TableHead>
                      <TableHead className="text-right">Fatturato</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topVariantsByRevenue.map((v: any, i: number) => (
                      <TableRow key={v.sku + i}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                        <TableCell>{v.displayName}</TableCell>
                        <TableCell className="text-right tabular-nums">{v.units}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatEur(v.revenue)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Orders Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Elenco ordini marketplace</CardTitle>
            </CardHeader>
            <CardContent>
              {ordersTable.isLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Caricamento...</div>
              ) : !ordersTable.data || ordersTable.data.items.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  Nessun ordine marketplace nel periodo
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Numero</TableHead>
                          <TableHead>Data</TableHead>
                          <TableHead>Cliente</TableHead>
                          <TableHead>Canale</TableHead>
                          <TableHead className="text-right">Totale</TableHead>
                          <TableHead>Paese</TableHead>
                          <TableHead>Stock</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ordersTable.data.items.map((o: any) => (
                          <TableRow key={o.id}>
                            <TableCell className="font-mono text-xs">{o.channelOrderNumber}</TableCell>
                            <TableCell className="text-xs tabular-nums">{formatDateIT(o.orderDate)}</TableCell>
                            <TableCell className="text-sm">{o.customerName ?? "-"}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs capitalize">{o.channel}</Badge>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{formatEur(o.totalGross)}</TableCell>
                            <TableCell className="text-xs">{o.shippingCountry ?? "-"}</TableCell>
                            <TableCell>
                              <Badge
                                variant={o.stockProcessingStatus === "processed" ? "default" : "secondary"}
                                className="text-xs"
                              >
                                {o.stockProcessingStatus}
                              </Badge>
                            </TableCell>
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
