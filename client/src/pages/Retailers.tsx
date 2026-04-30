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
import { trpc } from "@/lib/trpc";
import { Loader2, Plus, Store, MapPin, Phone, Mail, User } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

export default function Retailers() {
  const { data: retailers, isLoading } = trpc.retailers.list.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const utils = trpc.useUtils();

  const createMutation = trpc.retailers.create.useMutation({
    onSuccess: () => {
      utils.retailers.list.invalidate();
      setDialogOpen(false);
      toast.success("Rivenditore creato con successo");
      setFormData({
        name: "",
        businessType: "",
        address: "",
        city: "",
        province: "",
        postalCode: "",
        phone: "",
        email: "",
        contactPerson: "",
        notes: "",
      });
    },
    onError: (error) => {
      toast.error("Errore nella creazione del rivenditore");
    },
  });

  const [formData, setFormData] = useState({
    name: "",
    businessType: "",
    address: "",
    city: "",
    province: "",
    postalCode: "",
    phone: "",
    email: "",
    contactPerson: "",
    notes: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(formData);
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Rivenditori</h1>
            <p className="text-muted-foreground">
              Gestisci l'anagrafica dei punti vendita SoKeto
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="lg">
                <Plus className="h-5 w-5 mr-2" />
                Nuovo Rivenditore
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <DialogHeader>
                  <DialogTitle>Nuovo Rivenditore</DialogTitle>
                  <DialogDescription>
                    Inserisci i dati del nuovo punto vendita
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Nome *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="businessType">Tipo Attività</Label>
                    <Input
                      id="businessType"
                      placeholder="es. Ristorante, Farmacia, Negozio"
                      value={formData.businessType}
                      onChange={(e) =>
                        setFormData({ ...formData, businessType: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="address">Indirizzo</Label>
                    <Input
                      id="address"
                      value={formData.address}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="city">Città</Label>
                      <Input
                        id="city"
                        value={formData.city}
                        onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="province">Provincia</Label>
                      <Input
                        id="province"
                        maxLength={2}
                        placeholder="es. MI"
                        value={formData.province}
                        onChange={(e) =>
                          setFormData({ ...formData, province: e.target.value.toUpperCase() })
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="postalCode">CAP</Label>
                      <Input
                        id="postalCode"
                        value={formData.postalCode}
                        onChange={(e) =>
                          setFormData({ ...formData, postalCode: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="phone">Telefono</Label>
                      <Input
                        id="phone"
                        type="tel"
                        value={formData.phone}
                        onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="contactPerson">Persona di Contatto</Label>
                    <Input
                      id="contactPerson"
                      value={formData.contactPerson}
                      onChange={(e) =>
                        setFormData({ ...formData, contactPerson: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="notes">Note</Label>
                    <Textarea
                      id="notes"
                      value={formData.notes}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      rows={3}
                    />
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

        {/* Retailers List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : retailers && retailers.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {retailers.map((retailer) => (
              <Link key={retailer.id} href={`/retailers/${retailer.id}`}>
                <Card className="border-border bg-card hover:border-primary transition-colors cursor-pointer h-full">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-12 w-12 rounded-lg bg-primary/20 flex items-center justify-center">
                          <Store className="h-6 w-6 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-lg text-foreground">
                            {retailer.name}
                          </CardTitle>
                          {retailer.businessType && (
                            <CardDescription className="text-sm">
                              {retailer.businessType}
                            </CardDescription>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {retailer.address && (
                      <div className="flex items-start gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>
                          {retailer.address}
                          {retailer.city && `, ${retailer.city}`}
                          {retailer.province && ` (${retailer.province})`}
                        </span>
                      </div>
                    )}
                    {retailer.phone && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Phone className="h-4 w-4 shrink-0" />
                        <span>{retailer.phone}</span>
                      </div>
                    )}
                    {retailer.email && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Mail className="h-4 w-4 shrink-0" />
                        <span className="truncate">{retailer.email}</span>
                      </div>
                    )}
                    {retailer.contactPerson && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <User className="h-4 w-4 shrink-0" />
                        <span>{retailer.contactPerson}</span>
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
              <Store className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Nessun rivenditore registrato
              </h3>
              <p className="text-muted-foreground mb-6 text-center max-w-md">
                Inizia aggiungendo il primo punto vendita per gestire l'inventario
              </p>
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="h-5 w-5 mr-2" />
                Aggiungi Rivenditore
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
