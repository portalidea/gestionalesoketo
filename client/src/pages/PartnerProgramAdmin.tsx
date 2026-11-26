/**
 * Admin — Programma Partner SoKeto: crediti promo app dei rivenditori.
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CalendarCheck, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const eur = (value: string | number) =>
  `€ ${Number(value).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const RATES = ["4.00", "5.00", "10.00", "22.00"] as const;

export default function PartnerProgramAdmin() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const overview = trpc.partnerProgram.adminOverview.useQuery();
  const [creditRate, setCreditRate] = useState<string>("10.00");
  const [contributionRate, setContributionRate] = useState<string>("10.00");

  useEffect(() => {
    if (overview.data) {
      setCreditRate(overview.data.settings.creditVatRate);
      setContributionRate(overview.data.settings.contributionVatRate);
    }
  }, [overview.data]);

  const sync = trpc.partnerProgram.syncNow.useMutation({
    onSuccess: (r) => {
      if (r.ok) toast.success(`Sincronizzate ${r.events} convalide da ${r.stores} negozi`);
      else toast.error(`Sincronizzazione non riuscita: ${r.error}`);
      utils.partnerProgram.adminOverview.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const close = trpc.partnerProgram.closeMonth.useMutation({
    onSuccess: (r) => {
      toast.success(`Chiusura ${r.periodMonth.slice(0, 7)}: ${r.created} nuovi estratti`);
      utils.partnerProgram.adminOverview.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const saveSettings = trpc.partnerProgram.updateSettings.useMutation({
    onSuccess: () => { toast.success("Aliquote salvate (valgono per i prossimi estratti)"); utils.partnerProgram.adminOverview.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const data = overview.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Programma Partner — promo app</h1>
            <p className="text-muted-foreground">
              Crediti dei negozi per sconti app e buoni Card (50%), contributo 2,5% sugli acquisti Card. Applicati agli ordini E-Keto del mese successivo.
            </p>
          </div>
          {isAdmin && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                {sync.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Sincronizza ora
              </Button>
              <Button variant="outline" onClick={() => close.mutate({})} disabled={close.isPending}>
                {close.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarCheck className="mr-2 h-4 w-4" />}
                Chiudi mese precedente
              </Button>
            </div>
          )}
        </div>

        {overview.isLoading && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>}
        {overview.error && <p className="text-destructive">{overview.error.message}</p>}

        {data && (
          <>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Collegamento FoodApps4All</CardTitle>
                <CardDescription>
                  Sincronizzazione automatica ogni notte; chiusura del mese precedente ogni notte (idempotente). Dati dal {new Date(`${data.settings.importStartDate}T12:00:00`).toLocaleDateString("it-IT")}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  {data.settings.exportConfigured
                    ? <Badge className="bg-[#7AB648]">Configurato</Badge>
                    : <Badge variant="destructive">Non configurato</Badge>}
                  <span>Ultima sincronizzazione: {data.settings.lastSyncAt ? new Date(data.settings.lastSyncAt).toLocaleString("it-IT") : "mai"}</span>
                  {data.settings.lastSyncError && (
                    <span className="flex items-center gap-1 text-destructive"><AlertTriangle className="h-4 w-4" />Ultimo errore: {data.settings.lastSyncError}</span>
                  )}
                </div>
                {!data.settings.exportConfigured && (
                  <p className="text-muted-foreground">
                    Servono le variabili Vercel <code>FOODAPPS_PARTNER_EXPORT_URL</code> e <code>PARTNER_EXPORT_SECRET</code> (lo stesso segreto impostato sul server dell'app).
                  </p>
                )}
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">IVA abbuono</p>
                    <Select value={creditRate} onValueChange={setCreditRate} disabled={!isAdmin}>
                      <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>{RATES.map((r) => <SelectItem key={r} value={r}>{Number(r)}%</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">IVA contributo</p>
                    <Select value={contributionRate} onValueChange={setContributionRate} disabled={!isAdmin}>
                      <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>{RATES.map((r) => <SelectItem key={r} value={r}>{Number(r)}%</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  {isAdmin && (
                    <Button
                      size="sm"
                      disabled={saveSettings.isPending || (creditRate === data.settings.creditVatRate && contributionRate === data.settings.contributionVatRate)}
                      onClick={() => saveSettings.mutate({ creditVatRate: creditRate as typeof RATES[number], contributionVatRate: contributionRate as typeof RATES[number] })}
                    >
                      Salva aliquote
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Rivenditori abbinati</CardTitle>
                <CardDescription>L'abbinamento al negozio dell'app si imposta nella scheda del rivenditore (anagrafica E-Keto).</CardDescription>
              </CardHeader>
              <CardContent>
                {data.rows.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">Nessun rivenditore abbinato.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Rivenditore</TableHead>
                          <TableHead>Negozio app</TableHead>
                          <TableHead className="text-right">In maturazione</TableHead>
                          <TableHead className="text-right">Contributo in maturazione</TableHead>
                          <TableHead className="text-right">Credito disponibile</TableHead>
                          <TableHead className="text-right">Contributo da addebitare</TableHead>
                          <TableHead className="text-right">Contributo da fatturare a parte</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.rows.map((r) => (
                          <TableRow key={r.retailerId} className="cursor-pointer" onClick={() => navigate(`/retailers/${r.retailerId}`)}>
                            <TableCell className="font-medium">
                              {r.retailerName}
                              {r.wrongCompany && <Badge variant="destructive" className="ml-2">Non E-Keto</Badge>}
                            </TableCell>
                            <TableCell>{r.storeName ?? `#${r.storeId}`}</TableCell>
                            <TableCell className="text-right">{eur(r.accruingCreditGross)} <span className="text-xs text-muted-foreground">({r.accruingEvents})</span></TableCell>
                            <TableCell className="text-right">{eur(r.accruingContributionGross)}</TableCell>
                            <TableCell className="text-right font-medium text-[#2D5A27]">{eur(r.walletCreditNet)}</TableCell>
                            <TableCell className="text-right">{eur(r.walletContributionNet)}</TableCell>
                            <TableCell className={`text-right ${Number(r.contributionToInvoiceNet) > 0 ? "font-semibold text-amber-700" : ""}`}>{eur(r.contributionToInvoiceNet)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <p className="mt-2 text-xs text-muted-foreground">"In maturazione" IVA inclusa; credito e contributi disponibili/da addebitare IVA esclusa.</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {data.unmappedStores.length > 0 && (
              <Card className="border-amber-300 bg-amber-50/50">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg"><AlertTriangle className="h-5 w-5 text-amber-600" />Negozi app non abbinati</CardTitle>
                  <CardDescription>Queste convalide non generano credito finché il negozio non è abbinato a un rivenditore.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Negozio</TableHead>
                        <TableHead className="text-right">Convalide</TableHead>
                        <TableHead className="text-right">Credito (IVA incl.)</TableHead>
                        <TableHead className="text-right">Contributo (IVA incl.)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.unmappedStores.map((s) => (
                        <TableRow key={s.storeId}>
                          <TableCell>{s.storeName ?? `#${s.storeId}`}</TableCell>
                          <TableCell className="text-right">{s.events}</TableCell>
                          <TableCell className="text-right">{eur(s.creditGross)}</TableCell>
                          <TableCell className="text-right">{eur(s.contributionGross)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
