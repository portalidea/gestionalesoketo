import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { EKETO_COMPANY_ID, SOKETO_COMPANY_ID } from "../../../shared/const";
import { ArrowRightLeft, CheckCircle2, Loader2, PackageSearch, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const COMPANY_OPTIONS = [
  { id: EKETO_COMPANY_ID, name: "E-Keto Food" },
  { id: SOKETO_COMPANY_ID, name: "SoKeto Srl" },
] as const;

export default function ManualIntercompanyTransfer() {
  const utils = trpc.useUtils();
  const [sourceCompanyId, setSourceCompanyId] = useState(EKETO_COMPANY_ID);
  const [destinationCompanyId, setDestinationCompanyId] = useState(SOKETO_COMPANY_ID);
  const [productId, setProductId] = useState("");
  const [sourceBatchId, setSourceBatchId] = useState("");
  const [quantityText, setQuantityText] = useState("");
  const [notes, setNotes] = useState("");
  const [transferReference, setTransferReference] = useState(() => `manual:${crypto.randomUUID()}`);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastTransfer, setLastTransfer] = useState<{ transferReference: string; directionLabel: string; batchNumber: string; quantityPieces: number } | null>(null);

  const products = trpc.products.list.useQuery();
  const batches = trpc.orders.getManualIntercompanySourceBatches.useQuery(
    { sourceCompanyId, destinationCompanyId, productId },
    { enabled: Boolean(productId) && sourceCompanyId !== destinationCompanyId },
  );
  const selectedBatch = useMemo(
    () => batches.data?.batches.find((batch) => batch.batchId === sourceBatchId) ?? null,
    [batches.data?.batches, sourceBatchId],
  );
  const quantityPieces = Number(quantityText);
  const canConfirm = Boolean(
    productId && sourceBatchId && Number.isInteger(quantityPieces) && quantityPieces > 0
      && selectedBatch && quantityPieces <= selectedBatch.availablePieces && notes.trim(),
  );

  useEffect(() => {
    setSourceBatchId("");
    setQuantityText("");
  }, [sourceCompanyId, destinationCompanyId, productId]);

  const confirmTransfer = trpc.orders.confirmManualIntercompanyTransfer.useMutation({
    onSuccess: (result) => {
      setLastTransfer({
        transferReference: result.transferReference,
        directionLabel: result.directionLabel,
        batchNumber: result.batchNumber ?? selectedBatch?.batchNumber ?? "—",
        quantityPieces: result.quantityPieces,
      });
      setConfirmOpen(false);
      setSourceBatchId("");
      setQuantityText("");
      setNotes("");
      setTransferReference(`manual:${crypto.randomUUID()}`);
      utils.orders.getManualIntercompanySourceBatches.invalidate({ sourceCompanyId, destinationCompanyId, productId });
      utils.reports.intercompanyTransfers.getMonthly.invalidate();
      toast.success(result.alreadyTransferred ? `Travaso ${result.directionLabel} già registrato` : `Travaso ${result.directionLabel} completato`);
    },
    onError: (error) => toast.error(error.message),
  });

  function changeSource(companyId: string) {
    setSourceCompanyId(companyId);
    if (companyId === destinationCompanyId) {
      setDestinationCompanyId(COMPANY_OPTIONS.find((company) => company.id !== companyId)!.id);
    }
  }

  function changeDestination(companyId: string) {
    setDestinationCompanyId(companyId);
    if (companyId === sourceCompanyId) {
      setSourceCompanyId(COMPANY_OPTIONS.find((company) => company.id !== companyId)!.id);
    }
  }

  return (
    <DashboardLayout>
      <main className="container max-w-5xl space-y-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold"><ArrowRightLeft className="h-6 w-6 text-emerald-700" />Travaso manuale inter-company</h1>
            <p className="mt-1 text-sm text-muted-foreground">Sposta un lotto fra i magazzini centrali E-Keto e SoKeto con tracciabilità completa.</p>
          </div>
          <Button variant="outline" asChild><a href="/reports/travasi-intercompany">Apri riepilogo mensile</a></Button>
        </div>

        <Alert className="border-amber-300 bg-amber-50 text-amber-950">
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>Conferma obbligatoria e registrazione immediata</AlertTitle>
          <AlertDescription>La conferma crea due movimenti <strong>TRANSFER</strong>, uno per company, e collega i ledger mediante un identificativo del travaso. Non è legata a un ordine né genera fatture automatiche.</AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>Dettagli del travaso</CardTitle>
            <CardDescription>La quantità è sempre espressa in pezzi singoli, come la giacenza di magazzino.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="source-company">Company origine</Label><Select value={sourceCompanyId} onValueChange={changeSource}><SelectTrigger id="source-company"><SelectValue /></SelectTrigger><SelectContent>{COMPANY_OPTIONS.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label htmlFor="destination-company">Company destinazione</Label><Select value={destinationCompanyId} onValueChange={changeDestination}><SelectTrigger id="destination-company"><SelectValue /></SelectTrigger><SelectContent>{COMPANY_OPTIONS.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2 md:col-span-2"><Label htmlFor="product">Prodotto</Label><Select value={productId} onValueChange={setProductId}><SelectTrigger id="product"><SelectValue placeholder="Seleziona il prodotto" /></SelectTrigger><SelectContent>{products.data?.map((product) => <SelectItem key={product.id} value={product.id}>{product.sku} · {product.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2 md:col-span-2"><Label htmlFor="source-batch">Lotto nel centrale {batches.data?.sourceCompanyName ?? "origine"}</Label><Select value={sourceBatchId} onValueChange={setSourceBatchId} disabled={!productId || batches.isLoading || !batches.data?.batches.length}><SelectTrigger id="source-batch"><SelectValue placeholder={batches.isLoading ? "Caricamento lotti…" : "Seleziona il lotto"} /></SelectTrigger><SelectContent>{batches.data?.batches.map((batch) => <SelectItem key={batch.batchId} value={batch.batchId}>{batch.batchNumber} · scad. {batch.expirationDate ?? "—"} · {batch.availablePieces} pz · costo € {Number(batch.costPrice ?? 0).toFixed(4)}</SelectItem>)}</SelectContent></Select>{productId && !batches.isLoading && !batches.data?.batches.length && <p className="text-sm text-muted-foreground">Nessun lotto disponibile nel centrale origine.</p>}</div>
            <div className="space-y-2"><Label htmlFor="quantity">Quantità da trasferire (pezzi)</Label><Input id="quantity" inputMode="numeric" min="1" max={selectedBatch?.availablePieces} type="number" value={quantityText} onChange={(event) => setQuantityText(event.target.value)} disabled={!selectedBatch} />{selectedBatch && <p className="text-xs text-muted-foreground">Disponibili: {selectedBatch.availablePieces} pezzi.</p>}</div>
            <div className="space-y-2"><Label htmlFor="notes">Nota obbligatoria</Label><Textarea id="notes" placeholder="Motivo del travaso, ad esempio: riallineamento fisico magazzino" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} /></div>
          </CardContent>
        </Card>

        <div className="flex justify-end"><Button disabled={!canConfirm || confirmTransfer.isPending} onClick={() => setConfirmOpen(true)}><PackageSearch className="mr-2 h-4 w-4" />Prepara conferma</Button></div>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Confermi il travaso {batches.data?.directionLabel}?</DialogTitle><DialogDescription>{selectedBatch ? `Saranno trasferiti ${quantityPieces} pezzi del lotto ${selectedBatch.batchNumber}, scadenza ${selectedBatch.expirationDate ?? "—"}. Verranno registrati due movimenti TRANSFER e creato un lotto speculare, se necessario.` : "Seleziona un lotto disponibile."}</DialogDescription></DialogHeader>
            <div className="rounded-md bg-muted p-3 text-sm"><strong>Nota:</strong> {notes}</div>
            <DialogFooter><Button variant="outline" onClick={() => setConfirmOpen(false)}>Annulla</Button><Button disabled={!canConfirm || confirmTransfer.isPending} onClick={() => confirmTransfer.mutate({ sourceCompanyId, destinationCompanyId, sourceBatchId, quantityPieces, notes, transferReference })}>{confirmTransfer.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{confirmTransfer.isPending ? "Travaso in corso…" : "Conferma e registra"}</Button></DialogFooter>
          </DialogContent>
        </Dialog>

        {lastTransfer && <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950"><CheckCircle2 className="h-4 w-4" /><AlertTitle>Travaso registrato</AlertTitle><AlertDescription>{lastTransfer.directionLabel} · lotto {lastTransfer.batchNumber} · {lastTransfer.quantityPieces} pezzi. Riferimento: <span className="font-mono text-xs">{lastTransfer.transferReference}</span></AlertDescription></Alert>}
      </main>
    </DashboardLayout>
  );
}
