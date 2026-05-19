import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  Percent,
  TrendingUp,
  Truck,
  Wallet,
  Warehouse as WarehouseIcon,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";

type TransferTarget = {
  productId: string;
  productName: string;
  productUnit: string | null;
};

type WriteOffTarget = {
  batchId: string;
  locationId: string;
  batchNumber: string;
  productName: string;
  expirationDate: string | null;
  maxQuantity: number;
};

// ============== Currency formatter ==============
const formatCurrency = (value: number) =>
  new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

// ============== Sort types ==============
type SortField = "stock" | "costUnit" | "listUnit" | "valueCost" | "valueList" | "name";
type SortOrder = "asc" | "desc";

export default function Warehouse() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const { data: overview, isLoading } =
    trpc.warehouse.getStockOverview.useQuery();
  const { data: valueOverview } =
    trpc.warehouse.getValueOverview.useQuery();
  const { data: warehouseLoc } = trpc.locations.getCentralWarehouse.useQuery();
  const { data: retailers } = trpc.retailers.list.useQuery();
  const { data: ficStatus } = trpc.ficIntegration.getStatus.useQuery();
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  // ============== Sort state ==============
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    return sortOrder === "asc"
      ? <ArrowUp className="h-3 w-3 ml-1" />
      : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  // ============== Transfer state ==============
  const [transferTarget, setTransferTarget] = useState<TransferTarget | null>(
    null,
  );
  const [transferRetailerId, setTransferRetailerId] = useState<string>("");
  const [transferBatchId, setTransferBatchId] = useState<string>("");
  const [transferQty, setTransferQty] = useState("");
  const [transferNotes, setTransferNotes] = useState("");
  const [transferProforma, setTransferProforma] = useState(false);

  // M3: lookup retailer selezionato per pre-condizioni proforma
  const selectedRetailer = retailers?.find((r) => r.id === transferRetailerId);
  const proformaPreconditions = {
    ficConnected: !!ficStatus?.connected,
    hasPackage: !!selectedRetailer?.pricingPackageId,
    hasFicClient: !!selectedRetailer?.ficClientId,
  };
  const proformaAllowed =
    proformaPreconditions.ficConnected &&
    proformaPreconditions.hasPackage &&
    proformaPreconditions.hasFicClient;
  const proformaTooltip = !proformaPreconditions.ficConnected
    ? "Connetti Fatture in Cloud da /settings/integrations"
    : !proformaPreconditions.hasPackage
      ? "Assegna un pacchetto commerciale al rivenditore"
      : !proformaPreconditions.hasFicClient
        ? "Mappa il cliente FiC sul rivenditore"
        : "";

  // Preview pricing quando checkbox attivo + qty valida
  const transferQtyNum = parseInt(transferQty, 10);
  const previewEnabled =
    transferProforma &&
    proformaAllowed &&
    transferTarget != null &&
    Number.isFinite(transferQtyNum) &&
    transferQtyNum > 0;
  const { data: pricingPreview } = trpc.pricing.calculateForRetailer.useQuery(
    {
      retailerId: transferRetailerId,
      items:
        transferTarget && Number.isFinite(transferQtyNum) && transferQtyNum > 0
          ? [{ productId: transferTarget.productId, qty: transferQtyNum }]
          : [],
    },
    { enabled: previewEnabled, retry: false },
  );

  // Default checkbox to true se preconditions soddisfatte
  useEffect(() => {
    if (proformaAllowed) setTransferProforma(true);
    else setTransferProforma(false);
  }, [proformaAllowed]);

  const { data: suggestedBatches } =
    trpc.productBatches.suggestForTransfer.useQuery(
      {
        productId: transferTarget?.productId ?? "",
        retailerId: transferRetailerId,
      },
      {
        enabled:
          transferTarget !== null &&
          transferTarget.productId.length > 0 &&
          transferRetailerId.length > 0,
      },
    );

  // Quando i suggested batches cambiano, auto-seleziona il primo (FEFO)
  useEffect(() => {
    if (suggestedBatches && suggestedBatches.length > 0 && !transferBatchId) {
      setTransferBatchId(suggestedBatches[0].batchId);
    }
  }, [suggestedBatches, transferBatchId]);

  const transferMutation = trpc.stockMovements.transfer.useMutation({
    onSuccess: async (res) => {
      await utils.warehouse.getStockOverview.invalidate();
      await utils.warehouse.getValueOverview.invalidate();
      await utils.productBatches.listByProduct.invalidate();
      await utils.productBatches.suggestForTransfer.invalidate();
      await utils.retailers.getDetails.invalidate();
      await utils.stockMovements.listByRetailer.invalidate();
      await utils.stockMovements.listAll.invalidate();
      await utils.proformaQueue.list.invalidate();
      resetTransfer();
      const { toast } = await import("sonner");
      if (res.proforma?.queued) {
        toast.warning(
          `Trasferimento OK, proforma in coda — riprova manualmente da /movements (${res.proforma.lastError ?? "errore FiC"})`,
        );
      } else if (res.proforma?.number) {
        toast.success(`Trasferimento + proforma #${res.proforma.number} generata`);
      } else {
        toast.success("Trasferimento completato");
      }
    },
    onError: (err) =>
      import("sonner").then(({ toast }) => toast.error(err.message)),
  });

  const resetTransfer = () => {
    setTransferTarget(null);
    setTransferRetailerId("");
    setTransferBatchId("");
    setTransferQty("");
    setTransferNotes("");
    setTransferProforma(false);
  };

  const submitTransfer = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!transferTarget) return;
    const qty = parseInt(transferQty, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      import("sonner").then(({ toast }) =>
        toast.error("Quantità deve essere positiva"),
      );
      return;
    }
    if (!transferRetailerId) {
      import("sonner").then(({ toast }) => toast.error("Seleziona un rivenditore"));
      return;
    }
    if (!transferBatchId) {
      import("sonner").then(({ toast }) => toast.error("Seleziona un lotto"));
      return;
    }
    transferMutation.mutate({
      productId: transferTarget.productId,
      batchId: transferBatchId,
      retailerId: transferRetailerId,
      quantity: qty,
      notes: transferNotes || undefined,
      generateProforma: transferProforma && proformaAllowed,
    });
  };

  // ============== Write-off state ==============
  const [writeOffTarget, setWriteOffTarget] = useState<WriteOffTarget | null>(
    null,
  );
  const [writeOffQty, setWriteOffQty] = useState("");
  const [writeOffNotes, setWriteOffNotes] = useState("");

  const writeOffMutation = trpc.stockMovements.expiryWriteOff.useMutation({
    onSuccess: async () => {
      await utils.warehouse.getStockOverview.invalidate();
      await utils.warehouse.getValueOverview.invalidate();
      await utils.productBatches.listByProduct.invalidate();
      setWriteOffTarget(null);
      setWriteOffQty("");
      setWriteOffNotes("");
      import("sonner").then(({ toast }) => toast.success("Lotto scartato"));
    },
    onError: (err) =>
      import("sonner").then(({ toast }) => toast.error(err.message)),
  });

  const submitWriteOff = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!writeOffTarget) return;
    const qty = parseInt(writeOffQty, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      import("sonner").then(({ toast }) =>
        toast.error("Quantità deve essere positiva"),
      );
      return;
    }
    if (qty > writeOffTarget.maxQuantity) {
      import("sonner").then(({ toast }) =>
        toast.error(`Quantità massima: ${writeOffTarget.maxQuantity}`),
      );
      return;
    }
    writeOffMutation.mutate({
      batchId: writeOffTarget.batchId,
      locationId: writeOffTarget.locationId,
      quantity: qty,
      notes: writeOffNotes || undefined,
    });
  };

  // ============== Computed ==============
  const now = Date.now();

  const formatDate = (d: string | null) =>
    d ? format(new Date(d), "dd/MM/yyyy") : "-";

  const expirationBadge = (expirationDate: string | null, qty: number) => {
    if (!expirationDate || qty <= 0) return null;
    const days = Math.floor(
      (new Date(expirationDate).getTime() - now) / 86_400_000,
    );
    if (days <= 0) {
      return (
        <Badge variant="destructive" className="text-xs">
          Scaduto
        </Badge>
      );
    }
    if (days <= 30) {
      return (
        <Badge className="text-xs bg-orange-500 hover:bg-orange-600">
          {days}gg
        </Badge>
      );
    }
    return null;
  };

  // Lotto eligibile per Scarta: se scadenza imminente (< 7gg) o già scaduto
  const isEligibleForWriteOff = (expirationDate: string, qty: number) => {
    if (qty <= 0) return false;
    const days = Math.floor(
      (new Date(expirationDate).getTime() - now) / 86_400_000,
    );
    return days <= 7;
  };

  // ============== Enriched & sorted overview ==============
  const enrichedOverview = useMemo(() => {
    if (!overview) return [];
    return overview.map((p) => {
      const costUnit = parseFloat(p.productCostPrice || "0");
      const ppu = p.piecesPerUnit ?? 1;
      const listConf = parseFloat(p.productUnitPrice || "0");
      const pricePerPiece = ppu > 0 ? listConf / ppu : 0;
      const valueCost = p.totalStock * costUnit;
      const valueList = p.totalStock * pricePerPiece;
      const marginPercent = pricePerPiece > 0 ? ((pricePerPiece - costUnit) / pricePerPiece) * 100 : 0;
      return { ...p, costUnit, ppu, listConf, pricePerPiece, valueCost, valueList, marginPercent };
    });
  }, [overview]);

  const sortedOverview = useMemo(() => {
    const arr = [...enrichedOverview];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name": cmp = a.productName.localeCompare(b.productName); break;
        case "stock": cmp = a.totalStock - b.totalStock; break;
        case "costUnit": cmp = a.costUnit - b.costUnit; break;
        case "listUnit": cmp = a.listConf - b.listConf; break;
        case "valueCost": cmp = a.valueCost - b.valueCost; break;
        case "valueList": cmp = a.valueList - b.valueList; break;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [enrichedOverview, sortField, sortOrder]);

  // Totals for footer
  const totals = useMemo(() => {
    let totalUnits = 0;
    let totalValueCost = 0;
    let totalValueList = 0;
    for (const p of enrichedOverview) {
      totalUnits += p.totalStock;
      totalValueCost += p.valueCost;
      totalValueList += p.valueList;
    }
    const totalMargin = totalValueList - totalValueCost;
    const totalMarginPercent = totalValueList > 0 ? (totalMargin / totalValueList) * 100 : 0;
    return { totalUnits, totalValueCost, totalValueList, totalMargin, totalMarginPercent };
  }, [enrichedOverview]);

  // Margin badge color
  const marginBadge = (pct: number) => {
    if (pct >= 40) return <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs">{pct.toFixed(1)}%</Badge>;
    if (pct >= 20) return <Badge className="bg-blue-600 hover:bg-blue-700 text-white text-xs">{pct.toFixed(1)}%</Badge>;
    if (pct > 0) return <Badge className="bg-orange-500 hover:bg-orange-600 text-white text-xs">{pct.toFixed(1)}%</Badge>;
    return <Badge variant="secondary" className="text-xs">{pct.toFixed(1)}%</Badge>;
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">
            Magazzino Centrale
          </h1>
          <p className="text-muted-foreground">
            Stock SoKeto E-Keto Food per prodotto e lotto. Click su una riga per
            vedere il dettaglio dei lotti, oppure usa il bottone Trasferisci per
            inviare stock a un rivenditore.
          </p>
        </div>

        {/* M8.2: Value stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs">Valore al costo</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-emerald-500 shrink-0" />
                <span className="text-lg font-bold text-foreground truncate">
                  {valueOverview ? formatCurrency(valueOverview.totalValueAtCost) : "—"}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs">Valore al listino</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="text-lg font-bold text-foreground truncate">
                  {valueOverview ? formatCurrency(valueOverview.totalValueAtListPrice) : "—"}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs">Margine potenziale</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Percent className="h-4 w-4 text-orange-500 shrink-0" />
                <div className="min-w-0">
                  <span className="text-lg font-bold text-foreground truncate block">
                    {valueOverview ? formatCurrency(valueOverview.potentialMargin) : "—"}
                  </span>
                  {valueOverview && (
                    <span className="text-xs text-muted-foreground">
                      {valueOverview.potentialMarginPercent.toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs">Pezzi totali</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <span className="text-lg font-bold text-foreground truncate block">
                    {valueOverview ? valueOverview.totalUnits.toLocaleString("it-IT") : "—"}
                  </span>
                  {valueOverview && (
                    <span className="text-xs text-muted-foreground">
                      {valueOverview.uniqueProductsCount} SKU, {valueOverview.activeBatchesCount} lotti
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className={`border-border bg-card ${valueOverview && valueOverview.expiringSoonValue > 0 ? "ring-1 ring-red-500/30" : ""}`}>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs">In scadenza &lt; 30gg</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <AlertTriangle className={`h-4 w-4 shrink-0 ${valueOverview && valueOverview.expiringSoonValue > 0 ? "text-red-500" : "text-muted-foreground"}`} />
                <div className="min-w-0">
                  <span className="text-lg font-bold text-foreground truncate block">
                    {valueOverview ? formatCurrency(valueOverview.expiringSoonValue) : "—"}
                  </span>
                  {valueOverview && (
                    <span className="text-xs text-muted-foreground">
                      {valueOverview.expiringSoonUnits} pezzi
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabella prodotti con colonne valore */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : sortedOverview.length > 0 ? (
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>Prodotti a magazzino</CardTitle>
              <CardDescription>
                Stock totale, valore e lotti per ogni prodotto presente in magazzino centrale
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>
                      <button type="button" className="flex items-center hover:text-foreground transition-colors" onClick={() => handleSort("name")}>
                        Prodotto <SortIcon field="name" />
                      </button>
                    </TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">
                      <button type="button" className="flex items-center justify-end hover:text-foreground transition-colors ml-auto" onClick={() => handleSort("stock")}>
                        Stock <SortIcon field="stock" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button type="button" className="flex items-center justify-end hover:text-foreground transition-colors ml-auto" onClick={() => handleSort("costUnit")}>
                        Costo singolo <SortIcon field="costUnit" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button type="button" className="flex items-center justify-end hover:text-foreground transition-colors ml-auto" onClick={() => handleSort("listUnit")}>
                        Prezzo conf. <SortIcon field="listUnit" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button type="button" className="flex items-center justify-end hover:text-foreground transition-colors ml-auto" onClick={() => handleSort("valueCost")}>
                        Val. costo <SortIcon field="valueCost" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button type="button" className="flex items-center justify-end hover:text-foreground transition-colors ml-auto" onClick={() => handleSort("valueList")}>
                        Val. listino <SortIcon field="valueList" />
                      </button>
                    </TableHead>
                    <TableHead className="text-center">Margine</TableHead>
                    <TableHead>Scadenza</TableHead>
                    <TableHead className="w-28 text-right">Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedOverview.map((p) => {
                    const isExpanded = expandedProductId === p.productId;
                    const nearestDays = p.nearestExpiration
                      ? Math.floor(
                          (new Date(p.nearestExpiration).getTime() - now) /
                            86_400_000,
                        )
                      : null;
                    const nearestColor =
                      nearestDays === null
                        ? "text-muted-foreground"
                        : nearestDays <= 0
                          ? "text-destructive font-semibold"
                          : nearestDays <= 30
                            ? "text-orange-500 font-semibold"
                            : "text-foreground";
                    const rowHighlight = p.hasExpiringSoon ? "bg-amber-50/60 dark:bg-amber-950/20" : "";
                    return (
                      <>
                        <TableRow
                          key={p.productId}
                          className={`hover:bg-accent/50 ${rowHighlight}`}
                        >
                          <TableCell
                            className="cursor-pointer"
                            onClick={() =>
                              setExpandedProductId(
                                isExpanded ? null : p.productId,
                              )
                            }
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            <button
                              type="button"
                              onClick={() =>
                                setLocation(`/products/${p.productId}`)
                              }
                              className="text-left hover:text-primary transition-colors"
                            >
                              {p.productName}
                            </button>
                            {p.hasExpiringSoon && (
                              <AlertTriangle className="h-3 w-3 text-amber-500 inline ml-1.5" />
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {p.productSku}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {p.totalStock}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {formatCurrency(p.costUnit)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {formatCurrency(p.listConf)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatCurrency(p.valueCost)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatCurrency(p.valueList)}
                          </TableCell>
                          <TableCell className="text-center">
                            {marginBadge(p.marginPercent)}
                          </TableCell>
                          <TableCell className={nearestColor}>
                            {formatDate(p.nearestExpiration)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={p.totalStock <= 0}
                              onClick={() =>
                                setTransferTarget({
                                  productId: p.productId,
                                  productName: p.productName,
                                  productUnit: p.productUnit,
                                })
                              }
                            >
                              <Truck className="h-3 w-3 mr-1" />
                              Trasferisci
                            </Button>
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow key={`${p.productId}-detail`}>
                            <TableCell></TableCell>
                            <TableCell colSpan={10} className="bg-accent/20 py-4">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Batch</TableHead>
                                    <TableHead>Produttore</TableHead>
                                    <TableHead>Scadenza</TableHead>
                                    <TableHead className="text-right">Qty iniziale</TableHead>
                                    <TableHead className="text-right">Stock residuo</TableHead>
                                    <TableHead className="w-10"></TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {p.batches.map((b) => (
                                    <TableRow key={b.batchId}>
                                      <TableCell className="font-mono text-xs">
                                        {b.batchNumber}
                                      </TableCell>
                                      <TableCell className="text-muted-foreground">
                                        {b.producerName ?? "-"}
                                      </TableCell>
                                      <TableCell>
                                        <div className="flex items-center gap-2">
                                          <span>{formatDate(b.expirationDate)}</span>
                                          {expirationBadge(
                                            b.expirationDate,
                                            b.quantity,
                                          )}
                                        </div>
                                      </TableCell>
                                      <TableCell className="text-right text-muted-foreground">
                                        {b.initialQuantity}
                                      </TableCell>
                                      <TableCell className="text-right font-semibold">
                                        {b.quantity}
                                      </TableCell>
                                      <TableCell>
                                        {warehouseLoc &&
                                          isEligibleForWriteOff(
                                            b.expirationDate,
                                            b.quantity,
                                          ) && (
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  variant="ghost"
                                                  size="icon"
                                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                  aria-label="Scarta lotto"
                                                  onClick={() =>
                                                    setWriteOffTarget({
                                                      batchId: b.batchId,
                                                      locationId: warehouseLoc.id,
                                                      batchNumber: b.batchNumber,
                                                      productName: p.productName,
                                                      expirationDate: b.expirationDate,
                                                      maxQuantity: b.quantity,
                                                    })
                                                  }
                                                >
                                                  <XCircle className="h-4 w-4" />
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>
                                                Scarta (scadenza imminente o passata)
                                              </TooltipContent>
                                            </Tooltip>
                                          )}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow className="bg-muted/50 font-semibold">
                    <TableCell></TableCell>
                    <TableCell colSpan={2}>TOTALE</TableCell>
                    <TableCell className="text-right tabular-nums">{totals.totalUnits}</TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(totals.totalValueCost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(totals.totalValueList)}</TableCell>
                    <TableCell className="text-center">{marginBadge(totals.totalMarginPercent)}</TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <WarehouseIcon className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Magazzino centrale vuoto
              </h3>
              <p className="text-muted-foreground text-center max-w-md">
                Nessuno stock presente. Per registrare un ingresso vai nella
                pagina di un prodotto e clicca su <strong>+ Aggiungi lotto</strong>.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ====================== Dialog TRANSFER ====================== */}
      <Dialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (!open) resetTransfer();
        }}
      >
        <DialogContent className="max-w-lg">
          <form onSubmit={submitTransfer}>
            <DialogHeader>
              <DialogTitle>Trasferisci a rivenditore</DialogTitle>
              <DialogDescription>
                Sposta stock di <strong>{transferTarget?.productName}</strong> dal
                magazzino centrale a un rivenditore. Lotti suggeriti per scadenza
                (FEFO).
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="transferRetailer">Rivenditore *</Label>
                <Select
                  value={transferRetailerId}
                  onValueChange={(v) => {
                    setTransferRetailerId(v);
                    setTransferBatchId("");
                  }}
                >
                  <SelectTrigger id="transferRetailer">
                    <SelectValue placeholder="Seleziona rivenditore" />
                  </SelectTrigger>
                  <SelectContent>
                    {retailers?.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                        {r.city ? ` — ${r.city}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="transferBatch">
                  Lotto * (suggerito FEFO: scadenza più vicina)
                </Label>
                <Select
                  value={transferBatchId}
                  onValueChange={setTransferBatchId}
                  disabled={!transferRetailerId || !suggestedBatches}
                >
                  <SelectTrigger id="transferBatch">
                    <SelectValue
                      placeholder={
                        !transferRetailerId
                          ? "Seleziona prima un rivenditore"
                          : suggestedBatches && suggestedBatches.length === 0
                            ? "Nessun lotto disponibile"
                            : "Seleziona lotto"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {suggestedBatches?.map((b) => {
                      const days = Math.floor(
                        (new Date(b.expirationDate).getTime() - now) /
                          86_400_000,
                      );
                      const expLabel =
                        days <= 0
                          ? `SCADUTO ${format(new Date(b.expirationDate), "dd/MM/yyyy")}`
                          : days <= 30
                            ? `${format(new Date(b.expirationDate), "dd/MM/yyyy")} (${days}gg)`
                            : format(new Date(b.expirationDate), "dd/MM/yyyy");
                      return (
                        <SelectItem key={b.batchId} value={b.batchId}>
                          {b.batchNumber} · {expLabel} · stock {b.centralStock}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {suggestedBatches && suggestedBatches.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Nessun lotto del prodotto ha stock al magazzino centrale.
                    Aggiungine uno da <strong>/products/...</strong> →{" "}
                    <em>+ Aggiungi lotto</em>.
                  </p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="transferQty">
                  Quantità *
                  {transferBatchId && suggestedBatches && (
                    <span className="text-xs text-muted-foreground ml-2">
                      (max{" "}
                      {suggestedBatches.find((b) => b.batchId === transferBatchId)
                        ?.centralStock ?? 0}
                      )
                    </span>
                  )}
                </Label>
                <Input
                  id="transferQty"
                  type="number"
                  min={1}
                  value={transferQty}
                  onChange={(e) => setTransferQty(e.target.value)}
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="transferNotes">Note</Label>
                <Textarea
                  id="transferNotes"
                  rows={2}
                  placeholder="Riferimento DDT consegna, note interne…"
                  value={transferNotes}
                  onChange={(e) => setTransferNotes(e.target.value)}
                />
              </div>

              {/* M3: Genera proforma su FiC */}
              {proformaAllowed ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={transferProforma}
                    onCheckedChange={(v) => setTransferProforma(v === true)}
                  />
                  <span className="text-sm">Genera proforma su Fatture in Cloud</span>
                </label>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label className="flex items-center gap-2 opacity-50 cursor-not-allowed">
                      <Checkbox checked={false} disabled />
                      <span className="text-sm">
                        Genera proforma su Fatture in Cloud
                      </span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent>{proformaTooltip}</TooltipContent>
                </Tooltip>
              )}

              {/* Preview prezzi quando checkbox attivo */}
              {previewEnabled && pricingPreview && (
                <div className="rounded-md border border-border bg-muted/40 p-3 text-sm space-y-2">
                  <div className="font-medium text-foreground">
                    Anteprima proforma — pacchetto {pricingPreview.packageName} (-{
                      pricingPreview.packageDiscount
                    }%)
                  </div>
                  {pricingPreview.items.map((it) => (
                    <div
                      key={it.productId}
                      className="flex items-center justify-between text-xs"
                    >
                      <span>
                        {it.productName} ×{it.qty}
                      </span>
                      <span className="font-mono">
                        €{it.unitPriceFinal} → €{it.lineTotalNet} (IVA {parseFloat(
                          it.vatRate,
                        ).toFixed(0)}%)
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-2 border-t border-border text-xs">
                    <span className="text-muted-foreground">Totale netto</span>
                    <span className="font-mono">€{pricingPreview.subtotalNet}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">IVA</span>
                    <span className="font-mono">€{pricingPreview.vatAmount}</span>
                  </div>
                  <div className="flex items-center justify-between font-medium">
                    <span>Totale lordo</span>
                    <span className="font-mono">€{pricingPreview.total}</span>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={resetTransfer}>
                Annulla
              </Button>
              <Button
                type="submit"
                disabled={transferMutation.isPending || !transferBatchId}
              >
                {transferMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Trasferisci
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ====================== Dialog WRITE-OFF ====================== */}
      <Dialog
        open={writeOffTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWriteOffTarget(null);
            setWriteOffQty("");
            setWriteOffNotes("");
          }
        }}
      >
        <DialogContent>
          <form onSubmit={submitWriteOff}>
            <DialogHeader>
              <DialogTitle>Scarta lotto</DialogTitle>
              <DialogDescription>
                Scarto del lotto{" "}
                <strong className="font-mono">
                  {writeOffTarget?.batchNumber}
                </strong>{" "}
                ({writeOffTarget?.productName}, scad{" "}
                {writeOffTarget?.expirationDate
                  ? format(
                      new Date(writeOffTarget.expirationDate),
                      "dd/MM/yyyy",
                    )
                  : "?"}
                ). Verrà registrato un movimento <strong>EXPIRY_WRITE_OFF</strong>{" "}
                e lo stock decrementato di conseguenza.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="writeOffQty">
                  Quantità da scartare (max {writeOffTarget?.maxQuantity ?? 0})
                </Label>
                <Input
                  id="writeOffQty"
                  type="number"
                  min={1}
                  max={writeOffTarget?.maxQuantity ?? 1}
                  value={writeOffQty}
                  onChange={(e) => setWriteOffQty(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="writeOffNotes">Note (opzionale)</Label>
                <Textarea
                  id="writeOffNotes"
                  rows={2}
                  placeholder="Es. Scaduto, contaminazione, errore conservazione"
                  value={writeOffNotes}
                  onChange={(e) => setWriteOffNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setWriteOffTarget(null)}
              >
                Annulla
              </Button>
              <Button
                type="submit"
                disabled={writeOffMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {writeOffMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Scarta
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
