import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
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
  ChevronDown,
  ChevronUp,
  Loader2,
  Package,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import {
  SortableTableHead,
  sortData,
  type SortConfig,
} from "@/components/SortableTableHead";

const NO_PRODUCER_VALUE = "__none__";

type SupplierCodeRow = {
  producerId: string;
  supplierCode: string;
};

type InitialBatchForm = {
  batchNumber: string;
  expirationDate: string;
  quantity: string;
};

type FormData = {
  sku: string;
  name: string;
  description: string;
  category: string;
  producerId: string;
  unitPrice: string;
  unit: string;
  piecesPerUnit: number;
  sellableUnitLabel: string;
  minStockThreshold: number;
  expiryWarningDays: number;
  vatRate: "4.00" | "5.00" | "10.00" | "22.00";
  supplierCodes: SupplierCodeRow[];
  showInitialBatch: boolean;
  initialBatch: InitialBatchForm;
};

const EMPTY_FORM: FormData = {
  sku: "",
  name: "",
  description: "",
  category: "",
  producerId: NO_PRODUCER_VALUE,
  unitPrice: "",
  unit: "",
  piecesPerUnit: 1,
  sellableUnitLabel: "PZ",
  minStockThreshold: 10,
  expiryWarningDays: 30,
  vatRate: "10.00",
  supplierCodes: [],
  showInitialBatch: false,
  initialBatch: {
    batchNumber: "",
    expirationDate: "",
    quantity: "",
  },
};

export default function Products() {
  const { data: rawProducts, isLoading } = trpc.products.list.useQuery();
  const { data: producers } = trpc.producers.list.useQuery();
  const [, setLocation] = useLocation();
  const searchStr = useSearch();

  // Sort state from URL query params
  const sortFromUrl = useMemo((): SortConfig => {
    const params = new URLSearchParams(searchStr);
    const key = params.get("sort");
    const dir = params.get("dir");
    if (key && (dir === "asc" || dir === "desc")) return { key, dir };
    return null;
  }, [searchStr]);

  const setSort = useCallback(
    (config: SortConfig) => {
      const params = new URLSearchParams(searchStr);
      if (config) {
        params.set("sort", config.key);
        params.set("dir", config.dir);
      } else {
        params.delete("sort");
        params.delete("dir");
      }
      const qs = params.toString();
      setLocation(`/products${qs ? `?${qs}` : ""}`, { replace: true });
    },
    [searchStr, setLocation],
  );

  // Sort accessor for products
  const productAccessor = useCallback(
    (item: NonNullable<typeof rawProducts>[number], key: string): unknown => {
      switch (key) {
        case "name": return item.name;
        case "sku": return item.sku;
        case "category": return item.category ?? "";
        case "unitPrice": return item.unitPrice ? parseFloat(item.unitPrice) : 0;
        case "vatRate": return parseFloat(item.vatRate);
        case "minStockThreshold": return item.minStockThreshold ?? 0;
        case "centralStock": return item.centralStock;
        case "totalStock": return item.totalStock;
        case "activeBatchCount": return item.activeBatchCount;
        case "nearestExpiration": return item.nearestExpiration ? new Date(item.nearestExpiration) : null;
        default: return null;
      }
    },
    [],
  );

  const products = useMemo(
    () => (rawProducts ? sortData(rawProducts, sortFromUrl, productAccessor) : undefined),
    [rawProducts, sortFromUrl, productAccessor],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const utils = trpc.useUtils();

  const [formData, setFormData] = useState<FormData>({ ...EMPTY_FORM });

  const resetForm = useCallback(
    (keepContext = false) => {
      if (keepContext) {
        // Mantieni producer e categoria per workflow rapido
        setFormData((prev) => ({
          ...EMPTY_FORM,
          producerId: prev.producerId,
          category: prev.category,
          supplierCodes: [],
          showInitialBatch: false,
          initialBatch: { batchNumber: "", expirationDate: "", quantity: "" },
        }));
      } else {
        setFormData({ ...EMPTY_FORM });
      }
    },
    [],
  );

  const createMutation = trpc.products.createExtended.useMutation({
    onSuccess: (product, _vars, _ctx) => {
      utils.products.list.invalidate();
      utils.warehouse.getStockOverview.invalidate();
      toast.success("Prodotto creato con successo");
      return product;
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = async (e: React.FormEvent, keepOpen = false) => {
    e.preventDefault();

    // Validate supplier codes: no empty codes
    const validCodes = formData.supplierCodes.filter(
      (sc) => sc.supplierCode.trim().length > 0 && sc.producerId !== NO_PRODUCER_VALUE,
    );

    // Validate initial batch if shown
    if (formData.showInitialBatch) {
      const ib = formData.initialBatch;
      if (!ib.batchNumber || !ib.expirationDate || !ib.quantity) {
        toast.error("Compila tutti i campi del lotto iniziale o chiudi la sezione");
        return;
      }
      const qty = parseInt(ib.quantity, 10);
      if (!Number.isFinite(qty) || qty <= 0) {
        toast.error("Quantità lotto deve essere un numero positivo");
        return;
      }
    }

    const producerName =
      formData.producerId !== NO_PRODUCER_VALUE
        ? producers?.find((p) => p.id === formData.producerId)?.name
        : undefined;

    const product = await createMutation.mutateAsync({
      sku: formData.sku,
      name: formData.name,
      description: formData.description || undefined,
      category: formData.category || undefined,
      supplierName: producerName || undefined,
      unitPrice: formData.unitPrice || undefined,
      unit: formData.unit || undefined,
      piecesPerUnit: formData.piecesPerUnit,
      sellableUnitLabel: formData.sellableUnitLabel || "PZ",
      minStockThreshold: formData.minStockThreshold,
      expiryWarningDays: formData.expiryWarningDays,
      vatRate: formData.vatRate,
      supplierCodes: validCodes,
      initialBatch:
        formData.showInitialBatch && formData.producerId !== NO_PRODUCER_VALUE
          ? {
              producerId: formData.producerId,
              batchNumber: formData.initialBatch.batchNumber,
              expirationDate: formData.initialBatch.expirationDate,
              quantity: parseInt(formData.initialBatch.quantity, 10),
            }
          : undefined,
    });

    if (keepOpen) {
      resetForm(true);
    } else {
      setDialogOpen(false);
      resetForm(false);
      // Auto-redirect a pagina dettaglio
      if (product?.id) {
        setLocation(`/products/${product.id}`);
      }
    }
  };

  // ============== Supplier codes management ==============
  const addSupplierCodeRow = () => {
    setFormData((prev) => ({
      ...prev,
      supplierCodes: [
        ...prev.supplierCodes,
        {
          producerId: prev.producerId !== NO_PRODUCER_VALUE ? prev.producerId : NO_PRODUCER_VALUE,
          supplierCode: "",
        },
      ],
    }));
  };

  const removeSupplierCodeRow = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      supplierCodes: prev.supplierCodes.filter((_, i) => i !== index),
    }));
  };

  const updateSupplierCodeRow = (
    index: number,
    field: keyof SupplierCodeRow,
    value: string,
  ) => {
    setFormData((prev) => ({
      ...prev,
      supplierCodes: prev.supplierCodes.map((sc, i) =>
        i === index ? { ...sc, [field]: value } : sc,
      ),
    }));
  };

  // Auto-add first supplier code row when producer is selected
  useEffect(() => {
    if (
      formData.producerId !== NO_PRODUCER_VALUE &&
      formData.supplierCodes.length === 0
    ) {
      setFormData((prev) => ({
        ...prev,
        supplierCodes: [{ producerId: prev.producerId, supplierCode: "" }],
      }));
    }
  }, [formData.producerId]);

  // Sync supplier code rows when main producer changes
  useEffect(() => {
    if (formData.producerId !== NO_PRODUCER_VALUE) {
      setFormData((prev) => ({
        ...prev,
        supplierCodes: prev.supplierCodes.map((sc) =>
          sc.producerId === NO_PRODUCER_VALUE
            ? { ...sc, producerId: prev.producerId }
            : sc,
        ),
      }));
    }
  }, [formData.producerId]);

  const [supplierCodesOpen, setSupplierCodesOpen] = useState(true);

  const now = Date.now();
  const formatDate = (d: string | null) =>
    d ? format(new Date(d), "dd/MM/yyyy") : "-";

  const expirationBadge = (d: string | null) => {
    if (!d) return null;
    const days = Math.floor((new Date(d).getTime() - now) / 86_400_000);
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

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Prodotti</h1>
            <p className="text-muted-foreground">
              Catalogo prodotti SoKeto con stock per location e scadenze.
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) resetForm(false);
          }}>
            <DialogTrigger asChild>
              <Button size="lg">
                <Plus className="h-5 w-5 mr-2" />
                Nuovo Prodotto
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <form onSubmit={(e) => handleSubmit(e, false)}>
                <DialogHeader>
                  <DialogTitle>Nuovo Prodotto</DialogTitle>
                  <DialogDescription>
                    Inserisci i dati del nuovo prodotto SoKeto
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  {/* SKU + Categoria */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="sku">SKU *</Label>
                      <Input
                        id="sku"
                        value={formData.sku}
                        onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        Inserisci una porzione di testo che apparirà sempre nei DDT dei tuoi produttori.
                        Es. &quot;FROLLINI VAN CON GOCCE&quot; fa match con &quot;CONF.FROLLINI VAN CON GOCCE CIOC 4X30g...&quot;
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="category">Categoria</Label>
                      <Input
                        id="category"
                        placeholder="es. Pane, Pasta, Dolci"
                        value={formData.category}
                        onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                      />
                    </div>
                  </div>

                  {/* Nome */}
                  <div className="grid gap-2">
                    <Label htmlFor="name">Nome Prodotto *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                    />
                  </div>

                  {/* Descrizione */}
                  <div className="grid gap-2">
                    <Label htmlFor="description">Descrizione</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      rows={2}
                    />
                  </div>

                  {/* Fornitore (Combobox via Select) */}
                  <div className="grid gap-2">
                    <Label htmlFor="producerId">Produttore / Fornitore</Label>
                    <Select
                      value={formData.producerId}
                      onValueChange={(v) => setFormData({ ...formData, producerId: v })}
                    >
                      <SelectTrigger id="producerId">
                        <SelectValue placeholder="Seleziona produttore" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_PRODUCER_VALUE}>— Nessuno</SelectItem>
                        {producers?.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {producers && producers.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        Nessun produttore disponibile.{" "}
                        <button
                          type="button"
                          className="text-primary underline"
                          onClick={() => setLocation("/producers")}
                        >
                          Creane uno
                        </button>
                      </p>
                    )}
                  </div>

                  {/* Codici fornitore (collapsible) */}
                  {formData.producerId !== NO_PRODUCER_VALUE && (
                    <div className="border border-border rounded-lg">
                      <button
                        type="button"
                        className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-foreground hover:bg-accent/50 rounded-t-lg"
                        onClick={() => setSupplierCodesOpen(!supplierCodesOpen)}
                      >
                        <span>Codici fornitore ({formData.supplierCodes.length})</span>
                        {supplierCodesOpen ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                      {supplierCodesOpen && (
                        <div className="px-4 pb-4 space-y-3">
                          {formData.supplierCodes.map((sc, idx) => (
                            <div key={idx} className="flex items-end gap-2">
                              <div className="flex-1 grid gap-1">
                                {idx === 0 && (
                                  <Label className="text-xs text-muted-foreground">
                                    Produttore
                                  </Label>
                                )}
                                <Select
                                  value={sc.producerId}
                                  onValueChange={(v) =>
                                    updateSupplierCodeRow(idx, "producerId", v)
                                  }
                                >
                                  <SelectTrigger className="h-9">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {producers?.map((p) => (
                                      <SelectItem key={p.id} value={p.id}>
                                        {p.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex-1 grid gap-1">
                                {idx === 0 && (
                                  <Label className="text-xs text-muted-foreground">
                                    Codice produttore
                                  </Label>
                                )}
                                <Input
                                  className="h-9"
                                  placeholder="es. LS571"
                                  value={sc.supplierCode}
                                  onChange={(e) =>
                                    updateSupplierCodeRow(idx, "supplierCode", e.target.value)
                                  }
                                />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 text-muted-foreground hover:text-destructive shrink-0"
                                onClick={() => removeSupplierCodeRow(idx)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={addSupplierCodeRow}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Aggiungi codice
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Prezzo + Unità */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="unitPrice">Prezzo Unitario (€)</Label>
                      <Input
                        id="unitPrice"
                        type="number"
                        step="0.01"
                        value={formData.unitPrice}
                        onChange={(e) => setFormData({ ...formData, unitPrice: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="unit">Unità di misura (etichetta)</Label>
                      <Input
                        id="unit"
                        placeholder="es. kg, pz, conf"
                        value={formData.unit}
                        onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
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
                        value={formData.piecesPerUnit}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            piecesPerUnit: Math.max(1, parseInt(e.target.value) || 1),
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Quanti pezzi vendibili contiene 1 confezione DDT. Es. 4 per "4x30g"
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="sellableUnitLabel">Etichetta unità vendita</Label>
                      <Input
                        id="sellableUnitLabel"
                        placeholder="es. PZ, CONF, BUSTA"
                        value={formData.sellableUnitLabel}
                        onChange={(e) => setFormData({ ...formData, sellableUnitLabel: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">
                        Come si chiama l'unità vendibile al dettaglio
                      </p>
                    </div>
                  </div>

                  {/* Soglie */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="minStockThreshold">Soglia Scorta Minima</Label>
                      <Input
                        id="minStockThreshold"
                        type="number"
                        value={formData.minStockThreshold}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            minStockThreshold: parseInt(e.target.value) || 0,
                          })
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="expiryWarningDays">Preavviso Scadenza (giorni)</Label>
                      <Input
                        id="expiryWarningDays"
                        type="number"
                        value={formData.expiryWarningDays}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            expiryWarningDays: parseInt(e.target.value) || 0,
                          })
                        }
                      />
                    </div>
                  </div>

                  {/* IVA */}
                  <div className="grid gap-2">
                    <Label htmlFor="vatRate">Aliquota IVA *</Label>
                    <Select
                      value={formData.vatRate}
                      onValueChange={(v) =>
                        setFormData({
                          ...formData,
                          vatRate: v as typeof formData.vatRate,
                        })
                      }
                    >
                      <SelectTrigger id="vatRate">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="4.00">4% (super-ridotta)</SelectItem>
                        <SelectItem value="5.00">5% (ridotta)</SelectItem>
                        <SelectItem value="10.00">10% (alimentari, default)</SelectItem>
                        <SelectItem value="22.00">22% (ordinaria, birre/bevande)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Primo lotto (opzionale, expandable) */}
                  {formData.producerId !== NO_PRODUCER_VALUE && (
                    <div className="border border-border rounded-lg">
                      {!formData.showInitialBatch ? (
                        <button
                          type="button"
                          className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium text-primary hover:bg-accent/50 rounded-lg"
                          onClick={() =>
                            setFormData({ ...formData, showInitialBatch: true })
                          }
                        >
                          <Plus className="h-4 w-4" />
                          Aggiungi primo lotto
                        </button>
                      ) : (
                        <>
                          <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-sm font-medium text-foreground">
                              Primo lotto
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-muted-foreground"
                              onClick={() =>
                                setFormData({
                                  ...formData,
                                  showInitialBatch: false,
                                  initialBatch: { batchNumber: "", expirationDate: "", quantity: "" },
                                })
                              }
                            >
                              Rimuovi
                            </Button>
                          </div>
                          <div className="px-4 pb-4 grid gap-3">
                            <div className="grid gap-1">
                              <Label className="text-xs text-muted-foreground">
                                Produttore
                              </Label>
                              <Input
                                value={
                                  producers?.find((p) => p.id === formData.producerId)?.name ?? ""
                                }
                                disabled
                                className="bg-muted"
                              />
                            </div>
                            <div className="grid gap-1">
                              <Label className="text-xs">Numero lotto *</Label>
                              <Input
                                placeholder="es. TH24C31K0"
                                value={formData.initialBatch.batchNumber}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    initialBatch: {
                                      ...formData.initialBatch,
                                      batchNumber: e.target.value,
                                    },
                                  })
                                }
                                required={formData.showInitialBatch}
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="grid gap-1">
                                <Label className="text-xs">Scadenza *</Label>
                                <Input
                                  type="date"
                                  value={formData.initialBatch.expirationDate}
                                  onChange={(e) =>
                                    setFormData({
                                      ...formData,
                                      initialBatch: {
                                        ...formData.initialBatch,
                                        expirationDate: e.target.value,
                                      },
                                    })
                                  }
                                  required={formData.showInitialBatch}
                                />
                              </div>
                              <div className="grid gap-1">
                                <Label className="text-xs">Quantità *</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  placeholder="es. 390"
                                  value={formData.initialBatch.quantity}
                                  onChange={(e) =>
                                    setFormData({
                                      ...formData,
                                      initialBatch: {
                                        ...formData.initialBatch,
                                        quantity: e.target.value,
                                      },
                                    })
                                  }
                                  required={formData.showInitialBatch}
                                />
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <DialogFooter className="gap-2">
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Annulla
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={createMutation.isPending}
                    onClick={(e) => handleSubmit(e as unknown as React.FormEvent, true)}
                  >
                    {createMutation.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Salva e crea nuovo
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Salva
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : products && products.length > 0 ? (
          <Card className="border-border bg-card">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTableHead sortKey="name" sort={sortFromUrl} onSort={setSort}>Nome</SortableTableHead>
                      <SortableTableHead sortKey="sku" sort={sortFromUrl} onSort={setSort}>SKU</SortableTableHead>
                      <SortableTableHead sortKey="category" sort={sortFromUrl} onSort={setSort}>Categoria</SortableTableHead>
                      <SortableTableHead sortKey="unitPrice" sort={sortFromUrl} onSort={setSort} className="text-right">Prezzo</SortableTableHead>
                      <SortableTableHead sortKey="vatRate" sort={sortFromUrl} onSort={setSort} className="text-right">IVA</SortableTableHead>
                      <SortableTableHead sortKey="minStockThreshold" sort={sortFromUrl} onSort={setSort} className="text-right">Soglia min</SortableTableHead>
                      <SortableTableHead sortKey="centralStock" sort={sortFromUrl} onSort={setSort} className="text-right">Stock centrale</SortableTableHead>
                      <SortableTableHead sortKey="totalStock" sort={sortFromUrl} onSort={setSort} className="text-right">Stock totale</SortableTableHead>
                      <SortableTableHead sortKey="activeBatchCount" sort={sortFromUrl} onSort={setSort} className="text-right">Lotti attivi</SortableTableHead>
                      <SortableTableHead sortKey="nearestExpiration" sort={sortFromUrl} onSort={setSort}>Scadenza più vicina</SortableTableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((p) => {
                      const minStock = p.minStockThreshold ?? 0;
                      const isLowCentral = p.centralStock < minStock;
                      return (
                        <TableRow
                          key={p.id}
                          className="cursor-pointer hover:bg-accent/50"
                          onClick={() => setLocation(`/products/${p.id}`)}
                        >
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <Package className="h-4 w-4 text-primary shrink-0" />
                              {p.name}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {p.sku}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {p.category ?? "-"}
                          </TableCell>
                          <TableCell className="text-right">
                            {p.unitPrice ? (
                              <>
                                €{p.unitPrice}
                                {p.unit && (
                                  <span className="text-muted-foreground text-xs ml-1">
                                    /{p.unit}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground font-mono text-xs">
                            {parseFloat(p.vatRate).toFixed(0)}%
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {minStock}
                          </TableCell>
                          <TableCell
                            className={`text-right font-semibold ${
                              isLowCentral ? "text-yellow-500" : "text-foreground"
                            }`}
                          >
                            {p.centralStock}
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {p.totalStock}
                          </TableCell>
                          <TableCell className="text-right">
                            {p.activeBatchCount}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span>{formatDate(p.nearestExpiration)}</span>
                              {expirationBadge(p.nearestExpiration)}
                            </div>
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
              <Package className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Nessun prodotto catalogato
              </h3>
              <p className="text-muted-foreground mb-6 text-center max-w-md">
                Inizia aggiungendo i prodotti SoKeto al catalogo
              </p>
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="h-5 w-5 mr-2" />
                Aggiungi Prodotto
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
