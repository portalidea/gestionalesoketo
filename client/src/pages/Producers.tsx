import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Factory, Loader2, Mail, Phone, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

const EMPTY_FORM = {
  name: "",
  contactName: "",
  email: "",
  phone: "",
  vatNumber: "",
  address: "",
  notes: "",
};

export default function Producers() {
  const { data: producers, isLoading } = trpc.producers.list.useQuery();
  const utils = trpc.useUtils();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const createMutation = trpc.producers.create.useMutation({
    onSuccess: async () => {
      await utils.producers.list.invalidate();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success("Produttore creato");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    createMutation.mutate({
      name: form.name,
      contactName: form.contactName || undefined,
      email: form.email || undefined,
      phone: form.phone || undefined,
      vatNumber: form.vatNumber || undefined,
      address: form.address || undefined,
      notes: form.notes || undefined,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Produttori</h1>
            <p className="text-muted-foreground">
              Anagrafica produttori che riforniscono il magazzino centrale SoKeto
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="lg">
                <Plus className="h-5 w-5 mr-2" />
                Nuovo Produttore
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <DialogHeader>
                  <DialogTitle>Nuovo Produttore</DialogTitle>
                  <DialogDescription>
                    Inserisci i dati del produttore. Solo il nome è obbligatorio.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
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
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
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
        ) : producers && producers.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {producers.map((p) => (
              <Link key={p.id} href={`/producers/${p.id}`}>
                <Card className="border-border bg-card hover:border-primary transition-colors cursor-pointer h-full">
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                        <Factory className="h-6 w-6 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-lg text-foreground truncate">
                          {p.name}
                        </CardTitle>
                        {p.contactName && (
                          <CardDescription className="text-sm truncate">
                            {p.contactName}
                          </CardDescription>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {p.email && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Mail className="h-4 w-4 shrink-0" />
                        <span className="truncate">{p.email}</span>
                      </div>
                    )}
                    {p.phone && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Phone className="h-4 w-4 shrink-0" />
                        <span>{p.phone}</span>
                      </div>
                    )}
                    {p.vatNumber && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">P.IVA:</span>{" "}
                        <span className="text-foreground">{p.vatNumber}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Factory className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Nessun produttore registrato
              </h3>
              <p className="text-muted-foreground mb-6 text-center max-w-md">
                Aggiungi i produttori che riforniscono il magazzino centrale.
              </p>
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="h-5 w-5 mr-2" />
                Aggiungi produttore
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
