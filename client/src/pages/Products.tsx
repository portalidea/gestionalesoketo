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
import { Loader2, Package, Plus } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function Products() {
  const { data: products, isLoading } = trpc.products.list.useQuery();
  const [, setLocation] = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const utils = trpc.useUtils();

  const [formData, setFormData] = useState<{
    sku: string;
    name: string;
    description: string;
    category: string;
    supplierName: string;
    unitPrice: string;
    unit: string;
    minStockThreshold: number;
    expiryWarningDays: number;
    vatRate: "4.00" | "5.00" | "10.00" | "22.00";
  }>({
    sku: "",
    name: "",
    description: "",
    category: "",
    supplierName: "",
    unitPrice: "",
    unit: "",
    minStockThreshold: 10,
    expiryWarningDays: 30,
    vatRate: "10.00",
  });

  const createMutation = trpc.products.create.useMutation({
    onSuccess: () => {
      utils.products.list.invalidate();
      setDialogOpen(false);
      toast.success("Prodotto creato con successo");
      setFormData({
        sku: "",
        name: "",
        description: "",
        category: "",
        supplierName: "",
        unitPrice: "",
        unit: "",
        minStockThreshold: 10,
        expiryWarningDays: 30,
        vatRate: "10.00",
      });
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      ...formData,
      isLowCarb: 1,
      isGlutenFree: 1,
      isKeto: 1,
      sugarContent: "0%",
    });
  };

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
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="lg">
                <Plus className="h-5 w-5 mr-2" />
                Nuovo Prodotto
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <DialogHeader>
                  <DialogTitle>Nuovo Prodotto</DialogTitle>
                  <DialogDescription>
                    Inserisci i dati del nuovo prodotto SoKeto
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="sku">SKU *</Label>
                      <Input
                        id="sku"
                        value={formData.sku}
                        onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                        required
                      />
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
                  <div className="grid gap-2">
                    <Label htmlFor="name">Nome Prodotto *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="description">Descrizione</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      rows={3}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="supplierName">Fornitore</Label>
                    <Input
                      id="supplierName"
                      value={formData.supplierName}
                      onChange={(e) => setFormData({ ...formData, supplierName: e.target.value })}
                    />
                  </div>
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
                      <Label htmlFor="unit">Unità di Misura</Label>
                      <Input
                        id="unit"
                        placeholder="es. kg, pz, conf"
                        value={formData.unit}
                        onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                      />
                    </div>
                  </div>
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
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Annulla
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
                      <TableHead>Nome</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Categoria</TableHead>
                      <TableHead className="text-right">Prezzo</TableHead>
                      <TableHead className="text-right">IVA</TableHead>
                      <TableHead className="text-right">Min</TableHead>
                      <TableHead className="text-right">Stock centrale</TableHead>
                      <TableHead className="text-right">Stock totale</TableHead>
                      <TableHead className="text-right">Lotti attivi</TableHead>
                      <TableHead>Scadenza più vicina</TableHead>
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
