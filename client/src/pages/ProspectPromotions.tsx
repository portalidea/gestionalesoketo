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
import { Calculator, CircleAlert, Edit, Gift, Info, Loader2, PackagePlus, Plus, Sparkles } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
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
type FormField = "title" | "publicDescription" | "validFrom" | "validTo" | "qualifyingTierCode" | "grantedTierCode" | "assignedTierCode" | "serviceName" | "serviceNet" | "serviceVatRate" | "minimumMerchandiseNet" | "bonusAmount" | "bonusPaymentDeadline";
type FormErrors = Partial<Record<FormField, string>>;
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

const AUTO_SERVICE_CODE = "PROSPECT_SERVICE";
const dateInputValue = (date: Date | string) => new Date(date).toISOString().slice(0, 16);
const dateOnlyInputValue = (date: Date | string | null | undefined) => date ? new Date(date).toISOString().slice(0, 10) : "";
const decimalInputValue = (value: string | number | null | undefined) => value == null ? "" : String(value);
const euro = (value: string | number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value));
const toNumber = (value: string) => Number.isFinite(Number(value)) ? Number(value) : null;
const positiveNumber = (value: string) => { const number = toNumber(value); return number !== null && number > 0 ? number : null; };
const nonNegativeNumber = (value: string) => { const number = toNumber(value); return number !== null && number >= 0 ? number : null; };
const formatDateItalian = (value: string) => value ? new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)) : "";
const emptyForm = (ruleType: RuleType = "tier_upgrade"): FormState => ({
  ruleType, title: "", publicDescription: "", internalNotes: "", validFrom: dateInputValue(new Date()), validTo: "", isActive: true,
  qualifyingTierCode: "", grantedTierCode: "", assignedTierCode: "", serviceCode: AUTO_SERVICE_CODE, serviceName: "", serviceNet: "", serviceVatRate: "22", minimumMerchandiseNet: "", bonusEnabled: false, bonusAmount: "", bonusPaymentDeadline: "",
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
function FieldHint({ children }: { children: ReactNode }) { return <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{children}</p>; }
function FieldError({ message }: { message?: string }) { return message ? <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-destructive"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{message}</p> : null; }
const inputClassName = (hasError: boolean) => hasError ? "border-destructive bg-background text-foreground focus-visible:ring-destructive" : "bg-background text-foreground";

export default function ProspectPromotions() {
  const utils = trpc.useUtils();
  const promotionsQuery = trpc.prospectSimulator.adminPromotionList.useQuery();
  const configQuery = trpc.prospectSimulator.adminPromotionConfig.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const tiers = Array.isArray(configQuery.data?.tiers) ? configQuery.data.tiers as Array<{ code: string; name: string; discount_percent: number | string }> : [];
  const invalidate = () => Promise.all([utils.prospectSimulator.adminPromotionList.invalidate(), utils.prospectSimulator.adminPromotionConfig.invalidate()]);
  const createMutation = trpc.prospectSimulator.adminCreatePromotion.useMutation({ onSuccess: async () => { await invalidate(); toast.success("Promozione prospect creata"); setDialogOpen(false); }, onError: (error) => toast.error(error.message) });
  const updateMutation = trpc.prospectSimulator.adminUpdatePromotion.useMutation({ onSuccess: async () => { await invalidate(); toast.success("Promozione prospect aggiornata"); setDialogOpen(false); }, onError: (error) => toast.error(error.message) });
  const deactivateMutation = trpc.prospectSimulator.adminDeactivatePromotion.useMutation({ onSuccess: async () => { await invalidate(); toast.success("Promozione prospect disattivata"); }, onError: (error) => toast.error(error.message) });

  const serviceSummary = useMemo(() => {
    const serviceNet = positiveNumber(form.serviceNet);
    const minimumNet = nonNegativeNumber(form.minimumMerchandiseNet);
    if (serviceNet === null || minimumNet === null) return null;
    return { serviceNet, minimumNet, totalNet: serviceNet + minimumNet, bonusAmount: positiveNumber(form.bonusAmount) };
  }, [form.serviceNet, form.minimumMerchandiseNet, form.bonusAmount]);

  const openCreate = () => { setEditingId(null); setErrors({}); setForm(emptyForm()); setDialogOpen(true); };
  const openEdit = (promotion: PromotionRow) => {
    const ruleType = ruleTypeFor(promotion);
    const servicePackage = packageFields(promotion);
    setEditingId(promotion.id);
    setErrors({});
    setForm({
      ruleType, title: promotion.title, publicDescription: promotion.publicDescription, internalNotes: promotion.internalNotes ?? "", validFrom: dateInputValue(promotion.validFrom), validTo: dateInputValue(promotion.validTo), isActive: promotion.isActive,
      qualifyingTierCode: promotion.qualifyingTierCode ?? "", grantedTierCode: promotion.grantedTierCode ?? "", assignedTierCode: servicePackage.assignedTierCode ?? "", serviceCode: servicePackage.serviceCode ?? AUTO_SERVICE_CODE, serviceName: servicePackage.serviceName ?? "", serviceNet: decimalInputValue(servicePackage.serviceNet), serviceVatRate: decimalInputValue(servicePackage.serviceVatRate ?? 22), minimumMerchandiseNet: decimalInputValue(servicePackage.minimumMerchandiseNet), bonusEnabled: servicePackage.bonusAmount != null || servicePackage.bonusPaymentDeadline != null, bonusAmount: decimalInputValue(servicePackage.bonusAmount), bonusPaymentDeadline: dateOnlyInputValue(servicePackage.bonusPaymentDeadline),
    });
    setDialogOpen(true);
  };

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    if (!form.title.trim()) next.title = "Inserisci un titolo per riconoscere la campagna.";
    if (!form.publicDescription.trim()) next.publicDescription = "Inserisci il testo che sarà mostrato al prospect.";
    if (!form.validFrom) next.validFrom = "Indica l’inizio della campagna.";
    if (!form.validTo) next.validTo = "Indica la fine della campagna.";
    if (form.validFrom && form.validTo && new Date(form.validTo) <= new Date(form.validFrom)) next.validTo = "La data fine deve essere successiva alla data inizio.";
    if (form.ruleType === "tier_upgrade") {
      if (!form.qualifyingTierCode) next.qualifyingTierCode = "Seleziona la fascia che il cliente deve raggiungere.";
      if (!form.grantedTierCode) next.grantedTierCode = "Seleziona la fascia prezzo da concedere.";
      return next;
    }
    if (!form.assignedTierCode) next.assignedTierCode = "Seleziona il pacchetto assegnato al cliente.";
    if (!form.serviceName.trim()) next.serviceName = "Indica il nome del servizio incluso.";
    if (positiveNumber(form.serviceNet) === null) next.serviceNet = "Indica un prezzo del servizio maggiore di zero.";
    if (!form.serviceVatRate) next.serviceVatRate = "Seleziona l’IVA applicata al servizio.";
    if (nonNegativeNumber(form.minimumMerchandiseNet) === null) next.minimumMerchandiseNet = "Indica il valore minimo dei prodotti.";
    if (form.bonusEnabled && positiveNumber(form.bonusAmount) === null) next.bonusAmount = "Indica il valore dei prodotti omaggio.";
    if (form.bonusEnabled && !form.bonusPaymentDeadline) next.bonusPaymentDeadline = "Indica entro quale data deve essere registrato il pagamento.";
    return next;
  };

  const submit = () => {
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) { toast.error("Controlla i campi evidenziati prima di salvare."); return; }
    const base = { title: form.title.trim(), publicDescription: form.publicDescription.trim(), internalNotes: form.internalNotes.trim() || null, validFrom: new Date(form.validFrom), validTo: new Date(form.validTo), isActive: form.isActive };
    if (form.ruleType === "tier_upgrade") {
      const promotion = { ...base, ruleType: "tier_upgrade" as const, qualifyingTierCode: form.qualifyingTierCode, grantedTierCode: form.grantedTierCode };
      if (editingId) updateMutation.mutate({ id: editingId, promotion }); else createMutation.mutate(promotion);
      return;
    }
    const promotion = { ...base, ruleType: "service_package" as const, assignedTierCode: form.assignedTierCode, serviceCode: form.serviceCode, serviceName: form.serviceName.trim(), serviceNet: Number(form.serviceNet), serviceVatRate: Number(form.serviceVatRate), minimumMerchandiseNet: Number(form.minimumMerchandiseNet), bonusAmount: form.bonusEnabled ? Number(form.bonusAmount) : null, bonusPaymentDeadline: form.bonusEnabled ? new Date(`${form.bonusPaymentDeadline}T00:00:00`) : null };
    if (editingId) updateMutation.mutate({ id: editingId, promotion }); else createMutation.mutate(promotion);
  };

  const mutationPending = createMutation.isPending || updateMutation.isPending;
  const promotions = (promotionsQuery.data ?? []) as PromotionRow[];
  return <DashboardLayout><div className="container space-y-6 py-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><h1 className="text-2xl font-bold">Promozioni prospect</h1><p className="mt-1 text-sm text-muted-foreground">Campagne valide sul primo ordine da invito: upgrade di fascia oppure pacchetto con servizio e bonus facoltativo.</p></div><Button onClick={openCreate} className="bg-[#7AB648] hover:bg-[#6aa03d]"><Plus className="mr-1 h-4 w-4" />Nuova promozione</Button></div>
    <Card className="border-[#7AB648]/50 bg-[#F3F7ED]"><CardContent className="flex gap-3 p-4 text-sm text-[#254521]"><Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[#5D973B]" /><p><strong>Regola di applicazione:</strong> una sola campagna attiva per company nello stesso periodo. L’upgrade assegna prezzi di una fascia superiore; il pacchetto assegna la fascia configurata, aggiunge una riga servizio e può prevedere un bonus dopo pagamento entro la scadenza.</p></CardContent></Card>
    {promotionsQuery.isLoading || configQuery.isLoading ? <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div> : promotions.length === 0 ? <Card className="border-dashed"><CardContent className="py-12 text-center"><Sparkles className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" /><h2 className="text-lg font-semibold">Nessuna promozione prospect</h2><p className="mt-2 text-sm text-muted-foreground">Crea una campagna SoKeto per offrire un upgrade di fascia o un pacchetto con servizio.</p></CardContent></Card> : <Card><Table><TableHeader><TableRow><TableHead>Campagna</TableHead><TableHead>Tipo e condizioni</TableHead><TableHead>Periodo</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader><TableBody>{promotions.map((promotion) => {
      const status = statusFor(promotion); const ruleType = ruleTypeFor(promotion); const servicePackage = packageFields(promotion);
      return <TableRow key={promotion.id}><TableCell><p className="font-medium">{promotion.title}</p><p className="max-w-md truncate text-xs text-muted-foreground">{promotion.publicDescription}</p></TableCell><TableCell>{ruleType === "tier_upgrade" ? <div className="space-y-1"><Badge variant="outline">Upgrade di fascia</Badge><p className="text-xs text-muted-foreground">{promotion.qualifyingTierCode} → {promotion.grantedTierCode}</p></div> : <div className="space-y-1"><Badge className="bg-[#5D973B] hover:bg-[#5D973B]"><PackagePlus className="mr-1 h-3 w-3" />Pacchetto con servizio e bonus</Badge><p className="text-xs text-muted-foreground">{servicePackage.assignedTierCode} · {servicePackage.serviceName} · {servicePackage.serviceNet != null && euro(servicePackage.serviceNet)}</p>{servicePackage.bonusAmount != null && <p className="text-xs font-medium text-[#426b2f]">Bonus {euro(servicePackage.bonusAmount)}</p>}</div>}</TableCell><TableCell className="text-sm">{new Date(promotion.validFrom).toLocaleString("it-IT")}<br />{new Date(promotion.validTo).toLocaleString("it-IT")}</TableCell><TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell><TableCell className="text-right"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => openEdit(promotion)}><Edit className="h-4 w-4" /><span className="sr-only">Modifica</span></Button>{promotion.isActive && <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={deactivateMutation.isPending} onClick={() => { if (window.confirm("Disattivare questa promozione? Non cambierà gli ordini già inviati.")) deactivateMutation.mutate({ id: promotion.id }); }}>Disattiva</Button>}</div></TableCell></TableRow>;
    })}</TableBody></Table></Card>}

    <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setErrors({}); }}><DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>{editingId ? "Modifica promozione prospect" : "Nuova promozione prospect"}</DialogTitle><DialogDescription>{form.ruleType === "tier_upgrade" ? "Offri prezzi di una fascia superiore sul primo ordine." : "Configura un primo ordine con servizio, pacchetto assegnato e bonus facoltativo."}</DialogDescription></DialogHeader>
      <div className="space-y-6">
        <section className="space-y-2"><Label htmlFor="rule-type">Tipo di regola *</Label><Select value={form.ruleType} onValueChange={(value) => { const ruleType = value as RuleType; setForm({ ...emptyForm(ruleType), title: form.title, publicDescription: form.publicDescription, internalNotes: form.internalNotes, validFrom: form.validFrom, validTo: form.validTo, isActive: form.isActive }); setErrors({}); }}><SelectTrigger id="rule-type" className="bg-background text-foreground"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tier_upgrade">Upgrade di fascia</SelectItem><SelectItem value="service_package">Pacchetto con servizio e bonus</SelectItem></SelectContent></Select><FieldHint>La regola scelta resta visibile al prospect solo sul suo primo ordine.</FieldHint></section>
        {form.ruleType === "tier_upgrade" ? <section className="grid gap-4 rounded-lg border border-border bg-card p-4 text-card-foreground sm:grid-cols-2"><div><Label>Fascia reale da raggiungere *</Label><Select value={form.qualifyingTierCode} onValueChange={(value) => { setForm({ ...form, qualifyingTierCode: value }); setErrors({ ...errors, qualifyingTierCode: undefined }); }}><SelectTrigger className={inputClassName(Boolean(errors.qualifyingTierCode))}><SelectValue placeholder="Seleziona fascia" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select><FieldError message={errors.qualifyingTierCode} /></div><div><Label>Fascia prezzo concessa *</Label><Select value={form.grantedTierCode} onValueChange={(value) => { setForm({ ...form, grantedTierCode: value }); setErrors({ ...errors, grantedTierCode: undefined }); }}><SelectTrigger className={inputClassName(Boolean(errors.grantedTierCode))}><SelectValue placeholder="Seleziona fascia" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select><FieldError message={errors.grantedTierCode} /></div></section> : <section className="space-y-6 rounded-lg border border-primary/40 bg-card p-5 text-card-foreground shadow-sm"><div className="flex items-start gap-3 border-b border-border pb-4"><div className="rounded-md bg-primary/15 p-2 text-primary"><PackagePlus className="h-5 w-5" /></div><div><h3 className="font-semibold text-foreground">Pacchetto con servizio e bonus</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Configura in ordine il pacchetto, il servizio, la soglia dei prodotti e l’eventuale bonus. Il codice tecnico del servizio viene generato automaticamente.</p></div></div>
          <section className="space-y-2"><Label>Pacchetto assegnato al cliente *</Label><Select value={form.assignedTierCode} onValueChange={(value) => { setForm({ ...form, assignedTierCode: value }); setErrors({ ...errors, assignedTierCode: undefined }); }}><SelectTrigger className={inputClassName(Boolean(errors.assignedTierCode))}><SelectValue placeholder="Seleziona il pacchetto" /></SelectTrigger><SelectContent>{tiers.map((tier) => <SelectItem key={tier.code} value={tier.code}>{tier.name} · −{Number(tier.discount_percent).toFixed(2)}%</SelectItem>)}</SelectContent></Select><FieldHint>Il cliente riceverà questo livello di prezzo, anche per gli ordini successivi.</FieldHint><FieldError message={errors.assignedTierCode} /></section>
          <section className="space-y-4 border-t border-border pt-5"><div><h4 className="font-medium text-foreground">Servizio incluso</h4><p className="mt-1 text-sm text-muted-foreground">Una riga distinta dalla merce, inclusa nel totale e nei documenti ma non nel magazzino.</p></div><div><Label htmlFor="service-name">Servizio incluso *</Label><Input id="service-name" className={inputClassName(Boolean(errors.serviceName))} value={form.serviceName} onChange={(event) => { setForm({ ...form, serviceName: event.target.value }); setErrors({ ...errors, serviceName: undefined }); }} placeholder="Es. Pubblicità" aria-invalid={Boolean(errors.serviceName)} /><FieldHint>È il nome della riga servizio che apparirà nell’ordine e nel documento FiC.</FieldHint><FieldError message={errors.serviceName} /></div><div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="service-net">Prezzo del servizio, IVA esclusa *</Label><Input id="service-net" className={inputClassName(Boolean(errors.serviceNet))} type="number" min="0.01" step="0.01" inputMode="decimal" value={form.serviceNet} onChange={(event) => { setForm({ ...form, serviceNet: event.target.value }); setErrors({ ...errors, serviceNet: undefined }); }} placeholder="0,00" aria-invalid={Boolean(errors.serviceNet)} /><FieldHint>Importo fisso del servizio, separato dai prodotti acquistati.</FieldHint><FieldError message={errors.serviceNet} /></div><div><Label>IVA del servizio *</Label><Select value={form.serviceVatRate} onValueChange={(value) => { setForm({ ...form, serviceVatRate: value }); setErrors({ ...errors, serviceVatRate: undefined }); }}><SelectTrigger className={inputClassName(Boolean(errors.serviceVatRate))}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="4">4%</SelectItem><SelectItem value="5">5%</SelectItem><SelectItem value="10">10%</SelectItem><SelectItem value="22">22%</SelectItem></SelectContent></Select><FieldHint>Aliquota applicata esclusivamente alla riga servizio.</FieldHint><FieldError message={errors.serviceVatRate} /></div></div></section>
          <section className="space-y-2 border-t border-border pt-5"><Label htmlFor="minimum-merchandise">Valore minimo prodotti, IVA esclusa *</Label><Input id="minimum-merchandise" className={inputClassName(Boolean(errors.minimumMerchandiseNet))} type="number" min="0" step="0.01" inputMode="decimal" value={form.minimumMerchandiseNet} onChange={(event) => { setForm({ ...form, minimumMerchandiseNet: event.target.value }); setErrors({ ...errors, minimumMerchandiseNet: undefined }); }} placeholder="0,00" aria-invalid={Boolean(errors.minimumMerchandiseNet)} /><FieldHint>Il cliente non può confermare l’ordine sotto questa cifra. Sopra paga i prodotti in più.</FieldHint><FieldError message={errors.minimumMerchandiseNet} /></section>
          <section className="space-y-4 border-t border-border pt-5"><div className="flex items-start justify-between gap-4"><div><h4 className="font-medium text-foreground">Bonus dopo il pagamento</h4><p className="mt-1 text-sm text-muted-foreground">Facoltativo: diventa un credito da usare in un ordine successivo soltanto se il pagamento è registrato entro la data indicata.</p></div><Switch checked={form.bonusEnabled} onCheckedChange={(bonusEnabled) => { setForm({ ...form, bonusEnabled, bonusAmount: bonusEnabled ? form.bonusAmount : "", bonusPaymentDeadline: bonusEnabled ? form.bonusPaymentDeadline : "" }); setErrors({ ...errors, bonusAmount: undefined, bonusPaymentDeadline: undefined }); }} aria-label="Attiva bonus dopo il pagamento" /></div>{form.bonusEnabled && <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="bonus-amount">Prodotti omaggio a prezzo al pubblico *</Label><Input id="bonus-amount" className={inputClassName(Boolean(errors.bonusAmount))} type="number" min="0.01" step="0.01" inputMode="decimal" value={form.bonusAmount} onChange={(event) => { setForm({ ...form, bonusAmount: event.target.value }); setErrors({ ...errors, bonusAmount: undefined }); }} placeholder="0,00" aria-invalid={Boolean(errors.bonusAmount)} /><FieldHint>È il valore del credito bonus, valorizzato a prezzo al pubblico.</FieldHint><FieldError message={errors.bonusAmount} /></div><div><Label htmlFor="bonus-deadline">Se paga entro il *</Label><Input id="bonus-deadline" className={inputClassName(Boolean(errors.bonusPaymentDeadline))} type="date" value={form.bonusPaymentDeadline} onChange={(event) => { setForm({ ...form, bonusPaymentDeadline: event.target.value }); setErrors({ ...errors, bonusPaymentDeadline: undefined }); }} aria-invalid={Boolean(errors.bonusPaymentDeadline)} /><FieldHint>Conta la data di pagamento registrata, non quando viene inserita in amministrazione.</FieldHint><FieldError message={errors.bonusPaymentDeadline} /></div></div>}</section>
          <section aria-live="polite" className="rounded-lg border border-primary/35 bg-primary/10 p-4 text-foreground"><div className="flex items-start gap-3"><Calculator className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><h4 className="font-semibold">Riepilogo per il cliente</h4>{serviceSummary ? <div className="mt-1 space-y-2 text-sm leading-6"><p>Il cliente paga: <strong>{euro(serviceSummary.serviceNet)} di {form.serviceName.trim() || "servizio"}</strong> + almeno <strong>{euro(serviceSummary.minimumNet)} di prodotti</strong> = <strong>{euro(serviceSummary.totalNet)} + IVA</strong>.</p>{form.bonusEnabled && serviceSummary.bonusAmount !== null && form.bonusPaymentDeadline && <p className="flex gap-2"><Gift className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span>Se paga entro il <strong>{formatDateItalian(form.bonusPaymentDeadline)}</strong> riceve <strong>{euro(serviceSummary.bonusAmount)} di prodotti omaggio (prezzo al pubblico)</strong> da usare in un ordine successivo.</span></p>}</div> : <p className="mt-1 text-sm leading-6 text-muted-foreground">Inserisci prezzo del servizio e valore minimo dei prodotti per vedere il totale minimo mostrato al cliente.</p>}</div></div></section>
        </section>}


        <section className="space-y-4 rounded-lg border border-border bg-card p-4 text-card-foreground"><div><h3 className="font-semibold text-foreground">Periodo e stato</h3><p className="mt-1 text-sm text-muted-foreground">La promozione è disponibile solo nel periodo configurato.</p></div><div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="valid-from">Inizio *</Label><Input id="valid-from" className={inputClassName(Boolean(errors.validFrom))} type="datetime-local" value={form.validFrom} onChange={(event) => { setForm({ ...form, validFrom: event.target.value }); setErrors({ ...errors, validFrom: undefined }); }} aria-invalid={Boolean(errors.validFrom)} /><FieldError message={errors.validFrom} /></div><div><Label htmlFor="valid-to">Fine *</Label><Input id="valid-to" className={inputClassName(Boolean(errors.validTo))} type="datetime-local" value={form.validTo} onChange={(event) => { setForm({ ...form, validTo: event.target.value }); setErrors({ ...errors, validTo: undefined }); }} aria-invalid={Boolean(errors.validTo)} /><FieldError message={errors.validTo} /></div></div><div className="flex items-center gap-2 rounded-md border border-border bg-background/70 p-3"><Switch checked={form.isActive} onCheckedChange={(isActive) => setForm({ ...form, isActive })} id="promotion-active" /><div><Label htmlFor="promotion-active" className="cursor-pointer">Attiva la campagna</Label><p className="mt-0.5 text-xs text-muted-foreground">Una sola campagna attiva può coprire lo stesso periodo per company.</p></div></div></section>

        <section className="space-y-4 rounded-lg border border-border bg-card p-4 text-card-foreground"><div><h3 className="font-semibold text-foreground">Informazioni della campagna</h3><p className="mt-1 text-sm text-muted-foreground">Titolo e messaggio che spiegano al prospect la condizione che riceve.</p></div><div><Label htmlFor="title">Titolo *</Label><Input id="title" className={inputClassName(Boolean(errors.title))} value={form.title} onChange={(event) => { setForm({ ...form, title: event.target.value }); setErrors({ ...errors, title: undefined }); }} placeholder={form.ruleType === "tier_upgrade" ? "Es. Benvenuto Partner con prezzi Premium" : "Es. Pacchetto avvio SoKeto"} aria-invalid={Boolean(errors.title)} /><FieldHint>È il titolo mostrato nella configurazione interna della promozione.</FieldHint><FieldError message={errors.title} /></div><div><Label htmlFor="public-description">Testo visibile al prospect *</Label><textarea id="public-description" className={`min-h-24 w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 ${errors.publicDescription ? "border-destructive bg-background text-foreground focus-visible:ring-destructive" : "border-input bg-background text-foreground focus-visible:ring-ring"}`} value={form.publicDescription} onChange={(event) => { setForm({ ...form, publicDescription: event.target.value }); setErrors({ ...errors, publicDescription: undefined }); }} placeholder="Spiega con chiarezza le condizioni del primo ordine." aria-invalid={Boolean(errors.publicDescription)} /><FieldHint>Usa un linguaggio chiaro: il prospect leggerà questo testo nel modulo ordine.</FieldHint><FieldError message={errors.publicDescription} /></div><div><Label htmlFor="internal-notes">Note interne</Label><textarea id="internal-notes" className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring" value={form.internalNotes} onChange={(event) => setForm({ ...form, internalNotes: event.target.value })} placeholder="Facoltative: non saranno mostrate al prospect." /></div></section>
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground"><Info className="mt-0.5 h-4 w-4 shrink-0" />Il codice tecnico del servizio è creato automaticamente e non viene mostrato nel form. I controlli definitivi restano sempre lato server.</div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setDialogOpen(false)}>Annulla</Button><Button className="bg-[#7AB648] hover:bg-[#6aa03d]" onClick={submit} disabled={mutationPending}>{mutationPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{editingId ? "Salva modifiche" : "Crea promozione"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div></DashboardLayout>;
}
