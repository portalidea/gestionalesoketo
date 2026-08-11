/**
 * F16 Admin — Promotions Management Page
 * CRUD for promotional banners visible in the Partner Portal.
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import {
  Calendar,
  Edit,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";

interface PromoForm {
  title: string;
  description: string;
  discountPercent: string;
  productId: string;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  bannerColor: string;
}

const EMPTY_FORM: PromoForm = {
  title: "",
  description: "",
  discountPercent: "",
  productId: "",
  validFrom: new Date().toISOString().split("T")[0],
  validTo: "",
  isActive: true,
  bannerColor: "#7AB648",
};

const COLOR_PRESETS = [
  { label: "Verde SoKeto", value: "#7AB648" },
  { label: "Verde scuro", value: "#2D5A27" },
  { label: "Arancione", value: "#e65100" },
  { label: "Rosso", value: "#dc2626" },
  { label: "Blu", value: "#1d4ed8" },
  { label: "Viola", value: "#7c3aed" },
  { label: "Oro", value: "#b45309" },
  { label: "Teal", value: "#0d9488" },
];

export default function Promotions() {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const promosQuery = trpc.promotions.list.useQuery(undefined, {
    enabled: Boolean(user),
  });
  const productsQuery = trpc.products.list.useQuery(undefined, {
    enabled: Boolean(user),
  });

  const createMutation = trpc.promotions.create.useMutation({
    onSuccess: () => {
      utils.promotions.list.invalidate();
      toast.success("Promozione creata");
      setDialogOpen(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.promotions.update.useMutation({
    onSuccess: () => {
      utils.promotions.list.invalidate();
      toast.success("Promozione aggiornata");
      setDialogOpen(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.promotions.delete.useMutation({
    onSuccess: () => {
      utils.promotions.list.invalidate();
      toast.success("Promozione eliminata");
    },
    onError: (err) => toast.error(err.message),
  });

  const toggleMutation = trpc.promotions.toggleActive.useMutation({
    onSuccess: () => {
      utils.promotions.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PromoForm>(EMPTY_FORM);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(promo: any) {
    setEditingId(promo.id);
    setForm({
      title: promo.title,
      description: promo.description ?? "",
      discountPercent: promo.discountPercent ?? "",
      productId: promo.productId ?? "",
      validFrom: promo.validFrom ? promo.validFrom.split("T")[0] : "",
      validTo: promo.validTo ? promo.validTo.split("T")[0] : "",
      isActive: promo.isActive,
      bannerColor: promo.bannerColor ?? "#7AB648",
    });
    setDialogOpen(true);
  }

  function handleSubmit() {
    if (!form.title || !form.validTo) {
      toast.error("Titolo e data fine sono obbligatori");
      return;
    }
    const payload = {
      title: form.title,
      description: form.description,
      discountPercent: form.discountPercent ? parseFloat(form.discountPercent) : null,
      productId: form.productId || null,
      validFrom: form.validFrom || new Date().toISOString(),
      validTo: form.validTo,
      isActive: form.isActive,
      bannerColor: form.bannerColor,
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const promos = promosQuery.data ?? [];
  const productsList = productsQuery.data ?? [];
  const now = new Date();

  function getStatus(promo: any): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
    if (!promo.isActive) return { label: "Disattivata", variant: "secondary" };
    const from = new Date(promo.validFrom);
    const to = new Date(promo.validTo);
    if (now < from) return { label: "Programmata", variant: "outline" };
    if (now > to) return { label: "Scaduta", variant: "destructive" };
    return { label: "Attiva", variant: "default" };
  }

  if (!user) return null;

  return (
    <DashboardLayout>
      <div className="container py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Gestione Promozioni</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Crea e gestisci i banner promozionali visibili nel portale partner dei rivenditori
            </p>
          </div>
          <Button onClick={openCreate} className="bg-[#7AB648] hover:bg-[#6aa03d]">
            <Plus className="h-4 w-4 mr-1" /> Nuova Promozione
          </Button>
        </div>

        {/* Banner Preview */}
        {promos.filter((p) => getStatus(p).label === "Attiva").length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Anteprima Banner Attivi (come li vedono i rivenditori)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {promos
                .filter((p) => getStatus(p).label === "Attiva")
                .map((promo) => (
                  <div
                    key={promo.id}
                    className="relative overflow-hidden rounded-xl p-4 text-white"
                    style={{ backgroundColor: promo.bannerColor || "#7AB648" }}
                  >
                    <div className="flex items-center gap-3">
                      <Sparkles className="h-6 w-6 flex-shrink-0" />
                      <div className="flex-1">
                        <h3 className="font-bold text-lg">{promo.title}</h3>
                        <p className="text-white/90 text-sm">{promo.description}</p>
                        {promo.discountPercent && (
                          <Badge className="mt-1 bg-white/20 text-white border-white/30">
                            -{promo.discountPercent}%
                          </Badge>
                        )}
                      </div>
                      <div className="text-right text-xs text-white/70">
                        <Calendar className="h-3 w-3 inline mr-1" />
                        Fino al {new Date(promo.validTo).toLocaleDateString("it-IT")}
                      </div>
                    </div>
                  </div>
                ))}
            </CardContent>
          </Card>
        )}

        {/* Table */}
        {promosQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : promos.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Sparkles className="h-12 w-12 text-muted-foreground/40 mb-4" />
              <h3 className="text-lg font-semibold mb-2">Nessuna promozione</h3>
              <p className="text-muted-foreground max-w-md">
                Crea la prima promozione per mostrarla nel portale partner dei rivenditori.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Titolo</TableHead>
                  <TableHead>Prodotto</TableHead>
                  <TableHead>Sconto</TableHead>
                  <TableHead>Periodo</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead>Attiva</TableHead>
                  <TableHead className="text-right">Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {promos.map((promo) => {
                  const status = getStatus(promo);
                  return (
                    <TableRow key={promo.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: promo.bannerColor || "#7AB648" }}
                          />
                          <span className="font-medium">{promo.title}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {promo.productName ?? "Tutti"}
                      </TableCell>
                      <TableCell>
                        {promo.discountPercent ? (
                          <Badge variant="outline">-{promo.discountPercent}%</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {new Date(promo.validFrom).toLocaleDateString("it-IT")} →{" "}
                        {new Date(promo.validTo).toLocaleDateString("it-IT")}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={promo.isActive}
                          onCheckedChange={(checked) =>
                            toggleMutation.mutate({ id: promo.id, isActive: checked })
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(promo)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm("Eliminare questa promozione?")) {
                                deleteMutation.mutate({ id: promo.id });
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}

        {/* Create/Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editingId ? "Modifica Promozione" : "Nuova Promozione"}
              </DialogTitle>
              <DialogDescription>
                {editingId
                  ? "Modifica i dettagli della promozione."
                  : "Crea un nuovo banner promozionale per il portale partner."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Banner Preview */}
              <div
                className="rounded-xl p-4 text-white"
                style={{ backgroundColor: form.bannerColor || "#7AB648" }}
              >
                <div className="flex items-center gap-3">
                  <Sparkles className="h-5 w-5 flex-shrink-0" />
                  <div>
                    <h3 className="font-bold">{form.title || "Titolo promozione"}</h3>
                    <p className="text-white/90 text-sm">{form.description || "Descrizione..."}</p>
                    {form.discountPercent && (
                      <Badge className="mt-1 bg-white/20 text-white border-white/30 text-xs">
                        -{form.discountPercent}%
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid gap-3">
                <div>
                  <Label>Titolo *</Label>
                  <Input
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="Es: Promo Estate -20% Biscotti"
                  />
                </div>

                <div>
                  <Label>Descrizione</Label>
                  <Input
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Es: Sconto su tutta la linea biscotti"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Sconto %</Label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={form.discountPercent}
                      onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                      placeholder="Es: 20"
                    />
                  </div>
                  <div>
                    <Label>Prodotto (opzionale)</Label>
                    <Select
                      value={form.productId || "all"}
                      onValueChange={(v) => setForm({ ...form, productId: v === "all" ? "" : v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Tutti i prodotti" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Tutti i prodotti</SelectItem>
                        {productsList.map((p: any) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Data inizio *</Label>
                    <Input
                      type="date"
                      value={form.validFrom}
                      onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Data fine *</Label>
                    <Input
                      type="date"
                      value={form.validTo}
                      onChange={(e) => setForm({ ...form, validTo: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <Label>Colore Banner</Label>
                  <div className="flex items-center gap-2 mt-1">
                    {COLOR_PRESETS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        className={`w-7 h-7 rounded-full border-2 transition-all ${
                          form.bannerColor === c.value ? "border-foreground scale-110" : "border-transparent"
                        }`}
                        style={{ backgroundColor: c.value }}
                        onClick={() => setForm({ ...form, bannerColor: c.value })}
                        title={c.label}
                      />
                    ))}
                    <Input
                      type="color"
                      value={form.bannerColor}
                      onChange={(e) => setForm({ ...form, bannerColor: e.target.value })}
                      className="w-8 h-8 p-0 border-0 cursor-pointer"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.isActive}
                    onCheckedChange={(checked) => setForm({ ...form, isActive: checked })}
                  />
                  <Label>Attiva immediatamente</Label>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Annulla
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-[#7AB648] hover:bg-[#6aa03d]"
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                )}
                {editingId ? "Salva Modifiche" : "Crea Promozione"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
