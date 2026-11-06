import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, RefreshCw, Settings, Store } from "lucide-react";
import { toast } from "sonner";

const PAGE_SIZE = 25;
const statuses = [
  "pending",
  "not_shipped",
  "pre_cutoff",
  "review_required",
  "dry_run",
  "processed",
  "cancelled",
  "post_stock_alert",
] as const;
type StockStatus = (typeof statuses)[number];
const labels: Record<string, string> = {
  pending: "In coda",
  not_shipped: "Non spedito",
  pre_cutoff: "Prima del cutoff",
  review_required: "Da revisionare",
  dry_run: "Prova, nessuno scarico",
  processed: "Scaricato",
  cancelled: "Cancellato",
  post_stock_alert: "Allerta dopo scarico",
  requested: "Richiesto",
  processing: "In elaborazione",
  completed: "Completato",
  fatal: "Errore",
};
const formatDate = (value: string | Date | null | undefined) =>
  value
    ? new Date(value).toLocaleString("it-IT", { timeZone: "Europe/Rome" })
    : "—";
type RunProgress = {
  status: string;
  dryRun: boolean;
  document: {
    totalRows: number | null;
    ingestedRows: number | null;
    acquiredAt: string | Date | null;
    ingestStartedAt: string | Date | null;
    ingestCompletedAt: string | Date | null;
    processingCompletedAt: string | Date | null;
    processingMs: number | null;
    lastError: string | null;
  } | null;
};
export const isAmazonRunActive = (run: { status: string }) =>
  ["requested", "pending", "processing"].includes(run.status);
export function amazonDocumentStage(run: RunProgress): string {
  const document = run.document;
  if (!document) {
    if (["requested", "pending"].includes(run.status))
      return "In attesa del documento Amazon";
    return "Import legacy: documento persistito non disponibile";
  }
  if (run.status === "fatal" || document.lastError)
    return "Elaborazione interrotta: verificare l’errore";
  if (document.processingCompletedAt)
    return document.totalRows === 0
      ? "Completato: documento senza righe"
      : "Elaborazione completata";
  if (!document.ingestStartedAt && !document.ingestCompletedAt)
    return "Documento ricevuto / in coda";
  if (!document.ingestCompletedAt)
    return `Ingestione ${document.ingestedRows ?? 0}/${document.totalRows ?? "—"}`;
  return run.dryRun
    ? "Elaborazione stock in prova (dry-run): nessuno scarico"
    : "Elaborazione stock reale";
}
export function amazonProcessingDuration(
  value: number | null | undefined
): string {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? `${new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2 }).format(value / 1000)} s`
    : "—";
}
function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}
function Pager({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-4 text-sm text-muted-foreground">
      <span>
        {total
          ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} di ${total}`
          : "Nessuna riga"}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
        >
          Precedenti
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => onChange(offset + PAGE_SIZE)}
        >
          Successivi
        </Button>
      </div>
    </div>
  );
}

export default function MarketplaceAmazon() {
  const utils = trpc.useUtils();
  const config = trpc.amazon.store.get.useQuery(undefined, { retry: false });
  const [storeId, setStoreId] = useState("");
  const store = config.data?.stores.find(entry => entry.id === storeId);
  const [showConfig, setShowConfig] = useState(false);
  const [newStore, setNewStore] = useState(false);
  const [name, setName] = useState("SoKeto Amazon");
  const [sellerAccountId, setSellerAccountId] = useState("");
  const [purchaseCutoff, setPurchaseCutoff] = useState("2026-09-01");
  const [enabled, setEnabled] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [confirmation, setConfirmation] = useState<
    "save" | "process" | "processLoop" | "toggle" | null
  >(null);
  const [dateFrom, setDateFrom] = useState(
    () =>
      new Date()
        .toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" })
        .slice(0, 8) + "01"
  );
  const [dateTo, setDateTo] = useState(() =>
    new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" })
  );
  const [runOffset, setRunOffset] = useState(0);
  const [orderOffset, setOrderOffset] = useState(0);
  const [rowOffset, setRowOffset] = useState(0);
  const [runId, setRunId] = useState("");
  const [status, setStatus] = useState<StockStatus | "all">("all");
  const [requeueItem, setRequeueItem] = useState<string | null>(null);
  const [batchLoopActive, setBatchLoopActive] = useState(false);
  const batchGeneration = useRef(0);
  const batchInFlight = useRef(false);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelScheduledBatch() {
    batchGeneration.current += 1;
    if (batchTimer.current !== null) clearTimeout(batchTimer.current);
    batchTimer.current = null;
  }
  function pauseBatchLoop() {
    cancelScheduledBatch();
    setBatchLoopActive(false);
  }
  // A store change or unmount cancels only future calls. The already submitted
  // transaction may finish safely; do not pretend that pausing rolls it back.
  useEffect(() => {
    setBatchLoopActive(false);
    setConfirmation(null);
    return cancelScheduledBatch;
  }, [storeId]);

  useEffect(() => {
    if (!storeId && config.data?.stores[0])
      setStoreId(config.data.stores[0].id);
  }, [config.data, storeId]);
  useEffect(() => {
    setRunOffset(0);
    setOrderOffset(0);
    setRowOffset(0);
    setRunId("");
  }, [dateFrom, dateTo, storeId]);
  const periodValid =
    !!store &&
    dateFrom <= dateTo &&
    (Date.parse(dateTo) - Date.parse(dateFrom)) / 86_400_000 <= 92;
  const period = { storeId, dateFrom, dateTo };
  const summary = trpc.amazon.summary.useQuery(period, {
    enabled: periodValid,
    refetchInterval: query =>
      query.state.data?.daily.some(isAmazonRunActive) ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const runs = trpc.amazon.runs.list.useQuery(
    { ...period, limit: PAGE_SIZE, offset: runOffset },
    {
      enabled: periodValid,
      refetchInterval: query =>
        query.state.data?.items.some(isAmazonRunActive) ? 5_000 : false,
      refetchIntervalInBackground: false,
    }
  );
  const orders = trpc.amazon.orders.list.useQuery(
    {
      ...period,
      status: status === "all" ? undefined : status,
      limit: PAGE_SIZE,
      offset: orderOffset,
    },
    { enabled: periodValid }
  );
  const observations = trpc.amazon.runs.observations.useQuery(
    { storeId, runId, limit: PAGE_SIZE, offset: rowOffset },
    { enabled: !!store && !!runId }
  );
  const refresh = () => {
    void utils.amazon.invalidate();
  };
  const configure = trpc.amazon.store.configure.useMutation({
    onSuccess: data => {
      toast.success(data.message);
      setStoreId(data.storeId);
      setShowConfig(false);
      refresh();
    },
    onError: error => toast.error(error.message),
  });
  const processBatch = trpc.amazon.processBatch.useMutation({ retry: false });
  async function executeBatch(repeat: boolean, generation: number) {
    if (batchInFlight.current || generation !== batchGeneration.current) return;
    batchInFlight.current = true;
    try {
      const data = await processBatch.mutateAsync({
        storeId,
        confirmRealStock: true,
      });
      if (generation !== batchGeneration.current) return;
      refresh();
      if (
        data.result.disabled ||
        data.result.lastError ||
        data.result.worker.errors.length
      ) {
        pauseBatchLoop();
        toast.error(
          data.result.disabled
            ? "Import disabilitato: elaborazione a lotti in pausa."
            : "Errore nel lotto: elaborazione in pausa. Verifica la cronologia prima di riprovare."
        );
        return;
      }
      if (repeat && data.result.hasMore) {
        // Exactly one request at a time, with a gap between bounded lots.
        batchTimer.current = setTimeout(() => {
          batchTimer.current = null;
          void executeBatch(true, generation);
        }, 1_000);
      } else {
        setBatchLoopActive(false);
        toast.success(
          data.result.hasMore
            ? "Lotto completato. Restano righe: elabora il prossimo lotto o avvia i lotti sequenziali."
            : "Elaborazione terminata: nessun altro lavoro disponibile nello store."
        );
      }
    } catch (error) {
      if (generation !== batchGeneration.current) return;
      pauseBatchLoop();
      toast.error(
        error instanceof Error
          ? error.message
          : "Elaborazione interrotta: aggiorna gli esiti prima di riprovare"
      );
      refresh();
    } finally {
      batchInFlight.current = false;
    }
  }
  function startBatch(repeat: boolean) {
    if (batchInFlight.current) return;
    cancelScheduledBatch();
    setBatchLoopActive(repeat);
    void executeBatch(repeat, batchGeneration.current);
  }
  const requeue = trpc.amazon.orders.requeueReview.useMutation({
    onSuccess: data => {
      toast.success(data.message);
      refresh();
    },
    onError: error => toast.error(error.message),
  });
  function openConfig(create: boolean) {
    setNewStore(create);
    setName(create ? "SoKeto Amazon" : (store?.name ?? "SoKeto Amazon"));
    setSellerAccountId(create ? "" : (store?.sellerAccountId ?? ""));
    setPurchaseCutoff(
      create ? "2026-09-01" : (store?.purchaseCutoff ?? "2026-09-01")
    );
    setEnabled(create ? false : (store?.enabled ?? false));
    setDryRun(create ? true : (store?.dryRun ?? true));
    setShowConfig(true);
  }
  function save(confirmed = false) {
    configure.mutate({
      storeId: newStore ? undefined : store?.id,
      name,
      sellerAccountId,
      purchaseCutoff,
      enabled,
      dryRun,
      confirmRealStock: confirmed,
    });
  }
  const canRequeue = (entry: {
    status: string | null;
    actualPieces: number;
    fulfillmentChannel: string | null;
    itemStatus: string | null;
    orderStatus: string | null;
  }) =>
    entry.status === "review_required" &&
    entry.actualPieces === 0 &&
    entry.fulfillmentChannel === "Merchant" &&
    entry.itemStatus === "Shipped" &&
    (entry.orderStatus === "Shipped" ||
      entry.orderStatus === "PartiallyShipped");
  const error =
    summary.error ?? runs.error ?? orders.error ?? observations.error;

  return (
    <DashboardLayout>
      <div className="p-2 md:p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Store className="h-6 w-6" />
              Marketplace — Amazon
            </h1>
            <p className="text-muted-foreground mt-1">
              SoKeto · Import giornaliero marketplace nell’azienda attiva
              E-Keto. Separato dagli ordini B2B e Shopify.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={refresh}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Aggiorna
            </Button>
            <Button
              variant="outline"
              onClick={() => openConfig(!store)}
              disabled={!!config.error}
            >
              <Settings className="h-4 w-4 mr-2" />
              Configura
            </Button>
            {store && (
              <Button variant="outline" onClick={() => openConfig(true)}>
                Nuovo account
              </Button>
            )}
          </div>
        </div>
        {config.isLoading && (
          <p className="text-muted-foreground">Caricamento configurazione…</p>
        )}
        {config.error && (
          <Card>
            <CardContent className="pt-6 text-destructive">
              {config.error.message}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Configurazione collegamento server
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Il collegamento usa le variabili server{" "}
              <code>AMAZON_IMPORT_STORE_ID</code> e{" "}
              <code>AMAZON_IMPORT_WEBHOOK_KEY</code>. La chiave non è visibile,
              modificabile o generata da questa pagina.
            </p>
            <p>
              Nessuna credenziale Amazon viene salvata qui. Salvare lo store non
              verifica la connessione e non avvia importazioni.
            </p>
            <p>
              La modalità prova resta attiva finché un admin la disattiva
              manualmente: nessuna scadenza automatica.
            </p>
            <p>
              Upload HTTP 202 = documento ricevuto e salvato in modo durevole,
              non import completato. L’ingestione delle righe e l’elaborazione
              stock avvengono in lotti separati. Aprire questa pagina non avvia
              alcun worker: l’aggiornamento ogni 5 secondi legge solo gli stati.
            </p>
          </CardContent>
        </Card>
        {!config.error &&
          !config.isLoading &&
          !config.data?.stores.length &&
          !showConfig && (
            <Card>
              <CardContent className="pt-6 space-y-3">
                <p>
                  Nessuno store Amazon configurato per{" "}
                  {config.data?.companyName}.
                </p>
                <Button onClick={() => openConfig(true)}>
                  Configura store Amazon
                </Button>
              </CardContent>
            </Card>
          )}
        {showConfig && (
          <Card>
            <CardHeader>
              <CardTitle>
                {newStore
                  ? "Nuovo store Amazon"
                  : "Configurazione store Amazon"}
              </CardTitle>
              <CardDescription>
                Azienda: {config.data?.companyName}. Il Seller Account ID è
                l’identificativo univoco dello store, non una credenziale.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-4"
                onSubmit={event => {
                  event.preventDefault();
                  if (!dryRun) setConfirmation("save");
                  else save();
                }}
              >
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="amazon-name">Nome store</Label>
                    <Input
                      id="amazon-name"
                      value={name}
                      maxLength={255}
                      onChange={event => setName(event.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="amazon-seller">Seller Account ID</Label>
                    <Input
                      id="amazon-seller"
                      value={sellerAccountId}
                      maxLength={255}
                      disabled={!newStore}
                      onChange={event => setSellerAccountId(event.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="amazon-cutoff">
                      Cutoff acquisto (Europe/Rome)
                    </Label>
                    <Input
                      id="amazon-cutoff"
                      type="date"
                      value={purchaseCutoff}
                      onChange={event => setPurchaseCutoff(event.target.value)}
                      required
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Cutoff su purchase-date, non su last-updated-date. Prima del
                  cutoff: nessuno scarico.
                </p>
                <div className="flex flex-wrap gap-6">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="amazon-enabled"
                      checked={enabled}
                      onCheckedChange={setEnabled}
                    />
                    <Label htmlFor="amazon-enabled">Import abilitato</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="amazon-dry-run"
                      checked={dryRun}
                      onCheckedChange={value => {
                        if (!value) setConfirmation("toggle");
                        else setDryRun(true);
                      }}
                    />
                    <Label htmlFor="amazon-dry-run">
                      Modalità prova (dry-run)
                    </Label>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={configure.isPending}>
                    {configure.isPending
                      ? "Salvataggio…"
                      : "Salva configurazione"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowConfig(false)}
                  >
                    Annulla
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
        {store && (
          <>
            <Card>
              <CardContent className="pt-6 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-2">
                  <Select value={storeId} onValueChange={setStoreId}>
                    <SelectTrigger className="w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {config.data?.stores.map(entry => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">
                    {config.data?.companyName} · Seller: {store.sellerAccountId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Store ID: <code className="break-all">{store.id}</code> ·
                    Cutoff: {store.purchaseCutoff}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Checkpoint: {formatDate(store.checkpointAt)} · Ultima
                    modifica: {formatDate(store.updatedAt)}
                  </p>
                </div>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Badge variant={store.enabled ? "default" : "secondary"}>
                      {store.enabled ? "Abilitato" : "Disabilitato"}
                    </Badge>
                    <Badge variant={store.dryRun ? "secondary" : "destructive"}>
                      {store.dryRun ? "Prova senza movimenti" : "Scarico reale"}
                    </Badge>
                  </div>
                  <Button
                    disabled={
                      !store.enabled ||
                      processBatch.isPending ||
                      batchLoopActive
                    }
                    onClick={() => setConfirmation("process")}
                  >
                    {processBatch.isPending
                      ? "Elaborazione lotto…"
                      : "Elabora prossimo lotto"}
                  </Button>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={
                        !store.enabled ||
                        processBatch.isPending ||
                        batchLoopActive
                      }
                      onClick={() => setConfirmation("processLoop")}
                    >
                      Avvia elaborazione a lotti
                    </Button>
                    {batchLoopActive && (
                      <Button variant="outline" onClick={pauseBatchLoop}>
                        Pausa
                      </Button>
                    )}
                  </div>
                  <p
                    className="max-w-md text-xs text-muted-foreground"
                    role="status"
                  >
                    {batchLoopActive
                      ? "Lotti sequenziali attivi: massimo 5 righe per chiamata, budget 12 secondi. Mantieni aperta la pagina."
                      : "Avvio solo manuale; massimo 5 righe per chiamata. Il worker elabora prima i documenti, poi la coda stock."}{" "}
                    Pausa o cambio store fermano le chiamate successive, non il
                    lotto già inviato.
                  </p>
                </div>
              </CardContent>
            </Card>
            <div className="rounded-lg border border-amber-500/40 p-4 text-sm space-y-2">
              <p className="font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Regole di riconciliazione
              </p>
              <p>
                Solo righe Merchant con articolo Shipped possono scaricare
                stock. FBA, canale ignoto, SKU mancante e stock insufficiente
                richiedono revisione; righe non spedite, prima del cutoff o
                cancellate non scaricano.
              </p>
              <p>
                Cancellazioni e resi successivi allo scarico sono segnalati, non
                stornati automaticamente. Lo storico non viene annullato. La
                data movimento è l’aggiornamento Amazon, non la data di
                spedizione.
              </p>
              <p>
                Correggi mappatura SKU o disponibilità prima di rimettere una
                revisione in coda. La rimessa in coda non crea movimenti.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Label htmlFor="amazon-from">Dal</Label>
                <Input
                  id="amazon-from"
                  type="date"
                  value={dateFrom}
                  onChange={event => setDateFrom(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amazon-to">Al (incluso)</Label>
                <Input
                  id="amazon-to"
                  type="date"
                  value={dateTo}
                  onChange={event => setDateTo(event.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Calendario Europe/Rome · massimo 93 giorni
              </p>
            </div>
            {!periodValid && (
              <p className="text-destructive">
                Seleziona un intervallo valido di massimo 93 giorni.
              </p>
            )}
            {error && <p className="text-destructive">{error.message}</p>}
            <div className="grid sm:grid-cols-3 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Ordini importati distinti
                  </CardTitle>
                  <CardDescription>
                    Nuovi ordini nel periodo, non righe ripetute del file
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-3xl font-bold">
                  {summary.data?.importedOrders ?? "—"}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Pezzi realmente scaricati
                  </CardTitle>
                  <CardDescription>
                    Registro allocazioni degli import del periodo
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-3xl font-bold">
                  {summary.data?.actualPieces ?? "—"}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Pezzi che sarebbero scaricati
                  </CardTitle>
                  <CardDescription>
                    Ultimo piano per articolo distinto nel periodo, solo se
                    ancora in dry-run. Duplicati e report sovrapposti non
                    moltiplicano i pezzi; non sono movimenti.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-3xl font-bold">
                  {summary.data?.plannedPieces ?? "—"}
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Pezzi per prodotto</CardTitle>
                <CardDescription>
                  Allocazioni reali dal ledger; piani di prova deduplicati per
                  articolo, senza scarichi.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Prodotto</TableHead>
                      <TableHead>Scaricati realmente</TableHead>
                      <TableHead>Pianificati in prova</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.data?.products.map(row => (
                      <TableRow key={row.productId}>
                        <TableCell>{row.productName}</TableCell>
                        <TableCell>{row.actualPieces} pz</TableCell>
                        <TableCell>{row.plannedPieces} pz</TableCell>
                      </TableRow>
                    ))}
                    {!summary.data?.products.length && (
                      <TableRow>
                        <TableCell colSpan={3}>
                          Nessuna allocazione nel periodo.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  Nuovi ordini per giorno
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Giorno</TableHead>
                      <TableHead>Ordini distinti</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.data?.dailyOrders.map(row => (
                      <TableRow key={row.date}>
                        <TableCell>{row.date}</TableCell>
                        <TableCell>{row.orders}</TableCell>
                      </TableRow>
                    ))}
                    {!summary.data?.dailyOrders.length && (
                      <TableRow>
                        <TableCell colSpan={2}>Nessun nuovo ordine.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  Riepilogo giornaliero import
                </CardTitle>
                <CardDescription>
                  Periodo riferito alla creazione dell’import. Esiti
                  osservazioni raw (non ordini distinti):{" "}
                  {summary.data?.outcomes
                    .map(
                      entry =>
                        `${labels[entry.outcome] ?? entry.outcome}: ${entry.rows}`
                    )
                    .join(" · ") || "Nessun esito"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Giorno</TableHead>
                      <TableHead>Stato</TableHead>
                      <TableHead>Modalità</TableHead>
                      <TableHead>Import</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.data?.daily.map(entry => (
                      <TableRow
                        key={`${entry.date}-${entry.status}-${entry.dryRun}`}
                      >
                        <TableCell>{entry.date}</TableCell>
                        <TableCell>
                          {labels[entry.status] ?? entry.status}
                        </TableCell>
                        <TableCell>
                          {entry.dryRun ? "Prova" : "Reale"}
                        </TableCell>
                        <TableCell>{entry.runs}</TableCell>
                      </TableRow>
                    ))}
                    {!summary.data?.daily.length && (
                      <TableRow>
                        <TableCell colSpan={4}>
                          Nessun import nel periodo.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Cronologia import</CardTitle>
                <CardDescription>
                  Acquisizione, ingestione e stock sono fasi separate. Durata =
                  tempo cumulativo dei lotti worker, esclusi upload e attesa in
                  coda. Import legacy senza documento non equivalgono a report
                  vuoti.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Creato</TableHead>
                      <TableHead>Finestra</TableHead>
                      <TableHead>Esito</TableHead>
                      <TableHead>Documento / avanzamento</TableHead>
                      <TableHead>Durata worker</TableHead>
                      <TableHead>Riepilogo</TableHead>
                      <TableHead>Righe</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.data?.items.map(entry => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          {formatDate(entry.createdAt)}
                          <p className="text-xs">
                            {entry.dryRun ? "Prova" : "Reale"}
                          </p>
                        </TableCell>
                        <TableCell>
                          {formatDate(entry.windowStart)}
                          <br />
                          {formatDate(entry.windowEnd)}
                        </TableCell>
                        <TableCell>
                          {labels[entry.status] ?? entry.status}
                          {entry.error && (
                            <p className="text-xs text-destructive">
                              {entry.error}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <p className="font-medium" role="status">
                            {amazonDocumentStage({
                              ...entry,
                              dryRun: store.dryRun,
                            })}
                          </p>
                          {entry.document && (
                            <div className="space-y-1 text-xs text-muted-foreground mt-1">
                              <p>
                                Ricevuto:{" "}
                                {formatDate(entry.document.acquiredAt)}
                              </p>
                              <p>
                                Ingestione {entry.document.ingestedRows ?? 0}/
                                {entry.document.totalRows ?? "—"}
                              </p>
                              <p>
                                Inizio ingestione:{" "}
                                {formatDate(entry.document.ingestStartedAt)}
                              </p>
                              <p>
                                Fine ingestione:{" "}
                                {formatDate(entry.document.ingestCompletedAt)}
                              </p>
                              <p>
                                Fine elaborazione:{" "}
                                {formatDate(
                                  entry.document.processingCompletedAt
                                )}
                              </p>
                              {entry.document.lastError && (
                                <p className="text-destructive">
                                  {entry.document.lastError}
                                </p>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {amazonProcessingDuration(
                            entry.document?.processingMs
                          )}
                          {entry.document &&
                            !entry.document.processingCompletedAt && (
                              <p className="text-xs text-muted-foreground">
                                Parziale / in corso
                              </p>
                            )}
                        </TableCell>
                        <TableCell>
                          <details>
                            <summary className="cursor-pointer">
                              Dettagli
                            </summary>
                            <pre className="max-w-sm whitespace-pre-wrap text-xs">
                              {jsonText(entry.summary)}
                            </pre>
                          </details>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setRunId(entry.id);
                              setRowOffset(0);
                            }}
                          >
                            Visualizza righe
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!runs.data?.items.length && (
                      <TableRow>
                        <TableCell colSpan={7}>
                          Nessun import nel periodo: nessun documento ricevuto
                          visibile.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                <Pager
                  offset={runOffset}
                  total={runs.data?.total ?? 0}
                  onChange={setRunOffset}
                />
              </CardContent>
            </Card>
            {runId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">
                    Righe osservate nell’import
                  </CardTitle>
                  <CardDescription>
                    {runId} · Include righe in quarantena senza ID articolo.
                    Quantità reali cumulative dell’articolo, anche da import
                    successivi.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ordine / SKU / Prodotto</TableHead>
                        <TableHead>Quantità</TableHead>
                        <TableHead>Date Amazon</TableHead>
                        <TableHead>Esito / motivo</TableHead>
                        <TableHead>
                          Lotti FEFO · produzione / scadenza
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {observations.data?.items.map(entry => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            {entry.rowNumber !== null && (
                              <p className="text-xs font-semibold mb-1">
                                Riga {entry.rowNumber} del file
                              </p>
                            )}
                            {entry.orderId ?? "ID mancante"}
                            <br />
                            {entry.sku ?? "SKU mancante"}
                            <p className="text-xs">
                              {entry.productName ?? "Non mappato"}
                            </p>
                          </TableCell>
                          <TableCell>
                            {entry.quantity ?? "—"} unità ·{" "}
                            {entry.pieces ?? "—"} pz
                            <p className="text-xs">
                              Reali cumulativi: {entry.actualPieces} pz
                            </p>
                            <p className="text-xs">
                              Pianificati:{" "}
                              {entry.plannedAllocations.reduce(
                                (sum, allocation) => sum + allocation.pieces,
                                0
                              )}{" "}
                              pz
                            </p>
                          </TableCell>
                          <TableCell className="text-xs">
                            Acquisto: {formatDate(entry.purchaseDate)}
                            <br />
                            Aggiornamento: {formatDate(entry.updatedAt)}
                          </TableCell>
                          <TableCell>
                            {labels[entry.outcome] ?? entry.outcome}
                            <p className="text-xs">{entry.reason}</p>
                            {entry.diagnostic && (
                              <div className="text-xs mt-1">
                                <p>{entry.diagnostic.code}</p>
                                {entry.diagnostic.expectedColumns !==
                                  undefined &&
                                  entry.diagnostic.actualColumns !==
                                    undefined && (
                                    <p>
                                      Colonne attese:{" "}
                                      {entry.diagnostic.expectedColumns};
                                      trovate: {entry.diagnostic.actualColumns}.
                                    </p>
                                  )}
                                {entry.diagnostic.field && (
                                  <p>
                                    {entry.diagnostic.field === "column-count"
                                      ? "Struttura della riga non valida: nessun ID o SKU viene dedotto."
                                      : `Campo da verificare: ${entry.diagnostic.field}.`}
                                  </p>
                                )}
                              </div>
                            )}
                            <p className="text-xs">
                              {entry.fulfillmentChannel ?? "Canale ignoto"} ·{" "}
                              {entry.itemStatus ?? "Stato ignoto"}
                            </p>
                          </TableCell>
                          <TableCell className="text-xs space-y-2">
                            {entry.plannedAllocations.map(
                              (allocation, index) => (
                                <p key={`plan-${index}`}>
                                  Piano:{" "}
                                  {allocation.productName ??
                                    allocation.productId ??
                                    "Prodotto"}{" "}
                                  ·{" "}
                                  {allocation.batchNumber ??
                                    allocation.batchId ??
                                    "Lotto"}{" "}
                                  · {allocation.pieces} pz
                                  <br />
                                  Produzione: {allocation.productionDate ??
                                    "—"}{" "}
                                  · Scadenza: {allocation.expirationDate ?? "—"}
                                </p>
                              )
                            )}
                            {entry.allocations.map((allocation, index) => (
                              <p key={`actual-${index}`}>
                                Reale: {allocation.productName} ·{" "}
                                {allocation.batchNumber} · {allocation.pieces}{" "}
                                pz
                                <br />
                                Produzione: {allocation.productionDate ?? "—"} ·
                                Scadenza: {allocation.expirationDate} ·
                                Movimento:{" "}
                                {formatDate(allocation.amazonUpdatedAt)}
                              </p>
                            ))}
                            {!entry.plannedAllocations.length &&
                              !entry.allocations.length &&
                              "Nessuna allocazione"}
                          </TableCell>
                        </TableRow>
                      ))}
                      {!observations.data?.items.length && (
                        <TableRow>
                          <TableCell colSpan={5}>
                            Nessuna osservazione.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  <Pager
                    offset={rowOffset}
                    total={observations.data?.total ?? 0}
                    onChange={setRowOffset}
                  />
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  Ordini Amazon · articoli
                </CardTitle>
                <CardDescription>
                  Solo Amazon nello store e nell’azienda attiva. Periodo sulla
                  data acquisto dell’ordine, distinto dalla cronologia import.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select
                  value={status}
                  onValueChange={value => {
                    if (
                      value === "all" ||
                      statuses.some(entry => entry === value)
                    ) {
                      setStatus(value as StockStatus | "all");
                      setOrderOffset(0);
                    }
                  }}
                >
                  <SelectTrigger className="w-64 mb-4">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tutti gli esiti</SelectItem>
                    {statuses.map(entry => (
                      <SelectItem key={entry} value={entry}>
                        {labels[entry]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ordine / Articolo</TableHead>
                      <TableHead>SKU / Prodotto</TableHead>
                      <TableHead>Unità / pezzi</TableHead>
                      <TableHead>Date Amazon</TableHead>
                      <TableHead>Esito / motivo</TableHead>
                      <TableHead>Revisione</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.data?.items.map(entry => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          {entry.orderId}
                          <p className="text-xs break-all">
                            {entry.orderItemId}
                          </p>
                        </TableCell>
                        <TableCell>
                          {entry.sku}
                          <p className="text-xs">
                            {entry.productName ?? "Non mappato"}
                          </p>
                        </TableCell>
                        <TableCell>
                          {entry.quantity} unità / {entry.pieces} pz
                          <p className="text-xs">
                            Scaricati: {entry.actualPieces} pz
                          </p>
                        </TableCell>
                        <TableCell className="text-xs">
                          Acquisto: {formatDate(entry.purchaseDate)}
                          <br />
                          Aggiornamento: {formatDate(entry.updatedAt)}
                        </TableCell>
                        <TableCell>
                          {labels[entry.status ?? ""] ?? entry.status}
                          <p className="text-xs">{entry.reason}</p>
                          <p className="text-xs">
                            {entry.fulfillmentChannel ?? "Canale ignoto"} ·{" "}
                            {entry.itemStatus} · {entry.orderStatus}
                          </p>
                        </TableCell>
                        <TableCell>
                          {canRequeue(entry) ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={requeue.isPending}
                              onClick={() => setRequeueItem(entry.id)}
                            >
                              Rimetti in coda
                            </Button>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {!orders.data?.items.length && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          Nessun articolo Amazon nel periodo.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                <Pager
                  offset={orderOffset}
                  total={orders.data?.total ?? 0}
                  onChange={setOrderOffset}
                />
              </CardContent>
            </Card>
          </>
        )}
        <AlertDialog
          open={confirmation !== null}
          onOpenChange={open => {
            if (!open) setConfirmation(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Conferma manuale: scarico stock reale
              </AlertDialogTitle>
              <AlertDialogDescription>
                La coda rispetta la modalità server al momento
                dell’elaborazione. Se un altro admin disattiva la prova nel
                frattempo, può scaricare realmente: confermando autorizzi anche
                questo caso. Disattivando la prova, la coda pendente e i dry-run
                storici idonei saranno eleggibili allo scarico reale, anche se
                elaborati in precedenza senza movimenti. Non c’è una scadenza
                automatica della prova. Il salvataggio non processa la coda;
                ogni lotto può creare movimenti reali. “Elabora prossimo lotto”
                esegue una sola chiamata; “Avvia elaborazione a lotti” ripete
                chiamate sequenziali finché c’è lavoro, la pagina resta aperta e
                non premi Pausa. Nessuna modalità viene cambiata
                automaticamente. Cancellazioni e resi non vengono stornati
                automaticamente.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmation === "toggle") setDryRun(false);
                  if (confirmation === "save") save(true);
                  if (confirmation === "process") startBatch(false);
                  if (confirmation === "processLoop") startBatch(true);
                  setConfirmation(null);
                }}
              >
                Confermo consapevolmente
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={requeueItem !== null}
          onOpenChange={open => {
            if (!open) setRequeueItem(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Rimettere la revisione in coda?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Conferma di aver verificato mappatura SKU e stock. Sono ammesse
                solo righe Merchant/Shipped non cancellate e mai scaricate.
                Nessun movimento viene creato ora.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (requeueItem)
                    requeue.mutate({
                      storeId,
                      itemId: requeueItem,
                      confirm: true,
                    });
                  setRequeueItem(null);
                }}
              >
                Conferma rimessa in coda
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
