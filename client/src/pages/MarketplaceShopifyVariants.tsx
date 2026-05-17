import { useState, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Package, RefreshCw, Search, Edit2 } from "lucide-react";

export default function MarketplaceShopifyVariants() {
  const searchString = useSearch();
  const params = useMemo(() => new URLSearchParams(searchString), [searchString]);
  const initialUnmapped = params.get("unmapped") === "true";

  const [search, setSearch] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(initialUnmapped);
  const [page, setPage] = useState(0);
  const pageSize = 25;

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

  // Edit dialog state
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
                  <TableHead>Prodotto Interno</TableHead>
                  <TableHead className="text-center">Multiplier</TableHead>
                  <TableHead className="text-center">Stato</TableHead>
                  <TableHead className="text-right">Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      Caricamento...
                    </TableCell>
                  </TableRow>
                ) : data?.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      Nessuna variante trovata
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.items.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-sm">{v.channelSku}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{v.displayName}</TableCell>
                      <TableCell>
                        {v.productName ? (
                          <span className="text-sm">
                            {v.productName}{" "}
                            <span className="text-muted-foreground">({v.productSku})</span>
                          </span>
                        ) : (
                          <Badge variant="destructive" className="text-xs">Non mappato</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center">{v.multiplier}×</TableCell>
                      <TableCell className="text-center">
                        <Badge variant={v.isActive ? "default" : "secondary"}>
                          {v.isActive ? "Attivo" : "Disattivo"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(v)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
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

      {/* Edit Mapping Dialog */}
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
    </DashboardLayout>
  );
}
