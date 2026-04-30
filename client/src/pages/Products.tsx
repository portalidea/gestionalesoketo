import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2, Plus, Package, Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Products() {
  const { data: products, isLoading } = trpc.products.list.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const utils = trpc.useUtils();

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
      });
    },
    onError: (error) => {
      toast.error("Errore nella creazione del prodotto");
    },
  });

  const [formData, setFormData] = useState({
    sku: "",
    name: "",
    description: "",
    category: "",
    supplierName: "",
    unitPrice: "",
    unit: "",
    minStockThreshold: 10,
    expiryWarningDays: 30,
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

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Prodotti</h1>
            <p className="text-muted-foreground">
              Gestisci il catalogo prodotti SoKeto
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

        {/* Products List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : products && products.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {products.map((product) => (
              <Card key={product.id} className="border-border bg-card hover:border-primary transition-colors">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 rounded-lg bg-primary/20 flex items-center justify-center">
                        <Package className="h-6 w-6 text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-lg text-foreground">
                          {product.name}
                        </CardTitle>
                        <CardDescription className="text-sm">
                          SKU: {product.sku}
                        </CardDescription>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {product.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {product.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {product.isLowCarb === 1 && (
                      <Badge variant="secondary" className="text-xs">
                        <Check className="h-3 w-3 mr-1" />
                        Low Carb
                      </Badge>
                    )}
                    {product.isGlutenFree === 1 && (
                      <Badge variant="secondary" className="text-xs">
                        <Check className="h-3 w-3 mr-1" />
                        Gluten Free
                      </Badge>
                    )}
                    {product.isKeto === 1 && (
                      <Badge variant="secondary" className="text-xs">
                        <Check className="h-3 w-3 mr-1" />
                        Keto
                      </Badge>
                    )}
                  </div>
                  {product.category && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Categoria:</span>{" "}
                      <span className="text-foreground">{product.category}</span>
                    </div>
                  )}
                  {product.unitPrice && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Prezzo:</span>{" "}
                      <span className="text-foreground font-semibold">
                        €{product.unitPrice}
                        {product.unit && ` / ${product.unit}`}
                      </span>
                    </div>
                  )}
                  {product.supplierName && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Fornitore:</span>{" "}
                      <span className="text-foreground">{product.supplierName}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
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
