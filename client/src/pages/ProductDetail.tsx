import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  DialogTrigger,
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowLeft,
  GitMerge,
  Link2,
  Loader2,
  Package,
  Plus,
  Save,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useLocation, useRoute } from "wouter";

type FormState = {
  sku: string;
  name: string;
  description: string;
  category: string;
  supplierName: string;
  unitPrice: string;
  unit: string;
  piecesPerUnit: number;
  sellableUnitLabel: string;
  minStockThreshold: number;
  expiryWarningDays: number;
  isLowCarb: boolean;
  isGlutenFree: boolean;
  isKeto: boolean;
  imageUrl: string;
  costPrice: string;
};

const EMPTY_FORM: FormState = {
  sku: "",
  name: "",
  description: "",
  category: "",
  supplierName: "",
  unitPrice: "",
  unit: "",
  piecesPerUnit: 1,
  sellableUnitLabel: "PZ",
  minStockThreshold: 10,
  expiryWarningDays: 30,
  isLowCarb: true,
  isGlutenFree: true,
  isKeto: true,
  imageUrl: "",
  costPrice: "",
};

const NO_PRODUCER_VALUE = "__none__";

type BatchFormState = {
  producerId: string;
  batchNumber: string;
  expirationDate: string;
  productionDate: string;
  initialQuantity: string;
  notes: string;
  costPrice: string;
};

const EMPTY_BATCH_FORM: BatchFormState = {
  producerId: NO_PRODUCER_VALUE,
  batchNumber: "",
  expirationDate: "",
  productionDate: "",
  initialQuantity: "",
  notes: "",
  costPrice: "",
};

// ====================== Codici Fornitore (M5.5) ======================

function SupplierCodesSection({
  productId,
  producers,
}: {
  productId: string;
  producers: Array<{ id: string; name: string }>;
}) {
  const utils = trpc.useUtils();
  const { data: codes, isLoading } = trpc.products.getSupplierCodes.useQuery(
    { productId },
    { enabled: productId.length > 0 },
  );

  const [addOpen, setAddOpen] = useState(false);
  const [newProducerId, setNewProducerId] = useState("__none__");
  const [newCode, setNewCode] = useState("");

  const addMutation = trpc.products.addSupplierCode.useMutation({
    onSuccess: () => {
      utils.products.getSupplierCodes.invalidate({ productId });
      setAddOpen(false);
      setNewProducerId("__none__");
      setNewCode("");
      toast.success("Codice fornitore aggiunto");
    },
    onError: (err) => toast.error(err.message),
  });

  const removeMutation = trpc.products.removeSupplierCode.useMutation({
    onSuccess: () => {
      utils.products.getSupplierCodes.invalidate({ productId });
      toast.success("Codice fornitore rimosso");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    if (newProducerId === "__none__" || !newCode.trim()) {
      toast.error("Seleziona produttore e inserisci codice");
      return;
    }
    addMutation.mutate({
      productId,
      producerId: newProducerId,
      supplierCode: newCode.trim(),
    });
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Codici fornitore
            </CardTitle>
            <CardDescription>
              Codici prodotto usati dai fornitori (per match automatico DDT).
            </CardDescription>
          </div>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="h-4 w-4 mr-1" />
                Aggiungi
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <form onSubmit={handleAdd}>
                <DialogHeader>
                  <DialogTitle>Aggiungi codice fornitore</DialogTitle>
                  <DialogDescription>
                    Associa un codice produttore a questo prodotto per il match automatico DDT.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label>Produttore *</Label>
                    <Select value={newProducerId} onValueChange={setNewProducerId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Seleziona produttore" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— Seleziona</SelectItem>
                        {producers.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Codice produttore *</Label>
                    <Input
                      placeholder="es. LS571"
                      value={newCode}
                      onChange={(e) => setNewCode(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                    Annulla
                  </Button>
                  <Button type="submit" disabled={addMutation.isPending}>
                    {addMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Aggiungi
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : codes && codes.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produttore</TableHead>
                <TableHead>Codice</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="text-muted-foreground">
                    {c.producerName}
                  </TableCell>
                  <TableCell className="font-mono text-sm">{c.supplierCode}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeMutation.mutate({ id: c.id })}
                      disabled={removeMutation.isPending}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            Nessun codice fornitore associato.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ====================== Channel Variants Card (M8.1) ======================
function ChannelVariantsCard({ productId }: { productId: string }) {
  const { data: variants, isLoading } = trpc.shopify.variants.list.useQuery(
    { limit: 50, offset: 0 },
    { enabled: productId.length > 0 },
  );

  // Filter variants mapped to this product
  const mapped = variants?.items?.filter((v: any) => v.productId === productId) ?? [];

  if (isLoading) return null;
  if (mapped.length === 0) return null;

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="h-4 w-4" />
          Varianti Canale ({mapped.length})
        </CardTitle>
        <CardDescription>
          SKU Shopify mappati a questo prodotto
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU Canale</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead className="text-center">Multiplier</TableHead>
              <TableHead className="text-center">Stato</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mapped.map((v: any) => (
              <TableRow key={v.id}>
                <TableCell className="font-mono text-sm">{v.channelSku}</TableCell>
                <TableCell>{v.displayName}</TableCell>
                <TableCell className="text-center">{v.multiplier}×</TableCell>
                <TableCell className="text-center">
                  <Badge variant={v.isActive ? "default" : "secondary"}>
                    {v.isActive ? "Attivo" : "Disattivo"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function ProductDetail() {
  const { user: me } = useAuth({ redirectOnUnauthenticated: true });
  const isAdmin = me?.role === "admin";
  const [, params] = useRoute("/products/:id");
  const [, setLocation] = useLocation();
  const productId = params?.id ?? "";
  const utils = trpc.useUtils();

  const { data: product, isLoading } = trpc.products.getById.useQuery(
    { id: productId },
    { enabled: productId.length > 0 },
  );

  const { data: batches, isLoading: batchesLoading } =
    trpc.productBatches.listByProduct.useQuery(
      { productId },
      { enabled: productId.length > 0 },
    );

  const { data: producers } = trpc.producers.list.useQuery();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (product) {
      setForm({
        sku: product.sku ?? "",
        name: product.name ?? "",
        description: product.description ?? "",
        category: product.category ?? "",
        supplierName: product.supplierName ?? "",
        unitPrice: product.unitPrice ?? "",
        unit: product.unit ?? "",
        piecesPerUnit: product.piecesPerUnit ?? 1,
        sellableUnitLabel: product.sellableUnitLabel ?? "PZ",
        minStockThreshold: product.minStockThreshold ?? 10,
        expiryWarningDays: product.expiryWarningDays ?? 30,
        isLowCarb: product.isLowCarb === 1,
        isGlutenFree: product.isGlutenFree === 1,
        isKeto: product.isKeto === 1,
        imageUrl: product.imageUrl ?? "",
        costPrice: product.costPrice ?? "",
      });
    }
  }, [product]);

  const updateMutation = trpc.products.update.useMutation({
    onSuccess: async () => {
      await utils.products.list.invalidate();
      await utils.products.getById.invalidate({ id: productId });
      toast.success("Prodotto aggiornato");
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.products.delete.useMutation({
    onSuccess: async () => {
      await utils.products.list.invalidate();
      toast.success("Prodotto eliminato");
      setLocation("/products");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    updateMutation.mutate({
      id: productId,
      sku: form.sku,
      name: form.name,
      description: form.description || undefined,
      category: form.category || undefined,
      supplierName: form.supplierName || undefined,
      unitPrice: form.unitPrice || undefined,
      unit: form.unit || undefined,
      piecesPerUnit: form.piecesPerUnit,
      sellableUnitLabel: form.sellableUnitLabel || "PZ",
      minStockThreshold: form.minStockThreshold,
      expiryWarningDays: form.expiryWarningDays,
      isLowCarb: form.isLowCarb ? 1 : 0,
      isGlutenFree: form.isGlutenFree ? 1 : 0,
      isKeto: form.isKeto ? 1 : 0,
      imageUrl: form.imageUrl || undefined,
      costPrice: form.costPrice || undefined,
    });
  };

  // ====================== Sezione Lotti ======================

  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchForm, setBatchForm] = useState<BatchFormState>(EMPTY_BATCH_FORM);
  // M6.2.F: Smart merge state
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [mergeBatchId, setMergeBatchId] = useState<string | null>(null);

  // M6.2.F: Check lot conflict when batchNumber + expirationDate are filled
  const canCheckConflict = batchForm.batchNumber.length > 0 && batchForm.expirationDate.length === 10;
  const { data: conflictResult } = trpc.productBatches.checkLotConflict.useQuery(
    {
      productId,
      batchNumber: batchForm.batchNumber,
      expirationDate: batchForm.expirationDate,
      producerId: batchForm.producerId !== NO_PRODUCER_VALUE ? batchForm.producerId : null,
    },
    { enabled: canCheckConflict && batchDialogOpen },
  );

  const createBatchMutation = trpc.productBatches.create.useMutation({
    onSuccess: async (result: any) => {
      await utils.productBatches.listByProduct.invalidate({ productId });
      await utils.warehouse.getStockOverview.invalidate();
      setBatchDialogOpen(false);
      setBatchForm(EMPTY_BATCH_FORM);
      setMergeConfirmed(false);
      setMergeBatchId(null);
      if (result?.merged) {
        toast.success(`Quantit\u00e0 aggiunta al lotto esistente (nuovo totale: ${result.newQuantity} pz)`);
      } else {
        toast.success("Lotto registrato in magazzino centrale");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteBatchMutation = trpc.productBatches.delete.useMutation({
    onSuccess: async () => {
      await utils.productBatches.listByProduct.invalidate({ productId });
      await utils.warehouse.getStockOverview.invalidate();
      toast.success("Lotto eliminato");
    },
    onError: (err) => toast.error(err.message),
  });

  // ============== Write-off state (Phase B M2) ==============
  const { data: warehouseLoc } = trpc.locations.getCentralWarehouse.useQuery();

  const [writeOffTarget, setWriteOffTarget] = useState<{
    batchId: string;
    batchNumber: string;
    expirationDate: string;
    maxQuantity: number;
  } | null>(null);
  const [writeOffQty, setWriteOffQty] = useState("");
  const [writeOffNotes, setWriteOffNotes] = useState("");

  const writeOffMutation = trpc.stockMovements.expiryWriteOff.useMutation({
    onSuccess: async () => {
      await utils.productBatches.listByProduct.invalidate({ productId });
      await utils.warehouse.getStockOverview.invalidate();
      setWriteOffTarget(null);
      setWriteOffQty("");
      setWriteOffNotes("");
      toast.success("Lotto scartato");
    },
    onError: (err) => toast.error(err.message),
  });

  const submitWriteOff = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!writeOffTarget || !warehouseLoc) return;
    const qty = parseInt(writeOffQty, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Quantità deve essere positiva");
      return;
    }
    if (qty > writeOffTarget.maxQuantity) {
      toast.error(`Quantità massima: ${writeOffTarget.maxQuantity}`);
      return;
    }
    writeOffMutation.mutate({
      batchId: writeOffTarget.batchId,
      locationId: warehouseLoc.id,
      quantity: qty,
      notes: writeOffNotes || undefined,
    });
  };

  const isEligibleForWriteOff = (expirationDate: string, qty: number) => {
    if (qty <= 0) return false;
    const days = Math.floor(
      (new Date(expirationDate).getTime() - Date.now()) / 86_400_000,
    );
    return days <= 7;
  };

  const handleBatchSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const qty = parseInt(batchForm.initialQuantity, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Quantit\u00e0 iniziale deve essere un numero positivo");
      return;
    }
    // M6.2.F: If merge detected but not confirmed, block
    if (conflictResult?.status === "merge" && !mergeConfirmed) {
      toast.error("Conferma il merge prima di procedere");
      return;
    }
    // M6.2.F: If conflict detected, block
    if (conflictResult?.status === "conflict") {
      toast.error("Conflitto rilevato: modifica i dati del lotto");
      return;
    }
    createBatchMutation.mutate({
      productId,
      producerId:
        batchForm.producerId !== NO_PRODUCER_VALUE
          ? batchForm.producerId
          : undefined,
      batchNumber: batchForm.batchNumber,
      expirationDate: batchForm.expirationDate,
      productionDate: batchForm.productionDate || undefined,
      initialQuantity: qty,
      notes: batchForm.notes || undefined,
      costPrice: batchForm.costPrice || undefined,
      mergeWithBatchId: mergeConfirmed ? (mergeBatchId ?? undefined) : undefined,
    });
  };

  const formatDate = (d: string | null) =>
    d ? format(new Date(d), "dd/MM/yyyy") : "-";

  const expirationBadge = (expirationDate: string) => {
    const days = Math.floor(
      (new Date(expirationDate).getTime() - Date.now()) / 86_400_000,
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

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  if (!product) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Button variant="ghost" onClick={() => setLocation("/products")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Torna ai Prodotti
          </Button>
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Package className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Prodotto non trovato
              </h3>
              <p className="text-muted-foreground">
                Il prodotto richiesto non esiste o è stato eliminato.
              </p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/products")}
              className="mb-3"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Torna ai Prodotti
            </Button>
            <h1 className="text-3xl font-bold text-foreground">{product.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              SKU: {product.sku} · Aggiornato il{" "}
              {format(new Date(product.updatedAt), "dd/MM/yyyy HH:mm")}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label="Elimina prodotto"
              >
                <Trash2 className="h-5 w-5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Eliminare il prodotto?</AlertDialogTitle>
                <AlertDialogDescription>
                  Stai eliminando <strong>{product.name}</strong> (SKU{" "}
                  {product.sku}). L'operazione è irreversibile e potrebbe
                  invalidare i record di inventario e movimenti che
                  riferiscono questo prodotto.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Annulla</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => deleteMutation.mutate({ id: productId })}
                >
                  Elimina
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>Anagrafica</CardTitle>
              <CardDescription>SKU, nome, descrizione, categoria.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="sku">SKU *</Label>
                  <Input
                    id="sku"
                    value={form.sku}
                    onChange={(e) => setForm({ ...form, sku: e.target.value })}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="category">Categoria</Label>
                  <Input
                    id="category"
                    value={form.category}
                    onChange={(e) =>
                      setForm({ ...form, category: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="name">Nome *</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Descrizione</Label>
                <Textarea
                  id="description"
                  rows={3}
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="imageUrl">URL immagine</Label>
                <Input
                  id="imageUrl"
                  type="url"
                  value={form.imageUrl}
                  onChange={(e) =>
                    setForm({ ...form, imageUrl: e.target.value })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>Prezzo e fornitore</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="unitPrice">Prezzo unitario (€)</Label>
                  <Input
                    id="unitPrice"
                    type="number"
                    step="0.01"
                    value={form.unitPrice}
                    onChange={(e) =>
                      setForm({ ...form, unitPrice: e.target.value })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="unit">Unità di misura</Label>
                  <Input
                    id="unit"
                    placeholder="kg, pz, conf"
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  />
                </div>
              </div>
              {/* M5.8: Confezioni vendita */}
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="piecesPerUnit">Pezzi per confezione</Label>
                  <Input
                    id="piecesPerUnit"
                    type="number"
                    min={1}
                    value={form.piecesPerUnit}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        piecesPerUnit: Math.max(1, parseInt(e.target.value) || 1),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Quanti pezzi vendibili contiene 1 confezione DDT
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sellableUnitLabel">Etichetta unità vendita</Label>
                  <Input
                    id="sellableUnitLabel"
                    placeholder="es. PZ, CONF, BUSTA"
                    value={form.sellableUnitLabel}
                    onChange={(e) => setForm({ ...form, sellableUnitLabel: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Come si chiama l'unità vendibile al dettaglio
                  </p>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="supplierName">Fornitore</Label>
                <Input
                  id="supplierName"
                  value={form.supplierName}
                  onChange={(e) =>
                    setForm({ ...form, supplierName: e.target.value })
                  }
                />
              </div>
              {isAdmin && (
                <div className="grid gap-2">
                  <Label htmlFor="costPrice">Costo Unitario Standard (€)</Label>
                  <Input
                    id="costPrice"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={form.costPrice}
                    onChange={(e) =>
                      setForm({ ...form, costPrice: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Costo di acquisto per il calcolo del valore magazzino
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>Caratteristiche e soglie</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={form.isLowCarb}
                    onCheckedChange={(v) =>
                      setForm({ ...form, isLowCarb: v === true })
                    }
                  />
                  <span className="text-sm">Low Carb</span>
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={form.isGlutenFree}
                    onCheckedChange={(v) =>
                      setForm({ ...form, isGlutenFree: v === true })
                    }
                  />
                  <span className="text-sm">Gluten Free</span>
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={form.isKeto}
                    onCheckedChange={(v) =>
                      setForm({ ...form, isKeto: v === true })
                    }
                  />
                  <span className="text-sm">Keto</span>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="minStockThreshold">Soglia scorta minima</Label>
                  <Input
                    id="minStockThreshold"
                    type="number"
                    value={form.minStockThreshold}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        minStockThreshold: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="expiryWarningDays">
                    Preavviso scadenza (giorni)
                  </Label>
                  <Input
                    id="expiryWarningDays"
                    type="number"
                    value={form.expiryWarningDays}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        expiryWarningDays: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setLocation("/products")}
            >
              Annulla
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Salva modifiche
            </Button>
          </div>
        </form>

        {/* =============== Sezione Codici Fornitore (M5.5) =============== */}
        <SupplierCodesSection productId={productId} producers={producers ?? []} />

        {/* Sezione Lotti — separata visivamente dal form anagrafica */}
        {/* M5.8: Riepilogo stock con pezzi vendibili */}
        {product && (() => {
          const ppu = product.piecesPerUnit ?? 1;
          const label = product.sellableUnitLabel ?? "PZ";
          const totalConf = batches?.reduce((sum, b) => sum + (b.centralStock ?? 0), 0) ?? 0;
          const totalPezzi = totalConf * ppu;
          return ppu > 1 ? (
            <div className="mt-8 grid grid-cols-3 gap-4">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardDescription>Stock confezioni</CardDescription>
                  <CardTitle className="text-2xl">{totalConf} <span className="text-sm font-normal text-muted-foreground">{product.unit ?? "conf"}</span></CardTitle>
                </CardHeader>
              </Card>
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardDescription>Pezzi vendibili</CardDescription>
                  <CardTitle className="text-2xl">{totalPezzi} <span className="text-sm font-normal text-muted-foreground">{label}</span></CardTitle>
                </CardHeader>
              </Card>
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardDescription>Pezzi per confezione</CardDescription>
                  <CardTitle className="text-2xl">{ppu} <span className="text-sm font-normal text-muted-foreground">{label}/{product.unit ?? "conf"}</span></CardTitle>
                </CardHeader>
              </Card>
            </div>
          ) : null;
        })()}

        <div className="mt-12">
          <Card className="border-border bg-card">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>Lotti</CardTitle>
                  <CardDescription>
                    Lotti registrati per questo prodotto, con stock corrente al
                    magazzino centrale.
                  </CardDescription>
                </div>
                <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
                  <DialogTrigger asChild>
                    <Button>
                      <Plus className="h-4 w-4 mr-2" />
                      Aggiungi lotto
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
                    <form onSubmit={handleBatchSubmit}>
                      <DialogHeader>
                        <DialogTitle>Nuovo lotto</DialogTitle>
                        <DialogDescription>
                          Registra un ingresso al magazzino centrale.
                          Verrà creato un movimento RECEIPT_FROM_PRODUCER.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                          <Label htmlFor="batchProducer">Produttore</Label>
                          <Select
                            value={batchForm.producerId}
                            onValueChange={(v) =>
                              setBatchForm({ ...batchForm, producerId: v })
                            }
                          >
                            <SelectTrigger id="batchProducer">
                              <SelectValue placeholder="Seleziona produttore" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_PRODUCER_VALUE}>
                                — Nessuno
                              </SelectItem>
                              {producers?.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="batchNumber">Numero lotto *</Label>
                          <Input
                            id="batchNumber"
                            value={batchForm.batchNumber}
                            onChange={(e) =>
                              setBatchForm({
                                ...batchForm,
                                batchNumber: e.target.value,
                              })
                            }
                            required
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="grid gap-2">
                            <Label htmlFor="expirationDate">Scadenza *</Label>
                            <Input
                              id="expirationDate"
                              type="date"
                              value={batchForm.expirationDate}
                              onChange={(e) =>
                                setBatchForm({
                                  ...batchForm,
                                  expirationDate: e.target.value,
                                })
                              }
                              required
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="productionDate">
                              Data produzione
                            </Label>
                            <Input
                              id="productionDate"
                              type="date"
                              value={batchForm.productionDate}
                              onChange={(e) =>
                                setBatchForm({
                                  ...batchForm,
                                  productionDate: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="initialQuantity">
                            Quantità iniziale *
                          </Label>
                          <Input
                            id="initialQuantity"
                            type="number"
                            min={1}
                            value={batchForm.initialQuantity}
                            onChange={(e) =>
                              setBatchForm({
                                ...batchForm,
                                initialQuantity: e.target.value,
                              })
                            }
                            required
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="batchNotes">Note</Label>
                          <Textarea
                            id="batchNotes"
                            rows={2}
                            placeholder="Riferimento DDT, lotto produttore, ecc."
                            value={batchForm.notes}
                            onChange={(e) =>
                              setBatchForm({
                                ...batchForm,
                                notes: e.target.value,
                              })
                            }
                          />
                        </div>
                        {isAdmin && (
                          <div className="grid gap-2">
                            <Label htmlFor="batchCostPrice">Costo Unitario Lotto (€)</Label>
                            <Input
                              id="batchCostPrice"
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder={product?.costPrice ? `Default: €${product.costPrice}` : "0.00"}
                              value={batchForm.costPrice}
                              onChange={(e) =>
                                setBatchForm({
                                  ...batchForm,
                                  costPrice: e.target.value,
                                })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Se vuoto, usa il costo standard del prodotto{product?.costPrice ? ` (€${product.costPrice})` : ""}
                            </p>
                          </div>
                        )}
                      </div>
                      {/* M6.2.F: Smart merge banner */}
                      {canCheckConflict && conflictResult?.status === "merge" && (
                        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 p-4 my-2">
                          <div className="flex items-start gap-3">
                            <GitMerge className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                            <div className="flex-1">
                              <p className="font-medium text-blue-900 dark:text-blue-200 text-sm">
                                Lotto gi\u00e0 esistente — merge disponibile
                              </p>
                              <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                                Il lotto <strong>{conflictResult.batch.batchNumber}</strong> (scad. {conflictResult.batch.expirationDate}) esiste gi\u00e0 con <strong>{conflictResult.batch.currentQuantity} pezzi</strong> in stock.
                                La quantit\u00e0 inserita verr\u00e0 <strong>sommata</strong> allo stock esistente.
                              </p>
                              <label className="flex items-center gap-2 mt-3 cursor-pointer">
                                <Checkbox
                                  checked={mergeConfirmed}
                                  onCheckedChange={(checked) => {
                                    setMergeConfirmed(!!checked);
                                    setMergeBatchId(conflictResult.batch.id);
                                  }}
                                />
                                <span className="text-sm text-blue-800 dark:text-blue-200">
                                  Confermo: aggiungi quantit\u00e0 al lotto esistente
                                </span>
                              </label>
                            </div>
                          </div>
                        </div>
                      )}
                      {canCheckConflict && conflictResult?.status === "conflict" && (
                        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-4 my-2">
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                            <div className="flex-1">
                              <p className="font-medium text-red-900 dark:text-red-200 text-sm">
                                Conflitto: stesso numero lotto con dati diversi
                              </p>
                              <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                                Esiste gi\u00e0 il lotto <strong>{conflictResult.conflictingBatch.batchNumber}</strong> ma con scadenza o produttore diversi.
                                Modifica il numero lotto o i parametri per procedere.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                      <DialogFooter>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setBatchDialogOpen(false);
                            setMergeConfirmed(false);
                            setMergeBatchId(null);
                          }}
                        >
                          Annulla
                        </Button>
                        <Button
                          type="submit"
                          disabled={
                            createBatchMutation.isPending ||
                            (conflictResult?.status === "merge" && !mergeConfirmed) ||
                            conflictResult?.status === "conflict"
                          }
                        >
                          {createBatchMutation.isPending && (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          )}
                          {conflictResult?.status === "merge" && mergeConfirmed
                            ? "Aggiungi al lotto esistente"
                            : "Registra lotto"}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {batchesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : batches && batches.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Batch</TableHead>
                      <TableHead>Produttore</TableHead>
                      <TableHead>Scadenza</TableHead>
                      <TableHead className="text-right">Qty iniziale</TableHead>
                      <TableHead className="text-right">Stock magazzino</TableHead>
                      <TableHead className="text-right">Stock retailer</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="font-mono text-xs">
                          {b.batchNumber}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {b.producerName ?? "-"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span>{formatDate(b.expirationDate)}</span>
                            {expirationBadge(b.expirationDate)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {b.initialQuantity}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {b.centralStock ?? 0}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {b.retailerStock ?? 0}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            {warehouseLoc &&
                              isEligibleForWriteOff(
                                b.expirationDate,
                                b.centralStock ?? 0,
                              ) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  aria-label="Scarta lotto"
                                  title="Scarta (scadenza imminente o passata)"
                                  onClick={() =>
                                    setWriteOffTarget({
                                      batchId: b.id,
                                      batchNumber: b.batchNumber,
                                      expirationDate: b.expirationDate,
                                      maxQuantity: b.centralStock ?? 0,
                                    })
                                  }
                                >
                                  <XCircle className="h-4 w-4" />
                                </Button>
                              )}
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  aria-label="Elimina lotto"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    Eliminare il lotto {b.batchNumber}?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    L'eliminazione è consentita solo se il lotto è
                                    ancora intatto in magazzino centrale (nessuna
                                    distribuzione né uscita parziale).
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Annulla</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    onClick={() =>
                                      deleteBatchMutation.mutate({ id: b.id })
                                    }
                                  >
                                    Elimina lotto
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Package className="h-10 w-10 text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Nessun lotto registrato per questo prodotto.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ====================== Channel Variants (M8.1) ====================== */}
      <ChannelVariantsCard productId={productId} />

      {/* ====================== Dialog WRITE-OFF ====================== */}
      {/* Dialog (non AlertDialog): Radix AlertDialogAction chiude il
          dialog tramite onClick interno PRIMA del form submit nativo
          → form rimosso, mutation mai eseguita. M2.0.1 fix. */}
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
                </strong>
                {" "}(scad{" "}
                {writeOffTarget?.expirationDate
                  ? format(new Date(writeOffTarget.expirationDate), "dd/MM/yyyy")
                  : "?"}
                ) al magazzino centrale. Verrà registrato un movimento{" "}
                <strong>EXPIRY_WRITE_OFF</strong>.
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
                  placeholder="Es. Scaduto, contaminazione"
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
