import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import {
  ReportLayout,
  getDefaultDateRange,
  downloadCsv,
  formatEur,
  formatNum,
} from "@/components/reports";
import type { DateRange } from "@/components/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Gift, Package, Euro, TrendingDown } from "lucide-react";

const ALL_RETAILERS_VALUE = "__all__";

function formatMonth(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString("it-IT", { month: "long", year: "numeric" });
}

export default function PromozioniReport() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [retailerId, setRetailerId] = useState<string>(ALL_RETAILERS_VALUE);

  const retailers = trpc.retailers.list.useQuery();

  const report = trpc.reports.promozioni.getReport.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    retailerId: retailerId !== ALL_RETAILERS_VALUE ? retailerId : undefined,
  });

  const handleExportCsv = () => {
    if (!report.data) return;
    const { items, totals, referenceDiscount } = report.data;

    const header = [
      "Rivenditore",
      "Mese",
      "N° Ordini Omaggio",
      "Confezioni Regalate",
      "Costo Totale (€)",
      `Valore Regalato Premium ${referenceDiscount}% (€)`,
    ].join(";");

    const rows = items.map((row) =>
      [
        row.retailerName,
        formatMonth(row.month),
        row.numOrders,
        row.totalQuantity,
        row.totalCost.toFixed(2).replace(".", ","),
        row.totalGiftValue.toFixed(2).replace(".", ","),
      ].join(";"),
    );

    const totalRow = [
      "TOTALE",
      "",
      totals.numOrders,
      totals.totalQuantity,
      totals.totalCost.toFixed(2).replace(".", ","),
      totals.totalGiftValue.toFixed(2).replace(".", ","),
    ].join(";");

    const csvContent = [header, ...rows, "", totalRow].join("\n");
    const filename = `promozioni_${dateRange.dateFrom}_${dateRange.dateTo}.csv`;
    downloadCsv(csvContent, filename);
  };

  const csvDatasets = [{ key: "promozioni", label: "Report Promozioni" }];

  return (
    <DashboardLayout>
      <ReportLayout
        title="Valore Promozioni (Omaggi)"
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        onExportCsv={handleExportCsv}
        csvDatasets={csvDatasets}
        exportLoading={false}
      >
        {/* Filtro rivenditore */}
        <div className="flex items-center gap-3 mb-6">
          <span className="text-sm text-muted-foreground">Rivenditore:</span>
          <Select value={retailerId} onValueChange={setRetailerId}>
            <SelectTrigger className="w-[250px]">
              <SelectValue placeholder="Tutti i rivenditori" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_RETAILERS_VALUE}>Tutti i rivenditori</SelectItem>
              {retailers.data?.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* KPI Cards */}
        {report.data && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Ordini Omaggio
                </CardTitle>
                <Gift className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatNum(report.data.totals.numOrders)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Confezioni Regalate
                </CardTitle>
                <Package className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatNum(report.data.totals.totalQuantity)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Costo Totale
                </CardTitle>
                <TrendingDown className="h-4 w-4 text-destructive" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-destructive">
                  {formatEur(report.data.totals.totalCost)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Valore Regalato (Premium)
                </CardTitle>
                <Euro className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatEur(report.data.totals.totalGiftValue)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Sconto rif. {report.data.referenceDiscount}%
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Tabella aggregata */}
        {report.isLoading && (
          <div className="text-center py-12 text-muted-foreground">
            Caricamento report...
          </div>
        )}

        {report.data && report.data.items.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            Nessun ordine omaggio trovato nel periodo selezionato.
          </div>
        )}

        {report.data && report.data.items.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Dettaglio per Rivenditore e Mese
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rivenditore</TableHead>
                    <TableHead>Mese</TableHead>
                    <TableHead className="text-right">N° Ordini</TableHead>
                    <TableHead className="text-right">Confezioni</TableHead>
                    <TableHead className="text-right">Costo (€)</TableHead>
                    <TableHead className="text-right">Valore Regalato (€)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data.items.map((row, idx) => (
                    <TableRow key={`${row.retailerId}-${row.month}-${idx}`}>
                      <TableCell className="font-medium">{row.retailerName}</TableCell>
                      <TableCell className="capitalize">{formatMonth(row.month)}</TableCell>
                      <TableCell className="text-right">{formatNum(row.numOrders)}</TableCell>
                      <TableCell className="text-right">{formatNum(row.totalQuantity)}</TableCell>
                      <TableCell className="text-right text-destructive font-mono">
                        {formatEur(row.totalCost)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatEur(row.totalGiftValue)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow className="font-bold bg-muted/50">
                    <TableCell colSpan={2}>TOTALE</TableCell>
                    <TableCell className="text-right">
                      {formatNum(report.data.totals.numOrders)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNum(report.data.totals.totalQuantity)}
                    </TableCell>
                    <TableCell className="text-right text-destructive font-mono">
                      {formatEur(report.data.totals.totalCost)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatEur(report.data.totals.totalGiftValue)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        )}
      </ReportLayout>
    </DashboardLayout>
  );
}
