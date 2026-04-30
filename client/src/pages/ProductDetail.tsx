import DashboardLayout from "@/components/DashboardLayout";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { ArrowLeft, Loader2, Package, Save, Trash2 } from "lucide-react";
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
  minStockThreshold: number;
  expiryWarningDays: number;
  isLowCarb: boolean;
  isGlutenFree: boolean;
  isKeto: boolean;
  imageUrl: string;
};

const EMPTY_FORM: FormState = {
  sku: "",
  name: "",
  description: "",
  category: "",
  supplierName: "",
  unitPrice: "",
  unit: "",
  minStockThreshold: 10,
  expiryWarningDays: 30,
  isLowCarb: true,
  isGlutenFree: true,
  isKeto: true,
  imageUrl: "",
};

export default function ProductDetail() {
  const [, params] = useRoute("/products/:id");
  const [, setLocation] = useLocation();
  const productId = params?.id ?? "";
  const utils = trpc.useUtils();

  const { data: product, isLoading } = trpc.products.getById.useQuery(
    { id: productId },
    { enabled: productId.length > 0 },
  );

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
        minStockThreshold: product.minStockThreshold ?? 10,
        expiryWarningDays: product.expiryWarningDays ?? 30,
        isLowCarb: product.isLowCarb === 1,
        isGlutenFree: product.isGlutenFree === 1,
        isKeto: product.isKeto === 1,
        imageUrl: product.imageUrl ?? "",
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
      minStockThreshold: form.minStockThreshold,
      expiryWarningDays: form.expiryWarningDays,
      isLowCarb: form.isLowCarb ? 1 : 0,
      isGlutenFree: form.isGlutenFree ? 1 : 0,
      isKeto: form.isKeto ? 1 : 0,
      imageUrl: form.imageUrl || undefined,
    });
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
      </div>
    </DashboardLayout>
  );
}
