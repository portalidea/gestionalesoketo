import DashboardLayout from "@/components/DashboardLayout";
import { daysToExpiry, getExpiryColorClass, getExpiryLabel } from "@/lib/expiry-utils";
import { Badge } from "@/components/ui/badge";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import {
  AlertCircle,
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Truck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  SortableTableHead,
  sortData,
  type SortConfig,
} from "@/components/SortableTableHead";

const PAGE_SIZE = 50;
const ALL_TYPES_VALUE = "__all__";
const ALL_LOCATIONS_VALUE = "__all__";

type MovementType =
  | "IN"
  | "OUT"
  | "ADJUSTMENT"
  | "RECEIPT_FROM_PRODUCER"
  | "TRANSFER"
  | "EXPIRY_WRITE_OFF";

const TYPE_LABELS: Record<MovementType, string> = {
  IN: "Entrata (legacy)",
  OUT: "Uscita (legacy)",
  ADJUSTMENT: "Rettifica (legacy)",
  RECEIPT_FROM_PRODUCER: "Ingresso da produttore",
  TRANSFER: "Trasferimento",
  EXPIRY_WRITE_OFF: "Scarto scadenza",
};

type ProformaQueueRow = {
  id: string;
  status: "pending" | "processing" | "success" | "failed";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
};

type MovementRow = {
  id: string;
  type: string;
  ficProformaId: number | null;
  ficProformaNumber: string | null;
};

function ProformaCell({
  movement,
  queueRow,
  onRetry,
  retrying,
}: {
  movement: MovementRow;
  queueRow: ProformaQueueRow | null;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  // Solo TRANSFER possono avere proforma
  if (movement.type !== "TRANSFER") {
    return <span className="text-muted-foreground">—</span>;
  }
  // Proforma generata con successo (in stockMovements)
  if (movement.ficProformaNumber) {
    return (
      <Badge className="text-xs bg-green-600 hover:bg-green-700">
        <CheckCircle2 className="h-3 w-3 mr-1" />
        OK #{movement.ficProformaNumber}
      </Badge>
    );
  }
  // In coda: pending o failed
  if (queueRow) {
    const maxed = queueRow.attempts >= queueRow.maxAttempts;
    if (queueRow.status === "success") {
      // Edge case: queue success ma stockMovement non ha number
      return (
        <Badge className="text-xs bg-green-600 hover:bg-green-700">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          OK
        </Badge>
      );
    }
    if (queueRow.status === "pending" && queueRow.attempts === 0) {
      return (
        <div className="flex items-center gap-1">
          <Badge className="text-xs bg-yellow-500 hover:bg-yellow-600">
            <Clock className="h-3 w-3 mr-1" />
            In coda
          </Badge>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => onRetry(queueRow.id)}
            disabled={retrying}
            title="Riprova ora"
          >
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
        </div>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1">
            <Badge variant="destructive" className="text-xs">
              <AlertCircle className="h-3 w-3 mr-1" />
              {maxed ? "Max retry" : "Errore"} ({queueRow.attempts}/{queueRow.maxAttempts})
            </Badge>
            {!maxed && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => onRetry(queueRow.id)}
                disabled={retrying}
                title="Riprova ora"
              >
                {retrying ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </Button>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-md">
          {queueRow.lastError ?? "errore sconosciuto"}
        </TooltipContent>
      </Tooltip>
    );
  }
  // TRANSFER senza proforma (utente non ha generato)
  return <span className="text-muted-foreground">—</span>;
}

function MovementBadge({ type }: { type: string }) {
  switch (type) {
    case "TRANSFER":
      return (
        <Badge className="text-xs bg-blue-500 hover:bg-blue-600">
          <Truck className="h-3 w-3 mr-1" />
          Trasferimento
        </Badge>
      );
    case "EXPIRY_WRITE_OFF":
      return (
        <Badge variant="destructive" className="text-xs">
          <XCircle className="h-3 w-3 mr-1" />
          Scarto
        </Badge>
      );
    case "RECEIPT_FROM_PRODUCER":
      return (
        <Badge className="text-xs bg-green-600 hover:bg-green-700">
          <ArrowDown className="h-3 w-3 mr-1" />
          Ingresso
        </Badge>
      );
    case "IN":
      return (
        <Badge variant="secondary" className="text-xs">
          <ArrowDown className="h-3 w-3 mr-1" />
          Entrata
        </Badge>
      );
    case "OUT":
      return (
        <Badge variant="secondary" className="text-xs">
          <ArrowUp className="h-3 w-3 mr-1" />
          Uscita
        </Badge>
      );
    case "ADJUSTMENT":
      return (
        <Badge variant="secondary" className="text-xs">
          <RefreshCw className="h-3 w-3 mr-1" />
          Rettifica
        </Badge>
      );
    default:
      return <Badge variant="outline">{type}</Badge>;
  }
}

export default function Movements() {
  const [, setLocation] = useLocation();
  const [sort, setSort] = useState<SortConfig>(null);

  // ============== Filters state ==============
  const [filterType, setFilterType] = useState<string>(ALL_TYPES_VALUE);
  const [filterLocation, setFilterLocation] = useState<string>(
    ALL_LOCATIONS_VALUE,
  );
  const [batchSearch, setBatchSearch] = useState("");
  const [debouncedBatchSearch, setDebouncedBatchSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);

  // Debounce batch search 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedBatchSearch(batchSearch), 300);
    return () => clearTimeout(t);
  }, [batchSearch]);

  // Reset page se cambia un filtro
  useEffect(() => {
    setPage(1);
  }, [filterType, filterLocation, debouncedBatchSearch, startDate, endDate]);

  const { data: locations } = trpc.locations.list.useQuery();

  const queryInput = useMemo(
    () => ({
      type:
        filterType !== ALL_TYPES_VALUE ? (filterType as MovementType) : undefined,
      locationId:
        filterLocation !== ALL_LOCATIONS_VALUE ? filterLocation : undefined,
      batchSearch: debouncedBatchSearch || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [
      filterType,
      filterLocation,
      debouncedBatchSearch,
      startDate,
      endDate,
      page,
    ],
  );

  const { data, isLoading, isFetching } = trpc.stockMovements.listAll.useQuery(
    queryInput,
  );

  // M3: queue proforma per badge "in coda" / "errore" sui movimenti TRANSFER
  const utils = trpc.useUtils();
  const { data: queueRows } = trpc.proformaQueue.list.useQuery();
  const queueByMovement = useMemo(() => {
    const m = new Map<string, NonNullable<typeof queueRows>[number]>();
    for (const q of queueRows ?? []) {
      // Tieni solo l'ultima per movement (in caso di duplicati legacy)
      if (!m.has(q.transferMovementId)) m.set(q.transferMovementId, q);
    }
    return m;
  }, [queueRows]);

  const retryMut = trpc.proformaQueue.retry.useMutation({
    onSuccess: async (res) => {
      await utils.stockMovements.listAll.invalidate();
      await utils.proformaQueue.list.invalidate();
      const { toast } = await import("sonner");
      toast.success(`Proforma #${res.proformaNumber} generata`);
    },
    onError: async (err) => {
      await utils.proformaQueue.list.invalidate();
      const { toast } = await import("sonner");
      toast.error(err.message);
    },
  });

  const rawItems = data?.items ?? [];
  const items = useMemo(
    () =>
      sort
        ? sortData(rawItems, sort, (item, key) => {
            switch (key) {
              case "timestamp": return item.timestamp ? new Date(item.timestamp) : null;
              case "type": return item.type;
              case "batchNumber": return item.batchNumber ?? "";
              case "productName": return item.productName ?? "";
              case "quantity": return item.quantity;
              case "fromTo": return `${item.fromLocationName ?? ""} ${item.toLocationName ?? ""}`;
              default: return null;
            }
          })
        : rawItems,
    [rawItems, sort],
  );
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetFilters = () => {
    setFilterType(ALL_TYPES_VALUE);
    setFilterLocation(ALL_LOCATIONS_VALUE);
    setBatchSearch("");
    setStartDate("");
    setEndDate("");
    setPage(1);
  };

  const hasActiveFilters =
    filterType !== ALL_TYPES_VALUE ||
    filterLocation !== ALL_LOCATIONS_VALUE ||
    batchSearch !== "" ||
    startDate !== "" ||
    endDate !== "";

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">Movimenti</h1>
          <p className="text-muted-foreground">
            Storico globale movimenti di magazzino. Filtri per tipo, location,
            lotto, intervallo date.
          </p>
        </div>

        {/* Filtri */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="text-base">Filtri</CardTitle>
              {hasActiveFilters && (
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Reset filtri
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="filterType" className="text-xs">
                  Tipo movimento
                </Label>
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger id="filterType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_TYPES_VALUE}>Tutti</SelectItem>
                    <SelectItem value="TRANSFER">Trasferimento</SelectItem>
                    <SelectItem value="EXPIRY_WRITE_OFF">
                      Scarto scadenza
                    </SelectItem>
                    <SelectItem value="RECEIPT_FROM_PRODUCER">
                      Ingresso da produttore
                    </SelectItem>
                    <SelectItem value="IN">Entrata (legacy)</SelectItem>
                    <SelectItem value="OUT">Uscita (legacy)</SelectItem>
                    <SelectItem value="ADJUSTMENT">Rettifica (legacy)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="filterLocation" className="text-xs">
                  Location
                </Label>
                <Select
                  value={filterLocation}
                  onValueChange={setFilterLocation}
                >
                  <SelectTrigger id="filterLocation">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS_VALUE}>Tutte</SelectItem>
                    {locations?.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.type === "central_warehouse"
                          ? `🏢 ${l.name}`
                          : l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="batchSearch" className="text-xs">
                  Lotto (cerca)
                </Label>
                <Input
                  id="batchSearch"
                  placeholder="es. TEST-001"
                  value={batchSearch}
                  onChange={(e) => setBatchSearch(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="startDate" className="text-xs">
                  Da
                </Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="endDate" className="text-xs">
                  A
                </Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabella */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : items.length > 0 ? (
          <Card className="border-border bg-card">
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-base">
                  {total} movimenti trovati
                  {isFetching && (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground inline ml-2" />
                  )}
                </CardTitle>
                <CardDescription className="text-xs">
                  Ordinamento: timestamp DESC · {PAGE_SIZE} per pagina
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTableHead sortKey="timestamp" sort={sort} onSort={setSort}>Data/Ora</SortableTableHead>
                      <SortableTableHead sortKey="type" sort={sort} onSort={setSort}>Tipo</SortableTableHead>
                      <SortableTableHead sortKey="batchNumber" sort={sort} onSort={setSort}>Lotto</SortableTableHead>
                      <SortableTableHead sortKey="productName" sort={sort} onSort={setSort}>Prodotto</SortableTableHead>
                      <SortableTableHead sortKey="quantity" sort={sort} onSort={setSort} className="text-right">Qty</SortableTableHead>
                      <SortableTableHead sortKey="fromTo" sort={sort} onSort={setSort}>Da → A</SortableTableHead>
                      <TableHead>Note</TableHead>
                      <TableHead>Proforma</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((m) => {
                      const noteText = m.notes || m.notesInternal;
                      const noteTruncated =
                        noteText && noteText.length > 60
                          ? noteText.slice(0, 60) + "…"
                          : noteText;
                      return (
                        <TableRow key={m.id}>
                          <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                            {m.timestamp
                              ? format(
                                  new Date(m.timestamp),
                                  "dd/MM/yyyy HH:mm",
                                  { locale: it },
                                )
                              : "-"}
                          </TableCell>
                          <TableCell>
                            <MovementBadge type={m.type} />
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {m.batchNumber && m.productId ? (
                              <div>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setLocation(`/products/${m.productId}`)
                                  }
                                  className="hover:text-primary hover:underline"
                                  title={`${TYPE_LABELS[m.type as MovementType] ?? m.type}: vai al prodotto`}
                                >
                                  {m.batchNumber}
                                </button>
                                {m.expirationDate && (() => {
                                  const days = daysToExpiry(m.expirationDate);
                                  const cls = getExpiryColorClass(days);
                                  if (!cls) return null;
                                  return <span className={`block text-[10px] ${cls}`}>{getExpiryLabel(days)}</span>;
                                })()}
                              </div>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            {m.productName && m.productId ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setLocation(`/products/${m.productId}`)
                                }
                                className="hover:text-primary hover:underline text-left"
                              >
                                {m.productName}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {m.quantity}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              <span>{m.fromLocationName ?? "—"}</span>
                              <ArrowRight className="h-3 w-3 shrink-0" />
                              <span>{m.toLocationName ?? "—"}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm max-w-xs">
                            {noteTruncated ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="truncate cursor-help">
                                    {noteTruncated}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-md">
                                  {noteText}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            <ProformaCell
                              movement={m}
                              queueRow={queueByMovement.get(m.id) ?? null}
                              onRetry={(id) => retryMut.mutate({ id })}
                              retrying={retryMut.isPending}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <ArrowLeftRight className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Nessun movimento trovato
              </h3>
              <p className="text-muted-foreground text-center max-w-md">
                {hasActiveFilters
                  ? "I filtri applicati non corrispondono a nessun movimento. Prova a resettarli."
                  : "Non sono ancora stati registrati movimenti di magazzino."}
              </p>
              {hasActiveFilters && (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={resetFilters}
                >
                  Reset filtri
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Paginazione */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Pagina {page} di {totalPages} · {total} movimenti totali
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Precedente
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Successiva
              </Button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
