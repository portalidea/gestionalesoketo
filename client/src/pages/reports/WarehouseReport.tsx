import { useState } from "react";
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
import { Warehouse, Package, AlertTriangle, TrendingUp, ArrowUpDown } from "lucide-react";
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

const COLORS = ["#2D5A27", "#7AB648", "#F5A623", "#E74C3C", "#3498DB", "#9B59B6"];

export default function WarehouseReport() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [movPage, setMovPage] = useState(0);

  const overview = trpc.reports.warehouse.getOverview.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
  });

  const movements = trpc.reports.warehouse.getMovementsTable.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    limit: 50,
    offset: movPage * 50,
  });

  const expiring = trpc.reports.warehouse.getExpiringBatches.useQuery({
    daysThreshold: 90,
    limit: 50,
  });

  const csvExport = trpc.reports.export.toCsv.useMutation({
    onSuccess: (data) => {
      downloadCsv(data.csvContent, data.filename);
    },
  });

  const handleExportCsv = (dataset: string) => {
    csvExport.mutate({
      reportType: "warehouse",
      dataset,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
    });
  };

  const data = overview.data;
  const isLoading = overview.isLoading;

  return (
    <ReportLayout
      title="Report Magazzino"
      dateRange={dateRange}
      onDateRangeChange={setDateRange}
      onExportCsv={handleExportCsv}
      csvDatasets={[{ key: "movements", label: "Movimenti" }]}
      exportLoading={csvExport.isPending}
    >
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Caricamento...</div>
      ) : !data ? (
        <div className="text-center py-12 text-muted-foreground">Nessun dato disponibile</div>
      ) : (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCardWithDelta
              title="Valore al costo"
              value={formatEur(data.snapshot.totalValueAtCost)}
              icon={<Warehouse className="h-4 w-4" />}
              accent="green"
            />
            <StatCardWithDelta
              title="Valore al listino"
              value={formatEur(data.snapshot.totalValueAtListPrice)}
              icon={<TrendingUp className="h-4 w-4" />}
              accent="green"
            />
            <StatCardWithDelta
              title="Margine potenziale"
              value={formatPct(data.snapshot.marginPercent)}
              accent="default"
            />
            <StatCardWithDelta
              title="Pezzi totali"
              value={formatNum(data.snapshot.totalUnits)}
              icon={<Package className="h-4 w-4" />}
              accent="default"
            />
            <StatCardWithDelta
              title="Movimentati (periodo)"
              value={formatNum(data.period.unitsIn + data.period.unitsOut)}
              currentValue={data.period.unitsIn + data.period.unitsOut}
              previousValue={data.period.previousPeriod.unitsIn + data.period.previousPeriod.unitsOut}
              icon={<ArrowUpDown className="h-4 w-4" />}
              accent="default"
            />
            <StatCardWithDelta
              title="In scadenza < 30gg"
              value={formatEur(data.expiring.under30days.value)}
              subtitle={`${data.expiring.under30days.count} lotti`}
              icon={<AlertTriangle className="h-4 w-4" />}
              accent={data.expiring.under30days.count > 0 ? "red" : "default"}
            />
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Line Chart: Movements */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Movimenti nel periodo</CardTitle>
              </CardHeader>
              <CardContent>
                {data.movementsTimeSeries.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Nessun movimento nel periodo
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={data.movementsTimeSeries}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tickFormatter={formatDateShort} fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip labelFormatter={formatDateIT} />
                      <Legend />
                      <Line type="monotone" dataKey="in" stroke="#7AB648" name="Entrate" strokeWidth={2} />
                      <Line type="monotone" dataKey="out" stroke="#E74C3C" name="Uscite" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Bar Chart: Top Products */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top 10 prodotti per valore</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topProductsByValue.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Nessun dato
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={data.topProductsByValue} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tickFormatter={(v) => formatEur(v)} fontSize={10} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={120}
                        fontSize={10}
                        tickFormatter={(v: string) => v.length > 18 ? v.slice(0, 18) + "…" : v}
                      />
                      <Tooltip formatter={(v: number) => formatEur(v)} />
                      <Bar dataKey="value" fill="#2D5A27" name="Valore" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Pie: Expiration Distribution */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Distribuzione scadenze</CardTitle>
            </CardHeader>
            <CardContent>
              {data.expirationDistribution.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Nessun lotto con scadenza impostata
                </div>
              ) : (
                <div className="flex flex-col md:flex-row items-center gap-6">
                  <ResponsiveContainer width="100%" height={200} className="max-w-[300px]">
                    <PieChart>
                      <Pie
                        data={data.expirationDistribution}
                        dataKey="count"
                        nameKey="bucket"
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        label={(entry) => `${entry.bucket}: ${entry.count}`}
                        labelLine={false}
                        fontSize={11}
                      >
                        {data.expirationDistribution.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-2">
                    {data.expirationDistribution.map((item, i) => (
                      <div key={item.bucket} className="flex items-center gap-2 text-sm">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                        <span>{item.bucket}</span>
                        <span className="text-muted-foreground">({item.count} lotti, {formatEur(item.value)})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Movements Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Movimenti magazzino</CardTitle>
            </CardHeader>
            <CardContent>
              {movements.isLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Caricamento...</div>
              ) : !movements.data || movements.data.items.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  Nessun movimento nel periodo selezionato
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Data</TableHead>
                          <TableHead>Tipo</TableHead>
                          <TableHead>Prodotto</TableHead>
                          <TableHead>Lotto</TableHead>
                          <TableHead className="text-right">Qtà</TableHead>
                          <TableHead>Da</TableHead>
                          <TableHead>A</TableHead>
                          <TableHead>Note</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {movements.data.items.map((m) => (
                          <TableRow key={m.id}>
                            <TableCell className="text-xs tabular-nums whitespace-nowrap">
                              {formatDateIT(m.timestamp)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">{m.type}</Badge>
                            </TableCell>
                            <TableCell className="text-sm max-w-[200px] truncate">{m.productName}</TableCell>
                            <TableCell className="text-xs">{m.batchNumber ?? "-"}</TableCell>
                            <TableCell className="text-right tabular-nums font-medium">{m.quantity}</TableCell>
                            <TableCell className="text-xs">{m.fromLocation ?? "-"}</TableCell>
                            <TableCell className="text-xs">{m.toLocation ?? "-"}</TableCell>
                            <TableCell className="text-xs max-w-[150px] truncate">{m.notes ?? ""}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {/* Pagination */}
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-muted-foreground">
                      {movements.data.total} movimenti totali
                    </span>
                    <div className="flex gap-2">
                      <button
                        className="text-xs px-2 py-1 border rounded disabled:opacity-50"
                        disabled={movPage === 0}
                        onClick={() => setMovPage(movPage - 1)}
                      >
                        ← Prec
                      </button>
                      <button
                        className="text-xs px-2 py-1 border rounded disabled:opacity-50"
                        disabled={(movPage + 1) * 50 >= movements.data.total}
                        onClick={() => setMovPage(movPage + 1)}
                      >
                        Succ →
                      </button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Expiring Batches Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lotti in scadenza (prossimi 90 giorni)</CardTitle>
            </CardHeader>
            <CardContent>
              {expiring.isLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Caricamento...</div>
              ) : !expiring.data || expiring.data.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  Nessun lotto in scadenza nei prossimi 90 giorni
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Prodotto</TableHead>
                        <TableHead>Lotto</TableHead>
                        <TableHead>Scadenza</TableHead>
                        <TableHead>Giorni</TableHead>
                        <TableHead className="text-right">Qtà</TableHead>
                        <TableHead className="text-right">Valore</TableHead>
                        <TableHead>Ubicazione</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {expiring.data.map((b, i) => (
                        <TableRow key={i} className={b.daysToExpire <= 30 ? "bg-red-50 dark:bg-red-950/20" : ""}>
                          <TableCell className="text-sm">{b.productName}</TableCell>
                          <TableCell className="text-xs font-mono">{b.batchNumber}</TableCell>
                          <TableCell className="text-xs tabular-nums">{formatDateIT(b.expirationDate)}</TableCell>
                          <TableCell>
                            <Badge variant={b.daysToExpire <= 30 ? "destructive" : "secondary"} className="text-xs">
                              {b.daysToExpire}gg
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{b.quantity}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatEur(b.valueAtCost)}</TableCell>
                          <TableCell className="text-xs">{b.locationName}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </ReportLayout>
  );
}
