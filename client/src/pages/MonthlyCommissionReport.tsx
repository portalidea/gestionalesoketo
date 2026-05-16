import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ArrowLeft, Calendar, Euro } from "lucide-react";

const MONTHS = [
  "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
  "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre",
];

export default function MonthlyCommissionReport() {
  const [, navigate] = useLocation();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear().toString());
  const [month, setMonth] = useState((now.getMonth() + 1).toString().padStart(2, "0"));

  // Backend expects month as "YYYY-MM" string
  const monthParam = `${year}-${month.padStart(2, "0")}`;

  const { data, isLoading } = trpc.affiliates.monthlyReport.useQuery({
    month: monthParam,
  });

  const report = data?.affiliates ?? [];
  const totals = data?.totals;

  const grandTotal = totals
    ? totals.grandTotalPending + totals.grandTotalPaid
    : 0;
  const grandOrders = totals?.totalOrders ?? 0;

  const years = [];
  for (let y = 2024; y <= now.getFullYear() + 1; y++) {
    years.push(y.toString());
  }

  return (
    <DashboardLayout>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/affiliates/commissions")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Report Mensile Commissioni</h1>
          <p className="text-muted-foreground">
            Riepilogo commissioni per affiliato nel mese selezionato
          </p>
        </div>
      </div>

      {/* Period Selector */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={i + 1} value={(i + 1).toString().padStart(2, "0")}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={y}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Euro className="h-4 w-4 text-blue-500" />
              <span className="text-sm text-muted-foreground">Totale Commissioni</span>
            </div>
            <p className="text-2xl font-bold mt-1">€{grandTotal.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <span className="text-sm text-muted-foreground">Affiliati Attivi</span>
            <p className="text-2xl font-bold mt-1">{report.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <span className="text-sm text-muted-foreground">Ordini Totali</span>
            <p className="text-2xl font-bold mt-1">{grandOrders}</p>
          </CardContent>
        </Card>
      </div>

      {/* Report Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            Dettaglio — {MONTHS[parseInt(month) - 1]} {year}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Caricamento...</div>
          ) : report.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nessuna commissione nel periodo selezionato
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Affiliato</TableHead>
                  <TableHead className="text-right">N. Commissioni</TableHead>
                  <TableHead className="text-right">Primi Ordini</TableHead>
                  <TableHead className="text-right">Ricorrenti</TableHead>
                  <TableHead className="text-right">Pendenti</TableHead>
                  <TableHead className="text-right">Pagate</TableHead>
                  <TableHead className="text-right">Annullate</TableHead>
                  <TableHead>IBAN</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.map((r: any) => (
                  <TableRow key={r.affiliateId}>
                    <TableCell className="font-medium">{r.affiliateName}</TableCell>
                    <TableCell className="text-right">{r.commissionsCount}</TableCell>
                    <TableCell className="text-right">{r.firstOrderCount ?? 0}</TableCell>
                    <TableCell className="text-right">{r.recurringCount ?? 0}</TableCell>
                    <TableCell className="text-right text-orange-600">
                      €{Number(r.totalPending).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right text-green-600">
                      €{Number(r.totalPaid).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right text-red-500">
                      €{Number(r.totalVoided).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {r.affiliateIban || "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {/* Totale */}
                {totals && (
                  <TableRow className="border-t-2 font-bold">
                    <TableCell>TOTALE</TableCell>
                    <TableCell className="text-right">{totals.totalOrders}</TableCell>
                    <TableCell className="text-right">-</TableCell>
                    <TableCell className="text-right">-</TableCell>
                    <TableCell className="text-right text-orange-600">
                      €{totals.grandTotalPending.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right text-green-600">
                      €{totals.grandTotalPaid.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right text-red-500">
                      €{totals.grandTotalVoided.toFixed(2)}
                    </TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
    </DashboardLayout>
  );
}
