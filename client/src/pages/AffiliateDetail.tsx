import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  ArrowLeft,
  Edit,
  Euro,
  Users,
  TrendingUp,
  CheckCircle,
  UserPlus,
  RefreshCw,
  Mail,
} from "lucide-react";

export default function AffiliateDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [payDialog, setPayDialog] = useState<{ open: boolean; ids: string[] }>({
    open: false,
    ids: [],
  });
  const [paymentRef, setPaymentRef] = useState("");
  const [inviteDialog, setInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [manualDialog, setManualDialog] = useState(false);
  const [manualForm, setManualForm] = useState({
    activityName: "",
    commissionDate: new Date().toISOString().slice(0, 10),
    baseAmount: "",
    commissionRate: "",
    commissionType: "",
    notes: "",
  });

  const { data: affiliate, isLoading } = trpc.affiliates.getById.useQuery(
    { id: params.id! },
    { enabled: !!params.id }
  );

  const { data: commissionsData } = trpc.affiliates.commissionsList.useQuery(
    { affiliateId: params.id!, status: "pending" },
    { enabled: !!params.id }
  );

  const { data: portalUsers } = trpc.affiliates.listUsers.useQuery(
    { affiliateId: params.id! },
    { enabled: !!params.id }
  );

  const inviteUserMutation = trpc.affiliates.inviteUser.useMutation({
    onSuccess: () => {
      toast.success("Invito inviato con successo");
      utils.affiliates.listUsers.invalidate({ affiliateId: params.id! });
      setInviteDialog(false);
      setInviteEmail("");
      setInviteName("");
    },
    onError: (err) => toast.error("Errore: " + err.message),
  });

  const resendInviteMutation = trpc.affiliates.resendInvite.useMutation({
    onSuccess: () => toast.success("Invito reinviato"),
    onError: (err) => toast.error("Errore: " + err.message),
  });

  const markPaidMutation = trpc.affiliates.markPaid.useMutation({
    onSuccess: () => {
      toast.success("Commissioni segnate come pagate");
      utils.affiliates.getById.invalidate({ id: params.id! });
      utils.affiliates.commissionsList.invalidate();
      setPayDialog({ open: false, ids: [] });
      setPaymentRef("");
    },
    onError: (err) => {
      toast.error("Errore: " + err.message);
    },
  });

  const createManualCommissionMutation = trpc.affiliates.createManualCommission.useMutation({
    onSuccess: () => {
      toast.success("Provvigione manuale aggiunta");
      utils.affiliates.getById.invalidate({ id: params.id! });
      utils.affiliates.commissionsList.invalidate();
      setManualDialog(false);
      setManualForm({ activityName: "", commissionDate: new Date().toISOString().slice(0, 10), baseAmount: "", commissionRate: "", commissionType: "", notes: "" });
    },
    onError: (err) => toast.error("Errore: " + err.message),
  });

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Caricamento...</div>;
  }

  if (!affiliate) {
    return <div className="text-center py-8 text-muted-foreground">Affiliato non trovato</div>;
  }

  const pendingCommissions = commissionsData?.items ?? [];
  const totalPending = pendingCommissions.reduce(
    (sum: number, c: any) => sum + Number(c.commissionAmount),
    0
  );

  const handlePayAll = () => {
    const ids = pendingCommissions.map((c: any) => c.id);
    if (ids.length === 0) {
      toast.info("Nessuna commissione pendente");
      return;
    }
    setPayDialog({ open: true, ids });
  };

  const confirmPay = () => {
    markPaidMutation.mutate({
      commissionIds: payDialog.ids,
      paymentReference: paymentRef || "Pagamento manuale",
    });
  };

  const manualBaseAmount = Number(manualForm.baseAmount);
  const manualCommissionRate = Number(manualForm.commissionRate);
  const manualCommissionAmount = Number.isFinite(manualBaseAmount) && Number.isFinite(manualCommissionRate)
    ? manualBaseAmount * manualCommissionRate / 100
    : null;
  const submitManualCommission = () => {
    createManualCommissionMutation.mutate({
      affiliateId: params.id!,
      activityName: manualForm.activityName,
      commissionDate: manualForm.commissionDate,
      baseAmount: manualBaseAmount,
      commissionRate: manualCommissionRate,
      commissionType: manualForm.commissionType,
      notes: manualForm.notes || undefined,
    });
  };

  return (
    <DashboardLayout>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/affiliates")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{affiliate.name}</h1>
            <p className="text-muted-foreground">
              Codice: <code className="bg-muted px-2 py-0.5 rounded">{affiliate.referralCode}</code>
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/affiliates/${params.id}/edit`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Modifica
            </Button>
          </Link>
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Badge
                variant={affiliate.status === "active" ? "default" : "secondary"}
              >
                {affiliate.status === "active" ? "Attivo" : "Inattivo"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Dal {new Date(affiliate.createdAt).toLocaleDateString("it-IT")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Commissioni</span>
            </div>
            <p className="text-lg font-bold mt-1">
              {affiliate.firstOrderRate}% / {affiliate.recurringRate}%
            </p>
            <p className="text-xs text-muted-foreground">Primo / Ricorrente</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Rivenditori</span>
            </div>
            <p className="text-2xl font-bold mt-1">{affiliate.stats?.retailersCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Euro className="h-4 w-4 text-orange-500" />
              <span className="text-sm text-muted-foreground">Pendenti</span>
            </div>
            <p className="text-2xl font-bold mt-1">€{totalPending.toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Stats */}
      {affiliate.stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">Totale Guadagnato</span>
              <p className="text-xl font-bold mt-1">€{affiliate.stats.totalEarned.toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">Totale Pagato</span>
              <p className="text-xl font-bold mt-1 text-green-600">€{affiliate.stats.totalPaid.toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">Totale Pendente</span>
              <p className="text-xl font-bold mt-1 text-orange-600">€{affiliate.stats.totalPending.toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">N. Commissioni</span>
              <p className="text-xl font-bold mt-1">{affiliate.stats.commissionsCount}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Dettagli contatto */}
      <Card>
        <CardHeader>
          <CardTitle>Dettagli</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            {affiliate.email && (
              <div>
                <span className="text-muted-foreground">Email:</span>{" "}
                <span className="font-medium">{affiliate.email}</span>
              </div>
            )}
            {affiliate.phone && (
              <div>
                <span className="text-muted-foreground">Telefono:</span>{" "}
                <span className="font-medium">{affiliate.phone}</span>
              </div>
            )}
            {affiliate.taxCode && (
              <div>
                <span className="text-muted-foreground">Codice Fiscale:</span>{" "}
                <span className="font-medium">{affiliate.taxCode}</span>
              </div>
            )}
            {affiliate.vatNumber && (
              <div>
                <span className="text-muted-foreground">P.IVA:</span>{" "}
                <span className="font-medium">{affiliate.vatNumber}</span>
              </div>
            )}
            {affiliate.iban && (
              <div>
                <span className="text-muted-foreground">IBAN:</span>{" "}
                <span className="font-mono text-xs">{affiliate.iban}</span>
              </div>
            )}
            {affiliate.notes && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Note:</span>{" "}
                <span>{affiliate.notes}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Commissioni Pendenti */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Commissioni Pendenti</CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setManualDialog(true)}>
                <Euro className="mr-2 h-4 w-4" />
                Aggiungi manuale
              </Button>
              {pendingCommissions.length > 0 && (
                <Button size="sm" onClick={handlePayAll}>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Paga Tutte (€{totalPending.toFixed(2)})
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {pendingCommissions.length === 0 ? (
            <p className="text-center py-4 text-muted-foreground">
              Nessuna commissione pendente
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Origine</TableHead>
                  <TableHead>Ordine</TableHead>
                  <TableHead>Attività / Rivenditore</TableHead>
                  <TableHead className="text-right">Importo base</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Commissione</TableHead>
                  <TableHead>Tipo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingCommissions.map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-sm">
                      {new Date(c.commissionDate || c.pendingAt).toLocaleDateString("it-IT")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.origin === "manual" ? "secondary" : "outline"}>{c.origin === "manual" ? "Manuale" : "Da ordine"}</Badge>
                    </TableCell>
                    <TableCell>
                      {c.orderId ? <Link href={`/orders/${c.orderId}`}><span className="text-primary hover:underline cursor-pointer text-sm">#{c.orderNumber || c.orderId.slice(0, 8)}</span></Link> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">{c.activityName || c.retailerName || "—"}<span className="block text-xs text-muted-foreground">{c.origin === "manual" ? c.commissionType : ""}</span></TableCell>
                    <TableCell className="text-right text-sm">
                      €{Number(c.baseAmount ?? c.orderTotal).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {c.commissionRate}%
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      €{Number(c.commissionAmount).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.isFirstOrder ? "default" : "secondary"} className="text-xs">
                        {c.isFirstOrder ? "Primo" : "Ricorrente"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={manualDialog} onOpenChange={setManualDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Aggiungi provvigione manuale</DialogTitle>
            <DialogDescription>La company di riferimento è quella attiva nel gestionale. L’importo della provvigione viene calcolato dal sistema.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-3 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="manualActivity">Nome attività</Label><Input id="manualActivity" value={manualForm.activityName} onChange={(e) => setManualForm({ ...manualForm, activityName: e.target.value })} placeholder="Es. segnalazione commerciale" /></div>
            <div className="space-y-2"><Label htmlFor="manualDate">Data</Label><Input id="manualDate" type="date" value={manualForm.commissionDate} onChange={(e) => setManualForm({ ...manualForm, commissionDate: e.target.value })} /></div>
            <div className="space-y-2"><Label htmlFor="manualType">Causale / tipo</Label><Input id="manualType" value={manualForm.commissionType} onChange={(e) => setManualForm({ ...manualForm, commissionType: e.target.value })} placeholder="Es. segnalazione" /></div>
            <div className="space-y-2"><Label htmlFor="manualBase">Importo base (€)</Label><Input id="manualBase" type="number" min="0.01" step="0.01" value={manualForm.baseAmount} onChange={(e) => setManualForm({ ...manualForm, baseAmount: e.target.value })} /></div>
            <div className="space-y-2"><Label htmlFor="manualRate">Percentuale (%)</Label><Input id="manualRate" type="number" min="0" max="100" step="0.01" value={manualForm.commissionRate} onChange={(e) => setManualForm({ ...manualForm, commissionRate: e.target.value })} /></div>
            <div className="rounded-md border bg-muted/40 p-3 text-sm sm:col-span-2"><span className="text-muted-foreground">Provvigione calcolata</span><p className="mt-1 text-lg font-bold">{manualCommissionAmount === null ? "—" : `€${manualCommissionAmount.toFixed(2)}`}</p></div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="manualNotes">Note</Label><Textarea id="manualNotes" value={manualForm.notes} onChange={(e) => setManualForm({ ...manualForm, notes: e.target.value })} placeholder="Note interne opzionali" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualDialog(false)}>Annulla</Button>
            <Button onClick={submitManualCommission} disabled={!manualForm.activityName || !manualForm.commissionDate || !manualForm.commissionType || !Number.isFinite(manualBaseAmount) || manualBaseAmount <= 0 || !Number.isFinite(manualCommissionRate) || manualCommissionRate < 0 || manualCommissionRate > 100 || createManualCommissionMutation.isPending}>{createManualCommissionMutation.isPending ? "Salvataggio…" : "Aggiungi provvigione"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rivenditori associati */}
      <Card>
        <CardHeader>
          <CardTitle>Rivenditori Associati ({affiliate.retailers?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!affiliate.retailers || affiliate.retailers.length === 0 ? (
            <p className="text-center py-4 text-muted-foreground">
              Nessun rivenditore associato a questo affiliato.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Citt\u00e0</TableHead>
                  <TableHead>Associato il</TableHead>
                  <TableHead>Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {affiliate.retailers.map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>{r.city || "-"}</TableCell>
                    <TableCell>
                      {r.affiliateAssignedAt
                        ? new Date(r.affiliateAssignedAt).toLocaleDateString("it-IT")
                        : new Date(r.createdAt).toLocaleDateString("it-IT")}
                    </TableCell>
                    <TableCell>
                      <Link href={`/retailers/${r.id}`}>
                        <span className="text-primary hover:underline cursor-pointer text-sm">
                          Apri scheda
                        </span>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Utenti Portale */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Utenti Portale
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => setInviteDialog(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              Invita Utente
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!portalUsers || portalUsers.length === 0 ? (
            <p className="text-center py-4 text-muted-foreground">
              Nessun utente portale. Invita un utente per dare accesso al portale affiliati.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Ruolo</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {portalUsers.map((u: any) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name || "-"}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{u.role === "affiliate_admin" ? "Admin" : "Utente"}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.lastLoginAt ? "default" : "outline"}>
                        {u.lastLoginAt ? "Attivo" : "Invitato"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {!u.lastLoginAt && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => resendInviteMutation.mutate({ userId: u.id })}
                          disabled={resendInviteMutation.isPending}
                          title="Reinvia invito"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Invite Dialog */}
      <Dialog open={inviteDialog} onOpenChange={setInviteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invita Utente Portale Affiliato</DialogTitle>
            <DialogDescription>
              L'utente riceverà un'email con un link per accedere al portale affiliati.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="inviteName">Nome</Label>
              <Input
                id="inviteName"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Mario Rossi"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteEmail">Email</Label>
              <Input
                id="inviteEmail"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="mario@esempio.it"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteDialog(false)}>
              Annulla
            </Button>
            <Button
              onClick={() => inviteUserMutation.mutate({
                affiliateId: params.id!,
                email: inviteEmail,
                name: inviteName || undefined,
              })}
              disabled={!inviteEmail || inviteUserMutation.isPending}
            >
              <Mail className="mr-2 h-4 w-4" />
              {inviteUserMutation.isPending ? "Invio..." : "Invia Invito"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pay Dialog */}
      <Dialog open={payDialog.open} onOpenChange={(o) => setPayDialog({ ...payDialog, open: o })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conferma Pagamento Commissioni</DialogTitle>
            <DialogDescription>
              Stai per segnare {payDialog.ids.length} commissioni come pagate per un totale di €
              {totalPending.toFixed(2)}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="paymentRef">Riferimento Pagamento</Label>
              <Input
                id="paymentRef"
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                placeholder="Es. Bonifico 15/05/2026"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDialog({ open: false, ids: [] })}>
              Annulla
            </Button>
            <Button onClick={confirmPay} disabled={markPaidMutation.isPending}>
              {markPaidMutation.isPending ? "Pagamento..." : "Conferma Pagamento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </DashboardLayout>
  );
}
