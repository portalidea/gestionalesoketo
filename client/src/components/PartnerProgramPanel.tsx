/**
 * Programma Partner SoKeto — borsellino promo app.
 * Usato nel portale partner (mode "mine") e nella scheda rivenditore admin.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { ChevronDown, ChevronRight, Loader2, Wallet } from "lucide-react";
import { useState } from "react";

const eur = (value: string | number) =>
  `€ ${Number(value).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateIt = (value: string | Date | null) =>
  value ? new Date(typeof value === "string" && value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString("it-IT") : "—";

const SOURCE_LABEL: Record<string, string> = {
  coupon: "Coupon app",
  card_purchase: "Acquisto Card",
  card_voucher: "Buono Card",
};

type Mode = { kind: "mine" } | { kind: "retailer"; retailerId: string };

function EventsTable({ mode, statementId }: { mode: Mode; statementId?: string }) {
  const mine = trpc.partnerProgram.myEvents.useQuery({ statementId }, { enabled: mode.kind === "mine" });
  const admin = trpc.partnerProgram.retailerEvents.useQuery(
    { retailerId: mode.kind === "retailer" ? mode.retailerId : "00000000-0000-0000-0000-000000000000", statementId },
    { enabled: mode.kind === "retailer" },
  );
  const query = mode.kind === "mine" ? mine : admin;
  if (query.isLoading) return <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  const rows = query.data ?? [];
  if (rows.length === 0) return <p className="py-3 text-sm text-muted-foreground">Nessuna convalida.</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Data</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Codice</TableHead>
            <TableHead className="text-right">Prodotti SoKeto</TableHead>
            <TableHead className="text-right">Sconto cliente</TableHead>
            <TableHead className="text-right">A tuo favore</TableHead>
            <TableHead className="text-right">Contributo 2,5%</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((e) => (
            <TableRow key={e.id} className={e.cancelledAt ? "opacity-50 line-through" : undefined}>
              <TableCell className="whitespace-nowrap">{new Date(e.occurredAt).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })}</TableCell>
              <TableCell>{SOURCE_LABEL[e.source] ?? e.source}{e.cancelledAt && <Badge variant="outline" className="ml-2">Annullata</Badge>}</TableCell>
              <TableCell className="max-w-[160px] truncate">{e.label ?? "—"}</TableCell>
              <TableCell className="text-right">{Number(e.purchaseGross) > 0 ? eur(e.purchaseGross) : "—"}</TableCell>
              <TableCell className="text-right">{Number(e.discountGross) > 0 ? eur(e.discountGross) : "—"}</TableCell>
              <TableCell className="text-right font-medium text-[#2D5A27]">{Number(e.creditGross) > 0 ? eur(e.creditGross) : "—"}</TableCell>
              <TableCell className="text-right">{Number(e.contributionGross) > 0 ? eur(e.contributionGross) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PartnerProgramPanel({ mode }: { mode: Mode }) {
  const mine = trpc.partnerProgram.myOverview.useQuery(undefined, { enabled: mode.kind === "mine" });
  const admin = trpc.partnerProgram.retailerOverview.useQuery(
    { retailerId: mode.kind === "retailer" ? mode.retailerId : "00000000-0000-0000-0000-000000000000" },
    { enabled: mode.kind === "retailer" },
  );
  const query = mode.kind === "mine" ? mine : admin;
  const [open, setOpen] = useState<string | null>(null);

  if (query.isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (query.error) return <p className="text-sm text-destructive">{query.error.message}</p>;
  const data = query.data;
  if (!data) return null;

  if (!data.enrolled) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {mode.kind === "mine"
            ? "Il tuo punto vendita non è ancora collegato all'app SoKeto. Contatta SoKeto per attivare il Programma Partner."
            : "Rivenditore non abbinato a un negozio dell'app (oppure non è l'anagrafica E-Keto)."}
        </CardContent>
      </Card>
    );
  }

  const walletCredit = Number(data.wallet.creditNet);
  const walletContribution = Number(data.wallet.contributionNet);
  const accruingCredit = Number(data.accruing.creditGross);
  const accruingContribution = Number(data.accruing.contributionGross);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-[#7AB648]/40 bg-[#7AB648]/10">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-[#2D5A27]"><Wallet className="h-4 w-4" />Credito disponibile ora</CardDescription>
            <CardTitle className="text-3xl text-[#2D5A27]">{eur(walletCredit)} <span className="text-sm font-normal text-muted-foreground">+ IVA</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            {walletCredit > 0 ? (
              <>
                <p>Si scala in automatico dal tuo prossimo ordine.</p>
                {data.wallet.nextExpiry && <p className="font-medium text-amber-700">Scade il {dateIt(data.wallet.nextExpiry)}: dopo quella data non è più utilizzabile.</p>}
              </>
            ) : (
              <p>Nessun credito da utilizzare in questo momento.</p>
            )}
            {walletContribution > 0 && (
              <p>Contributo Programma Partner da addebitare sul prossimo ordine: {eur(walletContribution)} + IVA.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>In maturazione (mese in corso)</CardDescription>
            <CardTitle className="text-3xl">{eur(accruingCredit)} <span className="text-sm font-normal text-muted-foreground">IVA incl.</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>{data.accruing.events} convalide registrate dall'app · prodotti SoKeto {eur(data.accruing.purchaseGross)}</p>
            {accruingContribution > 0 && <p>Contributo 2,5% sugli acquisti Card: {eur(accruingContribution)} IVA incl.</p>}
            <p>Diventa credito utilizzabile il 1° del mese prossimo.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Riepilogo mensile</CardTitle>
          <CardDescription>
            Ogni mese SoKeto ti riconosce il 50% degli sconti fatti con l'app e il valore dei buoni Card; tu riconosci il 2,5% sugli acquisti registrati con la Card.
            Gli importi diventano due righe nella fattura del tuo primo ordine del mese successivo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="rounded-md border">
            <button
              type="button"
              onClick={() => setOpen(open === "current" ? null : "current")}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
            >
              <span className="flex items-center gap-2 font-medium">
                {open === "current" ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Convalide non ancora chiuse
              </span>
              <Badge variant="outline">In maturazione</Badge>
            </button>
            {open === "current" && <div className="border-t px-3 pb-3"><EventsTable mode={mode} /></div>}
          </div>

          {data.statements.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">Il primo riepilogo mensile comparirà il 1° del mese prossimo.</p>
          )}
          {data.statements.map((s) => {
            const net = Number(s.creditNet) - Number(s.contributionNet);
            const statusBadge = s.status === "expired"
              ? <Badge variant="secondary">Scaduto</Badge>
              : s.status === "settled"
                ? <Badge className="bg-[#2D5A27]">Utilizzato</Badge>
                : <Badge className="bg-[#7AB648]">Disponibile fino al {dateIt(s.validUntil)}</Badge>;
            return (
              <div key={s.id} className="rounded-md border">
                <button
                  type="button"
                  onClick={() => setOpen(open === s.id ? null : s.id)}
                  className="grid w-full grid-cols-1 gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 md:grid-cols-[1.2fr_1fr_1fr_1fr_auto] md:items-center"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {open === s.id ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <span className="whitespace-nowrap capitalize">{s.periodLabel}</span>
                    <span className="whitespace-nowrap font-normal text-muted-foreground">({s.eventCount} convalide)</span>
                  </span>
                  <span>A tuo favore: <strong className="text-[#2D5A27]">{eur(Number(s.creditGross) + Number(s.adjustmentGross))}</strong> <span className="text-xs text-muted-foreground">IVA incl.</span></span>
                  <span>Contributo: <strong>{eur(s.contributionGross)}</strong> <span className="text-xs text-muted-foreground">IVA incl.</span></span>
                  <span>Netto in fattura: <strong>{eur(net)}</strong> <span className="text-xs text-muted-foreground">+ IVA</span></span>
                  <span>{statusBadge}</span>
                </button>
                {open === s.id && (
                  <div className="space-y-3 border-t px-3 pb-3 pt-2 text-sm">
                    <div className="grid gap-2 md:grid-cols-3">
                      <p>Credito: {eur(s.creditNet)} + IVA {Number(s.creditVatRate)}% · usato {eur(s.creditApplied)}{Number(s.creditRemaining) > 0 && <> · residuo {eur(s.creditRemaining)}</>}</p>
                      <p>Contributo: {eur(s.contributionNet)} + IVA {Number(s.contributionVatRate)}% · addebitato {eur(s.contributionCharged)}</p>
                      {Number(s.adjustmentGross) < 0 && <p className="text-amber-700">Rettifica per convalide annullate dopo la chiusura: {eur(s.adjustmentGross)}</p>}
                    </div>
                    {s.orders.length > 0 && (
                      <p className="text-muted-foreground">
                        Applicato agli ordini: {s.orders.map((o) => o.orderNumber).join(", ")}
                      </p>
                    )}
                    <EventsTable mode={mode} statementId={s.id} />
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
      {mode.kind === "retailer" && data.lastSyncAt && (
        <p className="text-xs text-muted-foreground">Ultima sincronizzazione app: {new Date(data.lastSyncAt).toLocaleString("it-IT")}</p>
      )}
    </div>
  );
}

export function PartnerWalletBadge() {
  const query = trpc.partnerProgram.myOverview.useQuery(undefined, { retry: false });
  const credit = Number(query.data?.wallet.creditNet ?? 0);
  if (!query.data?.enrolled || credit <= 0) return null;
  return (
    <Card className="border-[#7AB648]/40 bg-[#7AB648]/10">
      <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[#2D5A27]">Credito promo app disponibile</p>
          <p className="text-xs text-muted-foreground">
            Si scala in automatico dal prossimo ordine{query.data.wallet.nextExpiry ? ` · scade il ${dateIt(query.data.wallet.nextExpiry)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-2xl font-bold text-[#2D5A27]">{eur(credit)} <span className="text-sm font-normal">+ IVA</span></p>
          <Button variant="outline" size="sm" onClick={() => { window.location.href = "/partner-portal/promo"; }}>Dettagli</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Scheda rivenditore (admin): abbinamento negozio app + borsellino. */
export function PartnerProgramRetailerSection({ retailerId, canEdit }: { retailerId: string; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const overview = trpc.partnerProgram.retailerOverview.useQuery({ retailerId });
  const [editing, setEditing] = useState(false);
  const stores = trpc.partnerProgram.foodappsStores.useQuery(undefined, { enabled: editing, retry: false });
  const setStore = trpc.partnerProgram.setRetailerStore.useMutation({
    onSuccess: async () => {
      setEditing(false);
      await utils.partnerProgram.retailerOverview.invalidate({ retailerId });
    },
  });
  const current = overview.data?.storeId ?? null;

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Programma Partner — promo app</CardTitle>
          {canEdit && overview.data?.isBillingCompany && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {current ? "Cambia negozio app" : "Abbina negozio app"}
            </Button>
          )}
        </div>
        <CardDescription>
          {current ? `Abbinato al negozio app #${current}.` : "Nessun negozio dell'app abbinato."}
          {overview.data && !overview.data.isBillingCompany && " Il borsellino vale solo sull'anagrafica E-Keto del rivenditore."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {editing && (
          <div className="space-y-2 rounded-md border p-3">
            {stores.isLoading && <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Lettura negozi da FoodApps4All…</p>}
            {stores.error && <p className="text-sm text-destructive">{stores.error.message}</p>}
            {stores.data && !stores.data.configured && <p className="text-sm text-muted-foreground">Collegamento FoodApps4All non ancora configurato.</p>}
            {stores.data?.configured && (
              <div className="flex flex-wrap gap-2">
                <select
                  className="h-9 min-w-[260px] rounded-md border bg-background px-2 text-sm"
                  defaultValue={current ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setStore.mutate({ retailerId, storeId: v ? Number(v) : null });
                  }}
                  disabled={setStore.isPending}
                >
                  <option value="">— Nessun negozio —</option>
                  {stores.data.stores.map((s) => (
                    <option key={s.storeId} value={s.storeId}>{s.name}{s.city ? ` (${s.city})` : ""} · #{s.storeId}</option>
                  ))}
                </select>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Annulla</Button>
              </div>
            )}
            {setStore.error && <p className="text-sm text-destructive">{setStore.error.message}</p>}
          </div>
        )}
        {current && overview.data?.isBillingCompany && <PartnerProgramPanel mode={{ kind: "retailer", retailerId }} />}
      </CardContent>
    </Card>
  );
}
