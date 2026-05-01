import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { Loader2, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type EditState = {
  id: string;
  name: string;
  discountPercent: string;
  description: string;
  sortOrder: number;
} | null;

export default function Packages() {
  const { user: me } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const { data: packages, isLoading } = trpc.pricingPackages.list.useQuery();

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    discountPercent: "",
    description: "",
    sortOrder: 99,
  });
  const [edit, setEdit] = useState<EditState>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const createMut = trpc.pricingPackages.create.useMutation({
    onSuccess: () => {
      utils.pricingPackages.list.invalidate();
      setCreateOpen(false);
      setCreateForm({ name: "", discountPercent: "", description: "", sortOrder: 99 });
      toast.success("Pacchetto creato");
    },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.pricingPackages.update.useMutation({
    onSuccess: () => {
      utils.pricingPackages.list.invalidate();
      setEdit(null);
      toast.success("Pacchetto aggiornato");
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.pricingPackages.delete.useMutation({
    onSuccess: () => {
      utils.pricingPackages.list.invalidate();
      utils.retailers.list.invalidate();
      setDeleteId(null);
      toast.success("Pacchetto eliminato");
    },
    onError: (e) => toast.error(e.message),
  });

  if (me && me.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <p className="text-muted-foreground">Accesso riservato agli amministratori.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Pacchetti commerciali</h1>
            <p className="text-muted-foreground">
              Sconti fissi applicati al prezzo base dei prodotti per generare proforma su retailer.
            </p>
          </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="lg">
                <Plus className="h-5 w-5 mr-2" />
                Nuovo Pacchetto
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const discount = parseFloat(createForm.discountPercent);
                  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
                    toast.error("Sconto deve essere fra 0 e 100");
                    return;
                  }
                  createMut.mutate({
                    name: createForm.name,
                    discountPercent: discount,
                    description: createForm.description || undefined,
                    sortOrder: createForm.sortOrder,
                  });
                }}
              >
                <DialogHeader>
                  <DialogTitle>Nuovo pacchetto</DialogTitle>
                  <DialogDescription>
                    Sconto fisso applicato a tutti i prodotti per i retailer assegnati.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Nome *</Label>
                    <Input
                      id="name"
                      required
                      maxLength={100}
                      value={createForm.name}
                      onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="discount">Sconto % *</Label>
                      <Input
                        id="discount"
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        required
                        value={createForm.discountPercent}
                        onChange={(e) =>
                          setCreateForm({ ...createForm, discountPercent: e.target.value })
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="sortOrder">Ordine</Label>
                      <Input
                        id="sortOrder"
                        type="number"
                        value={createForm.sortOrder}
                        onChange={(e) =>
                          setCreateForm({
                            ...createForm,
                            sortOrder: parseInt(e.target.value) || 0,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="description">Descrizione</Label>
                    <Textarea
                      id="description"
                      rows={2}
                      value={createForm.description}
                      onChange={(e) =>
                        setCreateForm({ ...createForm, description: e.target.value })
                      }
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                    Annulla
                  </Button>
                  <Button type="submit" disabled={createMut.isPending}>
                    {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Crea
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
        ) : packages && packages.length > 0 ? (
          <Card className="border-border bg-card">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead className="text-right">Sconto %</TableHead>
                    <TableHead>Descrizione</TableHead>
                    <TableHead className="text-right">Ordine</TableHead>
                    <TableHead className="text-right">Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {packages.map((pkg) => (
                    <TableRow key={pkg.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <Tag className="h-4 w-4 text-primary shrink-0" />
                          {pkg.name}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        -{pkg.discountPercent}%
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {pkg.description ?? "-"}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {pkg.sortOrder}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              setEdit({
                                id: pkg.id,
                                name: pkg.name,
                                discountPercent: pkg.discountPercent,
                                description: pkg.description ?? "",
                                sortOrder: pkg.sortOrder,
                              })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteId(pkg.id)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Tag className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Nessun pacchetto configurato
              </h3>
              <p className="text-muted-foreground mb-6 text-center max-w-md">
                Crea pacchetti commerciali per assegnare sconti fissi ai rivenditori.
              </p>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-5 w-5 mr-2" />
                Crea Pacchetto
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Edit dialog */}
        <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
          <DialogContent>
            {edit && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const discount = parseFloat(edit.discountPercent);
                  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
                    toast.error("Sconto deve essere fra 0 e 100");
                    return;
                  }
                  updateMut.mutate({
                    id: edit.id,
                    name: edit.name,
                    discountPercent: discount,
                    description: edit.description || null,
                    sortOrder: edit.sortOrder,
                  });
                }}
              >
                <DialogHeader>
                  <DialogTitle>Modifica pacchetto</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="ename">Nome *</Label>
                    <Input
                      id="ename"
                      required
                      value={edit.name}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="ediscount">Sconto % *</Label>
                      <Input
                        id="ediscount"
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        required
                        value={edit.discountPercent}
                        onChange={(e) =>
                          setEdit({ ...edit, discountPercent: e.target.value })
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="esort">Ordine</Label>
                      <Input
                        id="esort"
                        type="number"
                        value={edit.sortOrder}
                        onChange={(e) =>
                          setEdit({ ...edit, sortOrder: parseInt(e.target.value) || 0 })
                        }
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="edesc">Descrizione</Label>
                    <Textarea
                      id="edesc"
                      rows={2}
                      value={edit.description}
                      onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setEdit(null)}>
                    Annulla
                  </Button>
                  <Button type="submit" disabled={updateMut.isPending}>
                    {updateMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Salva
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>

        {/* Delete confirm */}
        <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Eliminare il pacchetto?</AlertDialogTitle>
              <AlertDialogDescription>
                I retailer associati resteranno senza pacchetto e non potranno generare
                proforma fino a riassegnazione.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteId && deleteMut.mutate({ id: deleteId })}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Elimina
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
