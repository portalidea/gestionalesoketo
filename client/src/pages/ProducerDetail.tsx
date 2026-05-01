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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Factory, Loader2, Save, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useLocation, useRoute } from "wouter";

type FormState = {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  vatNumber: string;
  address: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  contactName: "",
  email: "",
  phone: "",
  vatNumber: "",
  address: "",
  notes: "",
};

export default function ProducerDetail() {
  const [, params] = useRoute("/producers/:id");
  const [, setLocation] = useLocation();
  const producerId = params?.id ?? "";
  const utils = trpc.useUtils();

  const { data: producer, isLoading } = trpc.producers.getById.useQuery(
    { id: producerId },
    { enabled: producerId.length > 0 },
  );

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (producer) {
      setForm({
        name: producer.name ?? "",
        contactName: producer.contactName ?? "",
        email: producer.email ?? "",
        phone: producer.phone ?? "",
        vatNumber: producer.vatNumber ?? "",
        address: producer.address ?? "",
        notes: producer.notes ?? "",
      });
    }
  }, [producer]);

  const updateMutation = trpc.producers.update.useMutation({
    onSuccess: async () => {
      await utils.producers.list.invalidate();
      await utils.producers.getById.invalidate({ id: producerId });
      toast.success("Produttore aggiornato");
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.producers.delete.useMutation({
    onSuccess: async () => {
      await utils.producers.list.invalidate();
      toast.success("Produttore eliminato");
      setLocation("/producers");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    updateMutation.mutate({
      id: producerId,
      name: form.name,
      contactName: form.contactName || undefined,
      email: form.email || undefined,
      phone: form.phone || undefined,
      vatNumber: form.vatNumber || undefined,
      address: form.address || undefined,
      notes: form.notes || undefined,
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

  if (!producer) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Button variant="ghost" onClick={() => setLocation("/producers")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Torna ai Produttori
          </Button>
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Factory className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Produttore non trovato
              </h3>
              <p className="text-muted-foreground">
                Il produttore richiesto non esiste o è stato eliminato.
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
              onClick={() => setLocation("/producers")}
              className="mb-3"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Torna ai Produttori
            </Button>
            <h1 className="text-3xl font-bold text-foreground">{producer.name}</h1>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label="Elimina produttore"
              >
                <Trash2 className="h-5 w-5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Eliminare il produttore?</AlertDialogTitle>
                <AlertDialogDescription>
                  Stai eliminando <strong>{producer.name}</strong>. I lotti già
                  registrati che lo riferiscono manterranno lo storico ma perderanno
                  l'associazione (campo produttore vuoto). L'operazione è
                  irreversibile.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Annulla</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => deleteMutation.mutate({ id: producerId })}
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
              <CardTitle>Anagrafica produttore</CardTitle>
              <CardDescription>
                Solo il nome è obbligatorio. Gli altri campi sono opzionali.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Nome *</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="contactName">Persona di contatto</Label>
                  <Input
                    id="contactName"
                    value={form.contactName}
                    onChange={(e) =>
                      setForm({ ...form, contactName: e.target.value })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="vatNumber">Partita IVA</Label>
                  <Input
                    id="vatNumber"
                    value={form.vatNumber}
                    onChange={(e) =>
                      setForm({ ...form, vatNumber: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="phone">Telefono</Label>
                  <Input
                    id="phone"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="address">Indirizzo</Label>
                <Textarea
                  id="address"
                  rows={2}
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="notes">Note</Label>
                <Textarea
                  id="notes"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setLocation("/producers")}
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
