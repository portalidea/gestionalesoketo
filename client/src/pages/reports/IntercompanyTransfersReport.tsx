import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { Download, ArrowRightLeft } from "lucide-react";

const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

export default function IntercompanyTransfersReport() {
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(today);
  const report = trpc.reports.intercompanyTransfers.getMonthly.useQuery({ dateFrom, dateTo });
  const exportCsv = trpc.reports.intercompanyTransfers.exportCsv.useMutation({
    onSuccess: ({ csvContent, filename }) => {
      const url = URL.createObjectURL(new Blob([csvContent], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
    },
  });
  return <DashboardLayout><main className="container py-6 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Travasi inter-company</h1><p className="text-sm text-muted-foreground">Trasferimenti SoKeto ↔ E-Keto; nessuna fatturazione automatica.</p></div><Button onClick={() => exportCsv.mutate({ dateFrom, dateTo })} disabled={exportCsv.isPending}><Download className="mr-2 h-4 w-4" />Esporta CSV</Button></div>
    <Card><CardContent className="flex gap-3 p-4"><Input aria-label="Data inizio" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /><Input aria-label="Data fine" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><ArrowRightLeft className="h-5 w-5" />Riepilogo mensile · costo € {Number(report.data?.totalCost ?? 0).toFixed(2)}</CardTitle></CardHeader><CardContent>
      <Table><TableHeader><TableRow><TableHead>Data</TableHead><TableHead>Direzione</TableHead><TableHead>Prodotto</TableHead><TableHead>Lotto</TableHead><TableHead>Q.tà</TableHead><TableHead>Costo</TableHead><TableHead>Riferimento</TableHead><TableHead>Ordine</TableHead><TableHead>Stato attuale</TableHead><TableHead>Operatore</TableHead></TableRow></TableHeader><TableBody>
        {report.data?.items.map((row) => <TableRow key={row.id}><TableCell>{new Date(row.timestamp).toLocaleDateString("it-IT")}</TableCell><TableCell>{row.direction}</TableCell><TableCell>{row.productName}</TableCell><TableCell className="font-mono">{row.batchNumber}</TableCell><TableCell>{row.quantity}</TableCell><TableCell>€ {Number(row.totalCost).toFixed(2)}</TableCell><TableCell className="font-mono text-xs">{row.sourceDocument ?? "—"}</TableCell><TableCell>{row.orderNumber ?? "—"}</TableCell><TableCell>{row.orderStatus ?? "—"}</TableCell><TableCell>{row.operatorName ?? "—"}</TableCell></TableRow>)}
        {!report.isLoading && !report.data?.items.length && <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">Nessun travaso nel periodo selezionato.</TableCell></TableRow>}
      </TableBody></Table>
    </CardContent></Card>
  </main></DashboardLayout>;
}
