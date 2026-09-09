import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { Edit, Loader2, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type FormState = {
  title: string;
  publicDescription: string;
  internalNotes: string;
  validFrom: string;
  validTo: string;
  qualifyingTierCode: string;
  grantedTierCode: string;
  isActive: boolean;
};

const dateInputValue = (date: Date) => new Date(date).toISOString().slice(0, 16);
const emptyForm = (): FormState => ({
  title: "",
  publicDescription: "",
  internalNotes: "",
  validFrom: dateInputValue(new Date()),
  validTo: "",
  qualifyingTierCode: "",
  grantedTierCode: "",
  isActive: true,
});

const statusFor = (promotion: { isActive: boolean; validFrom: Date; validTo: Date }) => {
  if (!promotion.isActive) return { label: "Disattivata", variant: "secondary" as const };
  const now = new Date();
  if (new Date(promotion.validFrom) > now) return { label: "Programmata", variant: "outline" as const };
  if (new Date(promotion.validTo) <= now) return { label: "Scaduta", variant: "destructive" as const };
  return { label: "Attiva", variant: "default" as const };
};

export default function ProspectPromotions() {
  const utils = trpc.useUtils();
  const promotionsQuery = trpc.prospectSimulator.adminTierUpgradePromotionList.useQuery();
  const configQuery = trpc.prospectSimulator.adminTierUpgradePromotionConfig.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const tiers = Array.isArray(configQuery.data?.tiers) ? configQuery.data.tiers as Array<{ code: string; name: string; discount_percent: number | string }> : [];

  const invalidate = () => Promise.all([
    utils.prospectSimulator.adminTierUpgradePromotionList.invalidate(),
    utils.prospectSimulator.adminTierUpgradePromotionConfig.invalidate(),
  ]);
  const createMutation = trpc.prospectSimulator.adminCreateTierUpgradePromotion.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Promozione prospect creata"); setDialogOpen(false); },
    onError: (error) => toast.error(error.message),
  });
  const updateMutation = trpc.prospectSimulator.adminUpdateTierUpgradePromotion.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Promozione prospect aggiornata"); setDialogOpen(false); },
    onError: (error) => toast.error(error.message),
  });
  const deactivateMutation = trpc.prospectSimulator.adminDeactivateTierUpgradePromotion.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Promozione prospect disattivata"); },
    onError: (error) => toast.error(error.message),
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setDialogOpen(true);
  };
  const openEdit = (promotion: any) => {
    setEditingId(promotion.id);
    setForm({
      title: promotion.title,
      publicDescription: promotion.publicDescription,
      internalNotes: promotion.internalNotes ?? "",
      validFrom: dateInputValue(promotion.validFrom),
      validTo: dateInputValue(promotion.validTo),
      qualifyingTierCode: promotion.qualifyingTierCode ?? "",
      grantedTierCode: promotion.grantedTierCode ?? "",
      isActive: promotion.isActive,
    });
    setDialogOpen(true);
  };
  const submit = () => {
    if (!form.title || !form.publicDescription || !form.validFrom || !form.validTo || !form.qualifyingTierCode || !form.grantedTierCode) {
      toast.error("Compila tutti i campi obbligatori della promozione");
      return;
    }
    const payload = {
      ...form,
      internalNotes: form.internalNotes || null,
      validFrom: new Date(form.validFrom),
      validTo: new Date(form.validTo),
    };
    if (editingId) updateMutation.mutate({ id: editingId, promotion: payload });
    else createMutation.mutate(payload);
  };
  const mutationPending = createMutation.isPending || updateMutation.isPending;
  const promotions = promotionsQuery.data ?? [];

  return <DashboardLayout><div className="container space-y-6 py-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><h1 className="text-2xl font-bold">Promozioni prospect</h1><p className="mt-1 text-sm text-muted-foreground">Campagne valide sul primo ordine da invito. In questa fase è disponibile soltanto l’upgrade di fascia.</p></div><Button onClick={openCreate} className="bg-[#7AB648] hover:bg-[#6aa03d]"><Plus className="mr-1 h-4 w-4" />Nuova promozione</Button></div>

    <Card className="border-[#7AB648]/50 bg-[#F3F7ED]"><CardContent className="flex gap-3 p-4 text-sm text-[#254521]"><Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[#5D973B]" /><p><strong>Regola di applicazione:</strong> una sola campagna attiva per company nello stesso periodo. Il retailer nascerà con la fascia realmente raggiunta; il primo ordine mantiene i prezzi della fascia promozionale congelati al submit.</p></CardContent></Card>

    {promotionsQuery.isLoading || configQuery.isLoading ? <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div> : promotions.length === 0 ? <Card className="border-dashed"><CardContent className="py-12 text-center"><Sparkles className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" /><h2 className="text-lg font-semibold">Nessuna promozione prospect</h2><p className="mt-2 text-sm text-muted-foreground">Crea una campagna per offrire l’upgrade di fascia a tutti gli inviti aperti nel periodo.</p></CardContent></Card> : <Card><Table><TableHeader><TableRow><TableHead>Campagna</TableHead><TableHead>Upgrade</TableHead><TableHead>Periodo</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader><TableBody>{promotions.map((promotion: any) => { const status = statusFor(promotion); return <TableRow key={promotion.id}><TableCell><p className="font-medium">{promotion.title}</p><p className="max-w-md truncate text-xs text-muted-foreground">{promotion.publicDescription}</p></TableCell><TableCell><Badge variant="outline">{promotion.qualifyingTierCode} → {promotion.grantedTierCode}</Badge></TableCell><TableCell className="text-sm">{new Date(promotion.validFrom).toLocaleString("it-IT")}<br />{new Date(promotion.validTo).toLocaleString("it-IT")}</TableCell><TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell><TableCell className="text-right"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => openEdit(promotion)}><Edit className="h-4 w-4" /><span className="sr-only">Modifica</span></Button>{promotion.isActive && <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={deactivateMutation.isPending} onClick={() => { if (window.confirm("Disattivare questa promozione? Non cambierà gli ordini già inviati.")) deactivateMutation.mutate({ id: promotion.id }); }}>Disattiva</Button>}</div></TableCell></TableRow>; })}</TableBody></Table></Card>}

    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{editingId ? "Modifica promozione prospect" : "Nuova promozione prospect"}</DialogTitle><DialogDescription>Il benefit applicato è solo l’upgrade di fascia del primo ordine.</DialogDescription></DialogHeader><div className="space-y-4"><div><Label>Titolo *</Label><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Es. Benvenuto Partner con prezzi Premium" /></div><div><Label>Testo visibile al prospect *</Label><textarea className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" value={form.publicDescription} onChange={(event) => setForm({ ...form, publicDescription: event.target.value })} placeholder="Spiega con chiarezza la condizione del primo ordine." /></div><div><Label>Note interne</Label><textarea className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" value={form.internalNotes} onChange={(event) => setForm({ ...form, internalNotes: event.target.value })} /></div><div className="grid gap-3 sm:grid-cols-2"><div><Label>Fascia reale da raggiungere *</Label><Select value={form.qualifyingTierCode} onValueChange={(value) => setForm({ ...form, qualifyingTierCode: value })}><SelectTrigger><SelectValue placeholder="Seleziona fascia" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select></div><div><Label>Fascia prezzo concessa *</Label><Select value={form.grantedTierCode} onValueChange={(value) => setForm({ ...form, grantedTierCode: value })}><SelectTrigger><SelectValue placeholder="Seleziona fascia" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select></div></div><div className="grid gap-3 sm:grid-cols-2"><div><Label>Inizio *</Label><Input type="datetime-local" value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} /></div><div><Label>Fine *</Label><Input type="datetime-local" value={form.validTo} onChange={(event) => setForm({ ...form, validTo: event.target.value })} /></div></div><div className="flex items-center gap-2"><Switch checked={form.isActive} onCheckedChange={(isActive) => setForm({ ...form, isActive })} /><Label>Attiva la campagna</Label></div></div><DialogFooter><Button variant="outline" onClick={() => setDialogOpen(false)}>Annulla</Button><Button className="bg-[#7AB648] hover:bg-[#6aa03d]" onClick={submit} disabled={mutationPending}>{mutationPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{editingId ? "Salva modifiche" : "Crea promozione"}</Button></DialogFooter></DialogContent></Dialog>
  </div></DashboardLayout>;
}
