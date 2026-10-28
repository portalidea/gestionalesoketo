import { Fragment, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { ReportLayout, getDefaultDateRange } from "@/components/reports";
import type { DateRange } from "@/components/reports";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { AlertTriangle, ChevronDown, ChevronRight, PackageCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

const ALL_TYPES = "__all__";

type ReplacementAllocation = {
  batchNumber?: string;
  expirationDate?: string;
  quantityPackages?: number;
  quantityPieces?: number;
};

function asAllocations(value: unknown): ReplacementAllocation[] {
  return Array.isArray(value) ? value as ReplacementAllocation[] : [];
}

function formatDate(value: string | Date) {
  return new Date(value).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatExpiration(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(`${value}T00:00:00`).toLocaleDateString("it-IT");
}

function typeLabel(value: string) {
  return value === "reallocated" ? "Riallocata e scaricata" : "Evasa senza scarico";
}

export default function FulfillmentExceptionsReport() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [exceptionType, setExceptionType] = useState(ALL_TYPES);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const report = trpc.reports.fulfillmentExceptions.list.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    exceptionType: exceptionType === ALL_TYPES
      ? undefined
      : exceptionType as "reallocated" | "no_stock_movement",
    limit: 200,
    offset: 0,
  });

  return (
    <DashboardLayout>
      <ReportLayout
        title="Righe evase con eccezione"
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        onExportCsv={() => undefined}
        csvDatasets={[]}
      >
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">Tipo eccezione:</span>
          <Select value={exceptionType} onValueChange={setExceptionType}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder="Tutte le eccezioni" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES}>Tutte le eccezioni</SelectItem>
              <SelectItem value="reallocated">Riallocata e scaricata</SelectItem>
              <SelectItem value="no_stock_movement">Evasa senza scarico</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">I dati sono filtrati per l’azienda attiva selezionata.</span>
        </div>

        <Alert className="mb-6 border-amber-300 bg-amber-50 text-amber-950">
          <AlertTriangle className="h-4 w-4 text-amber-700" />
          <AlertTitle>Audit di evasione</AlertTitle>
          <AlertDescription>
            Le righe “Evasa senza scarico” non hanno generato movimenti merce né consumo etichette. Le riallocazioni riportano i lotti FEFO effettivamente scaricati.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle className="flex items-center gap-2 text-base"><PackageCheck className="h-5 w-5 text-emerald-700" />Dettaglio eccezioni</CardTitle>
            <Badge variant="secondary">{report.data?.total ?? 0} righe</Badge>
          </CardHeader>
          <CardContent className="p-0">
            {report.isLoading && <div className="py-12 text-center text-sm text-muted-foreground">Caricamento report…</div>}
            {report.isError && (
              <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-destructive">
                <span>{report.error.message}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => report.refetch()}><RefreshCw className="mr-1 h-3.5 w-3.5" />Riprova</Button>
              </div>
            )}
            {report.data && report.data.items.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">Nessuna riga evasa con eccezione nel periodo selezionato.</div>
            )}
            {report.data && report.data.items.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>Data</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Ordine / rivenditore</TableHead>
                      <TableHead>Prodotto</TableHead>
                      <TableHead>Lotto originario</TableHead>
                      <TableHead className="text-right">Giacenza lotto / prodotto</TableHead>
                      <TableHead>Motivo / operatore</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data.items.map((item) => {
                      const allocations = asAllocations(item.replacementAllocations);
                      const expandable = allocations.length > 0;
                      const expanded = expandedId === item.id;
                      return (
                        <Fragment key={item.id}>
                          <TableRow>
                            <TableCell>
                              {expandable ? (
                                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="Mostra lotti riallocati" onClick={() => setExpandedId(expanded ? null : item.id)}>
                                  {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                </Button>
                              ) : null}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs">{formatDate(item.createdAt)}</TableCell>
                            <TableCell><Badge variant={item.exceptionType === "reallocated" ? "default" : "outline"}>{typeLabel(item.exceptionType)}</Badge></TableCell>
                            <TableCell><div className="font-medium">{item.orderNumber}</div><div className="text-xs text-muted-foreground">{item.retailerName ?? "—"}</div></TableCell>
                            <TableCell><div className="font-medium">{item.productName}</div><div className="font-mono text-xs text-muted-foreground">{item.productSku} · {item.quantityPackages} conf. / {item.quantityPieces} pz</div></TableCell>
                            <TableCell><div className="font-mono text-xs">{item.originalBatchNumber}</div><div className="text-xs text-muted-foreground">scad. {formatExpiration(item.originalBatchExpiration)}</div></TableCell>
                            <TableCell className="text-right font-mono text-xs">{item.originalBatchQuantity} pz / {item.productCentralQuantity} pz</TableCell>
                            <TableCell><div className="max-w-[300px] text-sm">{item.reason}</div><div className="mt-1 text-xs text-muted-foreground">{item.actorName ?? "Utente non disponibile"}</div></TableCell>
                          </TableRow>
                          {expanded && (
                            <TableRow className="bg-muted/35">
                              <TableCell colSpan={8} className="px-8 py-3">
                                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Lotti FEFO scaricati</div>
                                <div className="flex flex-wrap gap-2">
                                  {allocations.map((allocation, index) => (
                                    <Badge key={`${item.id}-${allocation.batchNumber ?? index}`} variant="secondary" className="font-normal">
                                      {allocation.batchNumber ?? "Lotto"} · scad. {formatExpiration(allocation.expirationDate)} · {allocation.quantityPackages ?? 0} conf. / {allocation.quantityPieces ?? 0} pz
                                    </Badge>
                                  ))}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </DashboardLayout>
  );
}
