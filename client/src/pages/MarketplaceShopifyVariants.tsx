import { useState, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Package, RefreshCw, Search, Edit2, Layers, Trash2, Plus } from "lucide-react";

export default function MarketplaceShopifyVariants() {
  const searchString = useSearch();
  const params = useMemo(() => new URLSearchParams(searchString), [searchString]);
  const initialUnmapped = params.get("unmapped") === "true";

  const [search, setSearch] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(initialUnmapped);
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const utils = trpc.useUtils();

  const { data, isLoading, refetch } = trpc.shopify.variants.list.useQuery({
    search: search || undefined,
    onlyUnmapped,
    limit: pageSize,
    offset: page * pageSize,
  });

  const { data: productsList } = trpc.products.list.useQuery();

  const syncMutation = trpc.shopify.variants.syncFromShopify.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Sync completato: ${data.imported} nuove, ${data.updated} aggiornate, ${data.unmapped} da mappare`,
      );
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  // ─── Edit Mapping Dialog ───────────────────────────────────────────────────
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editVariant, setEditVariant] = useState<any>(null);
  const [editProductId, setEditProductId] = useState<string>("");
  const [editMultiplier, setEditMultiplier] = useState("1");

  const updateMappingMutation = trpc.shopify.variants.updateMapping.useMutation({
    onSuccess: () => {
      toast.success("Mapping aggiornato");
      setEditDialogOpen(false);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const openEditDialog = (variant: any) => {
    setEditVariant(variant);
    setEditProductId(variant.productId || "__none__");
    setEditMultiplier(String(variant.multiplier));
    setEditDialogOpen(true);
  };

  const handleSaveMapping = () => {
    if (!editVariant) return;
    updateMappingMutation.mutate({
      variantId: editVariant.id,
      productId: editProductId === "__none__" ? null : editProductId,
      multiplier: parseInt(editMultiplier) || 1,
    });
  };

  // ─── Bundle Dialog ─────────────────────────────────────────────────────────
  const [bundleDialogOpen, setBundleDialogOpen] = useState(false);
  const [bundleVariant, setBundleVariant] = useState<any>(null);
  const [bundleComponents, setBundleComponents] = useState<
    Array<{ productId: string; quantity: number }>
  >([]);

  const { data: existingComponents, refetch: refetchComponents } =
    trpc.shopify.variants.getComponents.useQuery(
      { variantId: bundleVariant?.id ?? "" },
      { enabled: !!bundleVariant?.id && bundleDialogOpen },
    );

  const setBundleMutation = trpc.shopify.variants.setBundle.useMutation({
    onSuccess: () => {
      toast.success("Bundle salvato");
      setBundleDialogOpen(false);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const openBundleEditor = (variant: any) => {
    setBundleVariant(variant);
    setBundleComponents([]);
    setBundleDialogOpen(true);
  };

  // When existing components load, populate the form
  const populatedComponents = useMemo(() => {
    if (existingComponents && existingComponents.length > 0 && bundleComponents.length === 0) {
      return existingComponents.map((c) => ({
        productId: c.productId,
        quantity: c.quantity,
      }));
    }
    return bundleComponents;
  }, [existingComponents, bundleComponents]);

  const activeComponents =
    bundleComponents.length > 0 ? bundleComponents : populatedComponents;

  const addComponent = () => {
    setBundleComponents([...activeComponents, { productId: "", quantity: 1 }]);
  };

  const updateComponent = (index: number, field: string, value: any) => {
    const updated = [...activeComponents];
    (updated[index] as any)[field] = value;
    setBundleComponents(updated);
  };

  const removeComponent = (index: number) => {
    const updated = activeComponents.filter((_, i) => i !== index);
    setBundleComponents(updated);
  };

  const handleSaveBundle = () => {
    if (!bundleVariant) return;
    const validComponents = activeComponents.filter(
      (c) => c.productId && c.quantity > 0,
    );
    if (validComponents.length === 0) {
      toast.error("Aggiungi almeno un componente al bundle");
      return;
    }
    setBundleMutation.mutate({
      variantId: bundleVariant.id,
      isBundle: true,
      components: validComponents,
    });
  };

  // ─── Toggle Bundle ─────────────────────────────────────────────────────────
  const toggleBundleMutation = trpc.shopify.variants.setBundle.useMutation({
    onSuccess: () => {
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleToggleBundle = (variant: any, isBundle: boolean) => {
    if (isBundle) {
      // Open bundle editor
      openBundleEditor(variant);
    } else {
      // Unset bundle
      toggleBundleMutation.mutate({
        variantId: variant.id,
        isBundle: false,
      });
      toast.success("Bundle disattivato");
    }
  };

  const totalPages = Math.ceil((data?.totalCount ?? 0) / pageSize);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/marketplace/shopify">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Package className="h-6 w-6" />
                Varianti Shopify
              </h1>
              <p className="text-muted-foreground">
                Mapping tra SKU Shopify e prodotti interni ({data?.totalCount ?? 0} varianti)
              </p>
            </div>
          </div>
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            Sync da Shopify
          </Button>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-4 items-end">
              <div className="flex-1 min-w-[200px]">
                <Label className="text-xs">Cerca SKU / Nome</Label>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Cerca..."
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                    className="pl-8"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Filtro</Label>
                <Select
                  value={onlyUnmapped ? "unmapped" : "all"}
                  onValueChange={(v) => { setOnlyUnmapped(v === "unmapped"); setPage(0); }}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tutte</SelectItem>
                    <SelectItem value="unmapped">Solo non mappate</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU Shopify</TableHead>
                  <TableHead>Nome Shopify</TableHead>
                  <TableHead className="text-center">Bundle</TableHead>
                  <TableHead>Prodotto / Componenti</TableHead>
                  <TableHead className="text-center">Multiplier</TableHead>
                  <TableHead className="text-center">Stato</TableHead>
                  <TableHead className="text-right">Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Caricamento...
                    </TableCell>
                  </TableRow>
                ) : data?.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Nessuna variante trovata
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.items.map((v: any) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-sm">{v.channelSku}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{v.displayName}</TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={v.isBundle}
                          onCheckedChange={(checked) => handleToggleBundle(v, checked)}
                          disabled={toggleBundleMutation.isPending}
                        />
                      </TableCell>
                      <TableCell>
                        {v.isBundle ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openBundleEditor(v)}
                            className="gap-1"
                          >
                            <Layers className="h-3.5 w-3.5" />
                            Modifica componenti
                          </Button>
                        ) : v.productName ? (
                          <span className="text-sm">
                            {v.productName}{" "}
                            <span className="text-muted-foreground">({v.productSku})</span>
                          </span>
                        ) : (
                          <Badge variant="destructive" className="text-xs">Non mappato</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {v.isBundle ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : (
                          <span>{v.multiplier}×</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={v.isActive ? "default" : "secondary"}>
                          {v.isActive ? "Attivo" : "Disattivo"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {!v.isBundle && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditDialog(v)}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Pagina {page + 1} di {totalPages} ({data?.totalCount} risultati)
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Precedente
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
              >
                Successiva
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Edit Mapping Dialog (simple variant) */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifica Mapping</DialogTitle>
          </DialogHeader>
          {editVariant && (
            <div className="space-y-4">
              <div>
                <Label className="text-xs text-muted-foreground">SKU Shopify</Label>
                <p className="font-mono">{editVariant.channelSku}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Nome Shopify</Label>
                <p>{editVariant.displayName}</p>
              </div>
              <div className="space-y-2">
                <Label>Prodotto Interno</Label>
                <Select value={editProductId} onValueChange={setEditProductId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleziona prodotto..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— Nessun prodotto —</SelectItem>
                    {productsList?.map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.sku})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Multiplier (pezzi interni per 1 unità Shopify)</Label>
                <Input
                  type="number"
                  min="1"
                  value={editMultiplier}
                  onChange={(e) => setEditMultiplier(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Es: se 1 variante Shopify = 6 confezioni interne, inserisci 6
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditDialogOpen(false)}>
              Annulla
            </Button>
            <Button onClick={handleSaveMapping} disabled={updateMappingMutation.isPending}>
              {updateMappingMutation.isPending ? "Salvataggio..." : "Salva"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bundle Editor Dialog */}
      <Dialog open={bundleDialogOpen} onOpenChange={setBundleDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5" />
              Componenti bundle: {bundleVariant?.displayName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Definisci i prodotti interni che compongono questo bundle Shopify.
              Lo stock del bundle sarà calcolato come il minimo tra i componenti.
            </p>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prodotto</TableHead>
                  <TableHead className="w-[100px]">Quantità</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeComponents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-4 text-muted-foreground">
                      Nessun componente. Clicca "Aggiungi componente" per iniziare.
                    </TableCell>
                  </TableRow>
                ) : (
                  activeComponents.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Select
                          value={c.productId || "__none__"}
                          onValueChange={(v) =>
                            updateComponent(i, "productId", v === "__none__" ? "" : v)
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Seleziona prodotto..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">— Seleziona —</SelectItem>
                            {productsList?.map((p: any) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name} ({p.sku})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={1}
                          value={c.quantity}
                          onChange={(e) =>
                            updateComponent(i, "quantity", parseInt(e.target.value) || 1)
                          }
                          className="w-[80px]"
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeComponent(i)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>

            <Button variant="outline" size="sm" onClick={addComponent} className="gap-1">
              <Plus className="h-4 w-4" />
              Aggiungi componente
            </Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBundleDialogOpen(false)}>
              Annulla
            </Button>
            <Button onClick={handleSaveBundle} disabled={setBundleMutation.isPending}>
              {setBundleMutation.isPending ? "Salvataggio..." : "Salva Bundle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
