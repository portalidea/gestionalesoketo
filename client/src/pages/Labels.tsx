/**
 * M12: Gestione inventario etichette per prodotto.
 * Pool unico cross-company — mostra tutti i prodotti con labelStock, threshold, status.
 * Azioni: Carica etichette (LOAD), Rettifica (ADJUSTMENT), Modifica soglia, Storico.
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tag, Plus, Settings, History, AlertTriangle, Search, Filter } from "lucide-react";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";

type LabelProduct = {
  productId: string;
  name: string;
  sku: string;
  labelStock: number;
  labelReorderThreshold: number;
  status: "normal" | "low" | "critical";
};

export default function Labels() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const { data: overview, isLoading } = trpc.labels.getOverview.useQuery();
  const { data: alertCount } = trpc.labels.getAlertCount.useQuery();

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "under_threshold">("all");
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [thresholdDialogOpen, setThresholdDialogOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<LabelProduct | null>(null);
  const [loadQty, setLoadQty] = useState("");
  const [loadNotes, setLoadNotes] = useState("");
  const [loadType, setLoadType] = useState<"LOAD" | "ADJUSTMENT">("LOAD");
  const [thresholdValue, setThresholdValue] = useState("");

  const updateStock = trpc.labels.updateStock.useMutation({
    onSuccess: (data) => {
      toast.success(`Etichette aggiornate: ${data.previousStock} → ${data.newStock}`);
      utils.labels.getOverview.invalidate();
      utils.labels.getAlertCount.invalidate();
      setLoadDialogOpen(false);
      setLoadQty("");
      setLoadNotes("");
    },
    onError: (err) => toast.error(err.message),
  });

  const updateThreshold = trpc.labels.updateThreshold.useMutation({
    onSuccess: () => {
      toast.success("Soglia aggiornata");
      utils.labels.getOverview.invalidate();
      utils.labels.getAlertCount.invalidate();
      setThresholdDialogOpen(false);
    },
    onError: (err) => toast.error(err.message),
  });

  // URL params filter
  const urlParams = new URLSearchParams(window.location.search);
  const initialFilter = urlParams.get("filter") === "under_threshold" ? "under_threshold" : "all";
  useState(() => {
    if (initialFilter === "under_threshold") setFilterStatus("under_threshold");
  });

  const filteredProducts = useMemo(() => {
    if (!overview) return [];
    let list = overview;
    if (filterStatus === "under_threshold") {
      list = list.filter((p) => p.status === "low" || p.status === "critical");
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    return list;
  }, [overview, filterStatus, search]);

  const handleOpenLoad = (product: LabelProduct) => {
    setSelectedProduct(product);
    setLoadType("LOAD");
    setLoadQty("");
    setLoadNotes("");
    setLoadDialogOpen(true);
  };

  const handleOpenThreshold = (product: LabelProduct) => {
    setSelectedProduct(product);
    setThresholdValue(String(product.labelReorderThreshold));
    setThresholdDialogOpen(true);
  };

  const handleOpenHistory = (product: LabelProduct) => {
    setSelectedProduct(product);
    setHistoryDialogOpen(true);
  };

  const handleSubmitLoad = () => {
    if (!selectedProduct || !loadQty) return;
    const delta = parseInt(loadQty);
    if (isNaN(delta) || delta === 0) {
      toast.error("Quantità non valida");
      return;
    }
    updateStock.mutate({
      productId: selectedProduct.productId,
      delta,
      type: loadType,
      notes: loadNotes || undefined,
    });
  };

  const handleSubmitThreshold = () => {
    if (!selectedProduct || !thresholdValue) return;
    const t = parseInt(thresholdValue);
    if (isNaN(t) || t < 0) {
      toast.error("Soglia non valida");
      return;
    }
    updateThreshold.mutate({ productId: selectedProduct.productId, threshold: t });
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case "critical":
        return <Badge variant="destructive">Critico</Badge>;
      case "low":
        return <Badge className="bg-amber-500/20 text-amber-700 border-amber-300">Basso</Badge>;
      default:
        return <Badge variant="secondary">OK</Badge>;
    }
  };

  return (
    <DashboardLayout>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Tag className="h-6 w-6" /> Gestione Etichette
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pool unico cross-company — inventario etichette per prodotto
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Prodotti totali</CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold">{overview?.length ?? "—"}</span>
          </CardContent>
        </Card>
        <Card className={alertCount && alertCount.totalAlerts > 0 ? "ring-1 ring-amber-500/30" : ""}>
          <CardHeader className="pb-2">
            <CardDescription>Sotto soglia</CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-amber-600">
              {alertCount?.totalAlerts ?? "—"}
            </span>
          </CardContent>
        </Card>
        <Card className={alertCount && alertCount.criticalCount > 0 ? "ring-1 ring-red-500/30" : ""}>
          <CardHeader className="pb-2">
            <CardDescription>Critici</CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-red-600">
              {alertCount?.criticalCount ?? "—"}
            </span>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cerca prodotto o SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as any)}>
          <SelectTrigger className="w-[180px]">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i prodotti</SelectItem>
            <SelectItem value="under_threshold">Solo sotto soglia</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Products Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Caricamento...</div>
          ) : filteredProducts.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {search || filterStatus !== "all" ? "Nessun prodotto trovato con i filtri attivi" : "Nessun prodotto"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Prodotto</th>
                    <th className="text-left p-3 font-medium">SKU</th>
                    <th className="text-right p-3 font-medium">Stock etichette</th>
                    <th className="text-right p-3 font-medium">Soglia</th>
                    <th className="text-center p-3 font-medium">Status</th>
                    <th className="text-right p-3 font-medium">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((p) => (
                    <tr key={p.productId} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="p-3 font-medium">{p.name}</td>
                      <td className="p-3 text-muted-foreground">{p.sku}</td>
                      <td className="p-3 text-right font-mono">{p.labelStock.toLocaleString("it-IT")}</td>
                      <td className="p-3 text-right text-muted-foreground">{p.labelReorderThreshold.toLocaleString("it-IT")}</td>
                      <td className="p-3 text-center">{statusBadge(p.status)}</td>
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => handleOpenLoad(p)} title="Carica etichette">
                            <Plus className="h-4 w-4" />
                          </Button>
                          {isAdmin && (
                            <Button variant="ghost" size="sm" onClick={() => handleOpenThreshold(p)} title="Modifica soglia">
                              <Settings className="h-4 w-4" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => handleOpenHistory(p)} title="Storico">
                            <History className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Load/Adjustment Dialog */}
      <Dialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {loadType === "LOAD" ? "Carica etichette" : "Rettifica etichette"}
            </DialogTitle>
            <DialogDescription>
              {selectedProduct?.name} — Stock attuale: {selectedProduct?.labelStock}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Tipo operazione</Label>
              <Select value={loadType} onValueChange={(v) => setLoadType(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOAD">Carico (aggiunta)</SelectItem>
                  {isAdmin && <SelectItem value="ADJUSTMENT">Rettifica (+/-)</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Quantità {loadType === "LOAD" ? "(positiva)" : "(positiva o negativa)"}</Label>
              <Input
                type="number"
                value={loadQty}
                onChange={(e) => setLoadQty(e.target.value)}
                placeholder={loadType === "LOAD" ? "es. 500" : "es. -20 o +50"}
              />
            </div>
            <div>
              <Label>Note (opzionale)</Label>
              <Textarea
                value={loadNotes}
                onChange={(e) => setLoadNotes(e.target.value)}
                placeholder="es. Ordine tipografia #1234"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoadDialogOpen(false)}>Annulla</Button>
            <Button onClick={handleSubmitLoad} disabled={updateStock.isPending || !loadQty}>
              {updateStock.isPending ? "Salvataggio..." : "Conferma"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Threshold Dialog */}
      <Dialog open={thresholdDialogOpen} onOpenChange={setThresholdDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifica soglia riordino</DialogTitle>
            <DialogDescription>
              {selectedProduct?.name} — Soglia attuale: {selectedProduct?.labelReorderThreshold}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label>Nuova soglia</Label>
            <Input
              type="number"
              min={0}
              value={thresholdValue}
              onChange={(e) => setThresholdValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setThresholdDialogOpen(false)}>Annulla</Button>
            <Button onClick={handleSubmitThreshold} disabled={updateThreshold.isPending}>
              {updateThreshold.isPending ? "Salvataggio..." : "Salva"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={historyDialogOpen} onOpenChange={setHistoryDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Storico movimenti etichette</DialogTitle>
            <DialogDescription>{selectedProduct?.name}</DialogDescription>
          </DialogHeader>
          {selectedProduct && <LabelHistoryTable productId={selectedProduct.productId} />}
        </DialogContent>
      </Dialog>
    </div>
    </DashboardLayout>
  );
}

function LabelHistoryTable({ productId }: { productId: string }) {
  const { data: history, isLoading } = trpc.labels.getHistory.useQuery({ productId, limit: 100 });

  if (isLoading) return <div className="p-4 text-center text-muted-foreground">Caricamento...</div>;
  if (!history || history.length === 0) return <div className="p-4 text-center text-muted-foreground">Nessun movimento registrato</div>;

  const typeLabel = (type: string) => {
    switch (type) {
      case "LOAD": return <Badge className="bg-emerald-500/20 text-emerald-700 border-emerald-300">Carico</Badge>;
      case "CONSUMPTION": return <Badge className="bg-blue-500/20 text-blue-700 border-blue-300">Consumo</Badge>;
      case "ADJUSTMENT": return <Badge className="bg-purple-500/20 text-purple-700 border-purple-300">Rettifica</Badge>;
      default: return <Badge variant="secondary">{type}</Badge>;
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left p-2 font-medium">Data</th>
            <th className="text-center p-2 font-medium">Tipo</th>
            <th className="text-right p-2 font-medium">Qty</th>
            <th className="text-right p-2 font-medium">Prima</th>
            <th className="text-right p-2 font-medium">Dopo</th>
            <th className="text-left p-2 font-medium">Note</th>
            <th className="text-left p-2 font-medium">Utente</th>
          </tr>
        </thead>
        <tbody>
          {history.map((m) => (
            <tr key={m.id} className="border-b">
              <td className="p-2 text-xs whitespace-nowrap">
                {new Date(m.createdAt).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </td>
              <td className="p-2 text-center">{typeLabel(m.type)}</td>
              <td className={`p-2 text-right font-mono ${m.quantity > 0 ? "text-emerald-600" : "text-red-600"}`}>
                {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
              </td>
              <td className="p-2 text-right text-muted-foreground">{m.previousStock}</td>
              <td className="p-2 text-right font-medium">{m.newStock}</td>
              <td className="p-2 text-xs text-muted-foreground max-w-[200px] truncate">{m.notes || "—"}</td>
              <td className="p-2 text-xs">{m.createdByName || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
