import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, Save } from "lucide-react";

export default function AffiliateForm() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const isEdit = params.id && params.id !== "new";

  const { data: existingAffiliate, isLoading: loadingExisting } =
    trpc.affiliates.getById.useQuery(
      { id: params.id! },
      { enabled: !!isEdit }
    );

  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    referralCode: "",
    firstOrderRate: "10.00",
    recurringRate: "5.00",
    status: "active" as "active" | "inactive",
    taxCode: "",
    vatNumber: "",
    iban: "",
    notes: "",
  });

  useEffect(() => {
    if (existingAffiliate) {
      setForm({
        name: existingAffiliate.name || "",
        email: existingAffiliate.email || "",
        phone: existingAffiliate.phone || "",
        referralCode: existingAffiliate.referralCode || "",
        firstOrderRate: String(existingAffiliate.firstOrderRate ?? "10.00"),
        recurringRate: String(existingAffiliate.recurringRate ?? "5.00"),
        status: existingAffiliate.status || "active",
        taxCode: existingAffiliate.taxCode || "",
        vatNumber: existingAffiliate.vatNumber || "",
        iban: existingAffiliate.iban || "",
        notes: existingAffiliate.notes || "",
      });
    }
  }, [existingAffiliate]);

  const createMutation = trpc.affiliates.create.useMutation({
    onSuccess: (data) => {
      toast.success("Affiliato creato con successo");
      navigate(`/affiliates/${data.id}`);
    },
    onError: (err) => {
      toast.error("Errore: " + err.message);
    },
  });

  const updateMutation = trpc.affiliates.update.useMutation({
    onSuccess: () => {
      toast.success("Affiliato aggiornato");
      navigate(`/affiliates/${params.id}`);
    },
    onError: (err) => {
      toast.error("Errore: " + err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name: form.name,
      email: form.email,
      phone: form.phone || undefined,
      referralCode: form.referralCode,
      firstOrderRate: parseFloat(form.firstOrderRate),
      recurringRate: parseFloat(form.recurringRate),
      taxCode: form.taxCode || undefined,
      vatNumber: form.vatNumber || undefined,
      iban: form.iban || undefined,
      notes: form.notes || undefined,
    };
    if (isEdit) {
      updateMutation.mutate({ id: params.id!, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  if (isEdit && loadingExisting) {
    return <div className="text-center py-8 text-muted-foreground">Caricamento...</div>;
  }

  return (
    <DashboardLayout>
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/affiliates")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">
            {isEdit ? "Modifica Affiliato" : "Nuovo Affiliato"}
          </h1>
          <p className="text-muted-foreground">
            {isEdit ? "Aggiorna i dati dell'affiliato" : "Registra un nuovo affiliato nel programma"}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Dati Anagrafici */}
        <Card>
          <CardHeader>
            <CardTitle>Dati Anagrafici</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Nome *</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  placeholder="Mario Rossi"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                  placeholder="mario@example.com"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Telefono</Label>
                <Input
                  id="phone"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="+39 333 1234567"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="taxCode">Codice Fiscale</Label>
                <Input
                  id="taxCode"
                  value={form.taxCode}
                  onChange={(e) => setForm({ ...form, taxCode: e.target.value })}
                  placeholder="RSSMRA80A01H501Z"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vatNumber">Partita IVA</Label>
                <Input
                  id="vatNumber"
                  value={form.vatNumber}
                  onChange={(e) => setForm({ ...form, vatNumber: e.target.value })}
                  placeholder="IT01234567890"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Programma Affiliazione */}
        <Card>
          <CardHeader>
            <CardTitle>Programma Affiliazione</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="referralCode">Codice Referral *</Label>
                <Input
                  id="referralCode"
                  value={form.referralCode}
                  onChange={(e) => setForm({ ...form, referralCode: e.target.value.toUpperCase() })}
                  required
                  placeholder="MARIO2026"
                />
                <p className="text-xs text-muted-foreground">
                  Codice univoco per tracciare i referral
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Stato</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Attivo</SelectItem>
                    <SelectItem value="inactive">Inattivo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstOrderRate">% Primo Ordine</Label>
                <Input
                  id="firstOrderRate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.firstOrderRate}
                  onChange={(e) => setForm({ ...form, firstOrderRate: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Commissione sul primo ordine di ogni rivenditore
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="recurringRate">% Ordini Ricorrenti</Label>
                <Input
                  id="recurringRate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.recurringRate}
                  onChange={(e) => setForm({ ...form, recurringRate: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Commissione sugli ordini successivi
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Pagamento */}
        <Card>
          <CardHeader>
            <CardTitle>Dati Pagamento</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="iban">IBAN</Label>
              <Input
                id="iban"
                value={form.iban}
                onChange={(e) => setForm({ ...form, iban: e.target.value.replace(/\s/g, "").toUpperCase() })}
                placeholder="IT60X0542811101000000123456"
              />
              <p className="text-xs text-muted-foreground">
                Per il pagamento delle commissioni
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Note */}
        <Card>
          <CardHeader>
            <CardTitle>Note</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Note interne sull'affiliato..."
              rows={3}
            />
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/affiliates")}
          >
            Annulla
          </Button>
          <Button type="submit" disabled={isPending}>
            <Save className="mr-2 h-4 w-4" />
            {isPending ? "Salvataggio..." : isEdit ? "Aggiorna" : "Crea Affiliato"}
          </Button>
        </div>
      </form>
    </div>
    </DashboardLayout>
  );
}
