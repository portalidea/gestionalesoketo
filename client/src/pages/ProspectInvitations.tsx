import { Check, Copy, Link2, Loader2, Mail, RefreshCw, Send, ShieldOff } from "lucide-react";
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

type InvitationRow = {
  id: string;
  legalName: string;
  contactName: string;
  email: string;
  phone: string;
  token: string;
  status: string;
  tokenExpiresAt: Date | string;
  createdAt: Date | string;
  lastOpenedAt: Date | string | null;
  notificationStatus: string;
  notificationError: string | null;
  simulationId: string | null;
};

const origin = () => window.location.origin;
const date = (value: Date | string | null) => value ? new Date(value).toLocaleString("it-IT") : "—";
const statusVariant = (status: string) => status === "submitted" ? "default" : status === "revoked" || status === "expired" ? "destructive" : "secondary";

export default function ProspectInvitations() {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({ legalName: "", contactName: "", email: "", phone: "" });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const invitations = trpc.prospectSimulator.adminInvitationList.useQuery();
  const invitationRows = (invitations.data ?? []) as InvitationRow[];
  const refresh = () => Promise.all([
    utils.prospectSimulator.adminInvitationList.invalidate(),
    utils.prospectSimulator.adminList.invalidate(),
  ]);
  const create = trpc.prospectSimulator.adminCreateInvitation.useMutation({
    onSuccess: async () => {
      setForm({ legalName: "", contactName: "", email: "", phone: "" });
      await refresh();
    },
  });
  const resend = trpc.prospectSimulator.adminResendInvitation.useMutation({ onSuccess: refresh });
  const regenerate = trpc.prospectSimulator.adminRegenerateInvitation.useMutation({ onSuccess: refresh });
  const revoke = trpc.prospectSimulator.adminRevokeInvitation.useMutation({ onSuccess: refresh });
  const update = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const canCreate = Object.values(form).every(Boolean);
  const copyLink = async (id: string, token: string) => {
    await navigator.clipboard.writeText(`${origin()}/ordine-rivenditore/${token}`);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1800);
  };

  return <DashboardLayout><div className="mx-auto max-w-7xl space-y-6">
    <div><p className="text-sm font-medium text-primary">Modulo ordine prospect</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Inviti personali</h1><p className="mt-2 text-muted-foreground">Ogni link è valido 15 giorni, può essere inoltrato manualmente e consente una sola richiesta d’ordine.</p></div>
    <Card><CardHeader><CardTitle>Crea invito</CardTitle><CardDescription>L’email è tentata subito, ma il link resta sempre disponibile per l’invio manuale.</CardDescription></CardHeader><CardContent><form className="grid gap-4 md:grid-cols-2 xl:grid-cols-5" onSubmit={(event) => { event.preventDefault(); if (canCreate) create.mutate({ ...form, origin: origin() }); }}><div><Label htmlFor="invitation-company">Ragione sociale</Label><Input id="invitation-company" className="mt-1" value={form.legalName} onChange={(event) => update("legalName", event.target.value)} /></div><div><Label htmlFor="invitation-contact">Referente</Label><Input id="invitation-contact" className="mt-1" value={form.contactName} onChange={(event) => update("contactName", event.target.value)} /></div><div><Label htmlFor="invitation-email">Email</Label><Input id="invitation-email" type="email" className="mt-1" value={form.email} onChange={(event) => update("email", event.target.value)} /></div><div><Label htmlFor="invitation-phone">Telefono</Label><Input id="invitation-phone" className="mt-1" value={form.phone} onChange={(event) => update("phone", event.target.value)} /></div><div className="flex items-end"><Button className="w-full" disabled={!canCreate || create.isPending}>{create.isPending ? <Loader2 className="animate-spin" /> : <Send />}Crea e invia</Button></div></form>{create.error && <p className="mt-3 text-sm text-destructive">{create.error.message}</p>}</CardContent></Card>
    <Card><CardHeader><CardTitle>Inviti creati</CardTitle><CardDescription>Un fallimento email non impedisce la copia del collegamento personale.</CardDescription></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[1120px] text-sm"><thead className="border-y bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-5 py-3">Prospect</th><th className="px-4 py-3">Stato</th><th className="px-4 py-3">Notifica</th><th className="px-4 py-3">Creato</th><th className="px-4 py-3">Ultima apertura</th><th className="px-4 py-3">Richiesta</th><th className="px-4 py-3">Azioni</th></tr></thead><tbody>{invitations.isLoading ? <tr><td colSpan={7} className="px-5 py-10 text-center text-muted-foreground">Caricamento inviti…</td></tr> : invitationRows.length === 0 ? <tr><td colSpan={7} className="px-5 py-10 text-center text-muted-foreground">Nessun invito creato.</td></tr> : invitationRows.map((invite) => <tr key={invite.id} className="border-b last:border-0"><td className="px-5 py-4"><strong>{invite.legalName}</strong><span className="mt-0.5 block text-xs text-muted-foreground">{invite.contactName} · {invite.email}<br />{invite.phone}</span></td><td className="px-4 py-4"><Badge variant={statusVariant(invite.status)}>{invite.status}</Badge><span className="mt-1 block text-xs text-muted-foreground">Scade {date(invite.tokenExpiresAt)}</span></td><td className="px-4 py-4"><Badge variant={invite.notificationStatus === "sent" ? "default" : invite.notificationStatus === "failed" ? "destructive" : "secondary"}>{invite.notificationStatus}</Badge>{invite.notificationError && <span className="mt-1 block max-w-44 truncate text-xs text-destructive" title={invite.notificationError}>{invite.notificationError}</span>}</td><td className="px-4 py-4 text-muted-foreground">{date(invite.createdAt)}</td><td className="px-4 py-4 text-muted-foreground">{date(invite.lastOpenedAt)}</td><td className="px-4 py-4">{invite.simulationId ? <Badge variant="outline">Ricevuta</Badge> : "—"}</td><td className="px-4 py-4"><div className="flex gap-1"><Button variant="outline" size="icon" title="Copia link" onClick={() => copyLink(invite.id, invite.token)}>{copiedId === invite.id ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}</Button><Button variant="outline" size="icon" title="Reinvia email" disabled={invite.status === "revoked" || invite.status === "submitted" || resend.isPending} onClick={() => resend.mutate({ id: invite.id, origin: origin() })}><Mail className="h-4 w-4" /></Button><Button variant="outline" size="icon" title="Rigenera link" disabled={invite.status === "submitted" || regenerate.isPending} onClick={() => regenerate.mutate({ id: invite.id, origin: origin() })}><RefreshCw className="h-4 w-4" /></Button><Button variant="outline" size="icon" title="Revoca invito" disabled={invite.status === "revoked" || invite.status === "submitted" || revoke.isPending} onClick={() => revoke.mutate({ id: invite.id })}><ShieldOff className="h-4 w-4" /></Button></div></td></tr>)}</tbody></table></div><div className="border-t px-5 py-3 text-xs text-muted-foreground"><Link2 className="mr-1 inline h-3.5 w-3.5" />Copia link usa l’origine corrente del browser, senza dominio hard-coded.</div></CardContent></Card>
  </div></DashboardLayout>;
}
