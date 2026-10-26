import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { Edit, Loader2, PackagePlus, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type RuleType = "tier_upgrade" | "service_package";
type FormState = {
  ruleType: RuleType;
  title: string;
  publicDescription: string;
  internalNotes: string;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  qualifyingTierCode: string;
  grantedTierCode: string;
  assignedTierCode: string;
  serviceCode: string;
  serviceName: string;
  serviceNet: string;
  serviceVatRate: string;
  minimumMerchandiseNet: string;
  bonusEnabled: boolean;
  bonusAmount: string;
  bonusPaymentDeadline: string;
};

type PromotionRow = {
  id: string;
  ruleType?: RuleType;
  title: string;
  publicDescription: string;
  internalNotes?: string | null;
  validFrom: Date;
  validTo: Date;
  isActive: boolean;
  qualifyingTierCode?: string | null;
  grantedTierCode?: string | null;
  assignedTierCode?: string | null;
  serviceCode?: string | null;
  serviceName?: string | null;
  serviceNet?: string | number | null;
  serviceVatRate?: string | number | null;
  minimumMerchandiseNet?: string | number | null;
  bonusAmount?: string | number | null;
  bonusPaymentDeadline?: string | Date | null;
  servicePackage?: Omit<PromotionRow, "id" | "title" | "publicDescription" | "internalNotes" | "validFrom" | "validTo" | "isActive" | "ruleType"> | null;
};

const dateInputValue = (date: Date | string) => new Date(date).toISOString().slice(0, 16);
const dateOnlyInputValue = (date: Date | string | null | undefined) => date ? new Date(date).toISOString().slice(0, 10) : "";
const decimalInputValue = (value: string | number | null | undefined) => value == null ? "" : String(value);
const euro = (value: string | number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value));
const emptyForm = (ruleType: RuleType = "tier_upgrade"): FormState => ({
  ruleType,
  title: "",
  publicDescription: "",
  internalNotes: "",
  validFrom: dateInputValue(new Date()),
  validTo: "",
  isActive: true,
  qualifyingTierCode: "",
  grantedTierCode: "",
  assignedTierCode: "",
  serviceCode: "PROSPECT_SERVICE",
  serviceName: "",
  serviceNet: "",
  serviceVatRate: "22",
  minimumMerchandiseNet: "",
  bonusEnabled: false,
  bonusAmount: "",
  bonusPaymentDeadline: "",
});

const statusFor = (promotion: Pick<PromotionRow, "isActive" | "validFrom" | "validTo">) => {
  if (!promotion.isActive) return { label: "Disattivata", variant: "secondary" as const };
  const now = new Date();
  if (new Date(promotion.validFrom) > now) return { label: "Programmata", variant: "outline" as const };
  if (new Date(promotion.validTo) <= now) return { label: "Scaduta", variant: "destructive" as const };
  return { label: "Attiva", variant: "default" as const };
};

/** Il service può restituire la configurazione flat o annidata, senza cambiare la resa amministrativa. */
const packageFields = (promotion: PromotionRow) => promotion.servicePackage ?? promotion;
const ruleTypeFor = (promotion: PromotionRow): RuleType => promotion.ruleType ?? "tier_upgrade";

export default function ProspectPromotions() {
  const utils = trpc.useUtils();
  const promotionsQuery = trpc.prospectSimulator.adminPromotionList.useQuery();
  const configQuery = trpc.prospectSimulator.adminPromotionConfig.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const tiers = Array.isArray(configQuery.data?.tiers) ? configQuery.data.tiers as Array<{ code: string; name: string; discount_percent: number | string }> : [];

  const invalidate = () => Promise.all([
    utils.prospectSimulator.adminPromotionList.invalidate(),
    utils.prospectSimulator.adminPromotionConfig.invalidate(),
  ]);
  const createMutation = trpc.prospectSimulator.adminCreatePromotion.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Promozione prospect creata"); setDialogOpen(false); },
    onError: (error) => toast.error(error.message),
  });
  const updateMutation = trpc.prospectSimulator.adminUpdatePromotion.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Promozione prospect aggiornata"); setDialogOpen(false); },
    onError: (error) => toast.error(error.message),
  });
  const deactivateMutation = trpc.prospectSimulator.adminDeactivatePromotion.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("Promozione prospect disattivata"); },
    onError: (error) => toast.error(error.message),
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setDialogOpen(true);
  };
  const openEdit = (promotion: PromotionRow) => {
    const ruleType = ruleTypeFor(promotion);
    const servicePackage = packageFields(promotion);
    const bonusEnabled = servicePackage.bonusAmount != null || servicePackage.bonusPaymentDeadline != null;
    setEditingId(promotion.id);
    setForm({
      ruleType,
      title: promotion.title,
      publicDescription: promotion.publicDescription,
      internalNotes: promotion.internalNotes ?? "",
      validFrom: dateInputValue(promotion.validFrom),
      validTo: dateInputValue(promotion.validTo),
      isActive: promotion.isActive,
      qualifyingTierCode: promotion.qualifyingTierCode ?? "",
      grantedTierCode: promotion.grantedTierCode ?? "",
      assignedTierCode: servicePackage.assignedTierCode ?? "",
      serviceCode: servicePackage.serviceCode ?? "PROSPECT_SERVICE",
      serviceName: servicePackage.serviceName ?? "",
      serviceNet: decimalInputValue(servicePackage.serviceNet),
      serviceVatRate: decimalInputValue(servicePackage.serviceVatRate ?? 22),
      minimumMerchandiseNet: decimalInputValue(servicePackage.minimumMerchandiseNet),
      bonusEnabled,
      bonusAmount: decimalInputValue(servicePackage.bonusAmount),
      bonusPaymentDeadline: dateOnlyInputValue(servicePackage.bonusPaymentDeadline),
    });
    setDialogOpen(true);
  };

  const submit = () => {
    if (!form.title || !form.publicDescription || !form.validFrom || !form.validTo) {
      toast.error("Compila titolo, testo visibile e periodo della promozione");
      return;
    }
    const base = {
      title: form.title,
      publicDescription: form.publicDescription,
      internalNotes: form.internalNotes || null,
      validFrom: new Date(form.validFrom),
      validTo: new Date(form.validTo),
      isActive: form.isActive,
    };
    if (form.ruleType === "tier_upgrade") {
      if (!form.qualifyingTierCode || !form.grantedTierCode) {
        toast.error("Seleziona la fascia reale e la fascia prezzo concessa");
        return;
      }
      const promotion = { ...base, ruleType: "tier_upgrade" as const, qualifyingTierCode: form.qualifyingTierCode, grantedTierCode: form.grantedTierCode };
      if (editingId) updateMutation.mutate({ id: editingId, promotion });
      else createMutation.mutate(promotion);
      return;
    }
    if (!form.assignedTierCode || !form.serviceCode || !form.serviceName || !form.serviceNet || !form.minimumMerchandiseNet) {
      toast.error("Compila fascia assegnata, servizio, quota e minimo merce");
      return;
    }
    if (form.bonusEnabled && (!form.bonusAmount || !form.bonusPaymentDeadline)) {
      toast.error("Per il bonus indica importo e scadenza di pagamento");
      return;
    }
    const promotion = {
      ...base,
      ruleType: "service_package" as const,
      assignedTierCode: form.assignedTierCode,
      serviceCode: form.serviceCode,
      serviceName: form.serviceName,
      serviceNet: Number(form.serviceNet),
      serviceVatRate: Number(form.serviceVatRate || 22),
      minimumMerchandiseNet: Number(form.minimumMerchandiseNet),
      bonusAmount: form.bonusEnabled ? Number(form.bonusAmount) : null,
      bonusPaymentDeadline: form.bonusEnabled ? new Date(`${form.bonusPaymentDeadline}T00:00:00`) : null,
    };
    if (editingId) updateMutation.mutate({ id: editingId, promotion });
    else createMutation.mutate(promotion);
  };

  const mutationPending = createMutation.isPending || updateMutation.isPending;
  const promotions = (promotionsQuery.data ?? []) as PromotionRow[];
  const headingDescription = "Campagne valide sul primo ordine da invito: upgrade di fascia oppure pacchetto con servizio e bonus facoltativo.";

  return <DashboardLayout><div className="container space-y-6 py-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><h1 className="text-2xl font-bold">Promozioni prospect</h1><p className="mt-1 text-sm text-muted-foreground">{headingDescription}</p></div><Button onClick={openCreate} className="bg-[#7AB648] hover:bg-[#6aa03d]"><Plus className="mr-1 h-4 w-4" />Nuova promozione</Button></div>

    <Card className="border-[#7AB648]/50 bg-[#F3F7ED]"><CardContent className="flex gap-3 p-4 text-sm text-[#254521]"><Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[#5D973B]" /><p><strong>Regola di applicazione:</strong> una sola campagna attiva per company nello stesso periodo. L’upgrade assegna prezzi di una fascia superiore; il pacchetto assegna la fascia configurata, aggiunge una riga servizio e può prevedere un bonus dopo pagamento entro la scadenza.</p></CardContent></Card>

    {promotionsQuery.isLoading || configQuery.isLoading ? <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div> : promotions.length === 0 ? <Card className="border-dashed"><CardContent className="py-12 text-center"><Sparkles className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" /><h2 className="text-lg font-semibold">Nessuna promozione prospect</h2><p className="mt-2 text-sm text-muted-foreground">Crea una campagna SoKeto per offrire un upgrade di fascia o un pacchetto con servizio.</p></CardContent></Card> : <Card><Table><TableHeader><TableRow><TableHead>Campagna</TableHead><TableHead>Tipo e condizioni</TableHead><TableHead>Periodo</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader><TableBody>{promotions.map((promotion) => {
      const status = statusFor(promotion);
      const ruleType = ruleTypeFor(promotion);
      const servicePackage = packageFields(promotion);
      return <TableRow key={promotion.id}><TableCell><p className="font-medium">{promotion.title}</p><p className="max-w-md truncate text-xs text-muted-foreground">{promotion.publicDescription}</p></TableCell><TableCell>{ruleType === "tier_upgrade" ? <div className="space-y-1"><Badge variant="outline">Upgrade di fascia</Badge><p className="text-xs text-muted-foreground">{promotion.qualifyingTierCode} → {promotion.grantedTierCode}</p></div> : <div className="space-y-1"><Badge className="bg-[#5D973B] hover:bg-[#5D973B]"><PackagePlus className="mr-1 h-3 w-3" />Pacchetto servizio</Badge><p className="text-xs text-muted-foreground">{servicePackage.assignedTierCode} · {servicePackage.serviceName} · {servicePackage.serviceNet != null && euro(servicePackage.serviceNet)}</p>{servicePackage.bonusAmount != null && <p className="text-xs font-medium text-[#426b2f]">Bonus {euro(servicePackage.bonusAmount)}</p>}</div>}</TableCell><TableCell className="text-sm">{new Date(promotion.validFrom).toLocaleString("it-IT")}<br />{new Date(promotion.validTo).toLocaleString("it-IT")}</TableCell><TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell><TableCell className="text-right"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => openEdit(promotion)}><Edit className="h-4 w-4" /><span className="sr-only">Modifica</span></Button>{promotion.isActive && <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={deactivateMutation.isPending} onClick={() => { if (window.confirm("Disattivare questa promozione? Non cambierà gli ordini già inviati.")) deactivateMutation.mutate({ id: promotion.id }); }}>Disattiva</Button>}</div></TableCell></TableRow>;
    })}</TableBody></Table></Card>}

    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>{editingId ? "Modifica promozione prospect" : "Nuova promozione prospect"}</DialogTitle><DialogDescription>{form.ruleType === "tier_upgrade" ? "Offri prezzi di una fascia superiore sul primo ordine." : "Crea un pacchetto primo ordine con riga servizio, fascia assegnata e bonus facoltativo."}</DialogDescription></DialogHeader><div className="space-y-4"><div><Label>Tipo promozione *</Label><Select value={form.ruleType} onValueChange={(value: RuleType) => setForm({ ...emptyForm(value), title: form.title, publicDescription: form.publicDescription, internalNotes: form.internalNotes, validFrom: form.validFrom, validTo: form.validTo, isActive: form.isActive })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tier_upgrade">Upgrade di fascia</SelectItem><SelectItem value="service_package">Pacchetto con servizio</SelectItem></SelectContent></Select></div><div><Label>Titolo *</Label><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={form.ruleType === "tier_upgrade" ? "Es. Benvenuto Partner con prezzi Premium" : "Es. Pacchetto avvio SoKeto"} /></div><div><Label>Testo visibile al prospect *</Label><textarea className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" value={form.publicDescription} onChange={(event) => setForm({ ...form, publicDescription: event.target.value })} placeholder="Spiega con chiarezza le condizioni del primo ordine." /></div><div><Label>Note interne</Label><textarea className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" value={form.internalNotes} onChange={(event) => setForm({ ...form, internalNotes: event.target.value })} /></div>

      {form.ruleType === "tier_upgrade" ? <div className="grid gap-3 sm:grid-cols-2"><div><Label>Fascia reale da raggiungere *</Label><Select value={form.qualifyingTierCode} onValueChange={(value) => setForm({ ...form, qualifyingTierCode: value })}><SelectTrigger><SelectValue placeholder="Seleziona fascia" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select></div><div><Label>Fascia prezzo concessa *</Label><Select value={form.grantedTierCode} onValueChange={(value) => setForm({ ...form, grantedTierCode: value })}><SelectTrigger><SelectValue placeholder="Seleziona fascia" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select></div></div> : <div className="space-y-4 rounded-lg border border-[#7AB648]/40 bg-[#F3F7ED]/70 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-[#254521]"><PackagePlus className="h-4 w-4 text-[#5D973B]" />Pacchetto con servizio SoKeto</div><div><Label>Fascia assegnata al pacchetto *</Label><Select value={form.assignedTierCode} onValueChange={(value) => setForm({ ...form, assignedTierCode: value })}><SelectTrigger className="bg-white"><SelectValue placeholder="Seleziona fascia" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select></div><div className="grid gap-3 sm:grid-cols-2"><div><Label>Codice servizio *</Label><Input className="bg-white" value={form.serviceCode} onChange={(event) => setForm({ ...form, serviceCode: event.target.value })} placeholder="PROSPECT_SERVICE" /></div><div><Label>Quota servizio, IVA esclusa *</Label><Input className="bg-white" type="number" min="0.01" step="0.01" inputMode="decimal" value={form.serviceNet} onChange={(event) => setForm({ ...form, serviceNet: event.target.value })} placeholder="0,00" /></div></div><div><Label>Nome servizio *</Label><Input className="bg-white" value={form.serviceName} onChange={(event) => setForm({ ...form, serviceName: event.target.value })} placeholder="Es. Servizio di avvio e affiancamento" /></div><div className="grid gap-3 sm:grid-cols-2"><div><Label>IVA servizio *</Label><Select value={form.serviceVatRate} onValueChange={(value) => setForm({ ...form, serviceVatRate: value })}><SelectTrigger className="bg-white"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="4">4%</SelectItem><SelectItem value="5">5%</SelectItem><SelectItem value="10">10%</SelectItem><SelectItem value="22">22%</SelectItem></SelectContent></Select></div><div><Label>Minimo merce, IVA esclusa *</Label><Input className="bg-white" type="number" min="0" step="0.01" inputMode="decimal" value={form.minimumMerchandiseNet} onChange={(event) => setForm({ ...form, minimumMerchandiseNet: event.target.value })} placeholder="0,00" /></div></div><div className="border-t border-[#7AB648]/30 pt-4"><div className="flex items-center justify-between gap-3"><div><Label>Bonus dopo pagamento</Label><p className="mt-1 text-xs text-muted-foreground">Opzionale: richiede importo e scadenza.</p></div><Switch checked={form.bonusEnabled} onCheckedChange={(bonusEnabled) => setForm({ ...form, bonusEnabled, bonusAmount: bonusEnabled ? form.bonusAmount : "", bonusPaymentDeadline: bonusEnabled ? form.bonusPaymentDeadline : "" })} /></div>{form.bonusEnabled && <div className="mt-3 grid gap-3 sm:grid-cols-2"><div><Label>Importo bonus *</Label><Input className="bg-white" type="number" min="0.01" step="0.01" inputMode="decimal" value={form.bonusAmount} onChange={(event) => setForm({ ...form, bonusAmount: event.target.value })} placeholder="0,00" /></div><div><Label>Scadenza pagamento *</Label><Input className="bg-white" type="date" value={form.bonusPaymentDeadline} onChange={(event) => setForm({ ...form, bonusPaymentDeadline: event.target.value })} /></div></div>}</div></div>}

      <div className="grid gap-3 sm:grid-cols-2"><div><Label>Inizio *</Label><Input type="datetime-local" value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} /></div><div><Label>Fine *</Label><Input type="datetime-local" value={form.validTo} onChange={(event) => setForm({ ...form, validTo: event.target.value })} /></div></div><div className="flex items-center gap-2"><Switch checked={form.isActive} onCheckedChange={(isActive) => setForm({ ...form, isActive })} /><Label>Attiva la campagna</Label></div></div><DialogFooter><Button variant="outline" onClick={() => setDialogOpen(false)}>Annulla</Button><Button className="bg-[#7AB648] hover:bg-[#6aa03d]" onClick={submit} disabled={mutationPending}>{mutationPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{editingId ? "Salva modifiche" : "Crea promozione"}</Button></DialogFooter></DialogContent></Dialog>
  </div></DashboardLayout>;
}
