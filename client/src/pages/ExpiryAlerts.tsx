import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

type RunRow = { id: string; runDate: string; mode: string; status: string; retailersEvaluated: number; itemsFlagged: number };
type NotificationRow = { id: string; retailerName: string; status: string; skipReason: string | null; responseType: string | null; itemsCount: number };
type SuppressionRow = { retailerName: string; productName: string; oldBatchCode: string; oldDeliveryAt: string; newBatchCode: string; newDeliveryAt: string; toleranceDays: number };

export default function ExpiryAlerts() {
  const utils = trpc.useUtils();
  const settings = trpc.expiryAlerts.getSettings.useQuery();
  const runs = trpc.expiryAlerts.listRuns.useQuery({ limit: 30 });
  const [threshold, setThreshold] = useState<number | null>(null);
  const [reorderToleranceDays, setReorderToleranceDays] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const notifications = trpc.expiryAlerts.getNotifications.useQuery({ runId: selectedRunId ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(selectedRunId) });
  const suppressions = trpc.expiryAlerts.getReorderSuppressions.useQuery({ runId: selectedRunId ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(selectedRunId) });
  const updateSettings = trpc.expiryAlerts.updateSettings.useMutation({ onSuccess: () => utils.expiryAlerts.getSettings.invalidate() });
  const currentThreshold = threshold ?? settings.data?.minPiecesThreshold ?? 5;
  const currentTolerance = reorderToleranceDays ?? settings.data?.reorderToleranceDays ?? 7;
  const runRows = (runs.data ?? []) as RunRow[];
  const notificationRows = (notifications.data ?? []) as NotificationRow[];
  const suppressionRows = (suppressions.data ?? []) as SuppressionRow[];

  return <DashboardLayout>
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header><p className="text-sm font-semibold text-emerald-700">M13 · modalità sicura</p><h1 className="text-3xl font-bold">Alert scadenze rivenditori</h1><p className="mt-2 text-muted-foreground">Gli alert considerano solo l'ultimo riassortimento per prodotto; l’invio email reale è disabilitato.</p></header>
      <section className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="text-sm">Soglia minima (pezzi)<input type="number" min="1" className="ml-2 w-24 rounded border px-2 py-1" value={currentThreshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
        <label className="text-sm">Tolleranza riordino (giorni)<input type="number" min="0" max="90" className="ml-2 w-20 rounded border px-2 py-1" value={currentTolerance} onChange={(e) => setReorderToleranceDays(Number(e.target.value))} /></label>
        <button className="rounded border px-3 py-2" onClick={() => updateSettings.mutate({ minPiecesThreshold: currentThreshold, reorderToleranceDays: currentTolerance })} disabled={updateSettings.isPending}>Salva impostazioni</button>
      </section>
      <section className="rounded-lg border bg-card overflow-hidden"><div className="p-4 border-b"><h2 className="font-semibold">Storico run</h2></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className="p-3 text-left">Data</th><th className="p-3 text-left">Modalità</th><th className="p-3 text-left">Stato</th><th className="p-3 text-right">Rivenditori</th><th className="p-3 text-right">Righe</th></tr></thead><tbody>{runRows.map((run) => <tr key={run.id} onClick={() => setSelectedRunId(run.id)} className="border-t cursor-pointer hover:bg-muted/40"><td className="p-3">{run.runDate}</td><td className="p-3">{run.mode}</td><td className="p-3">{run.status}</td><td className="p-3 text-right">{run.retailersEvaluated}</td><td className="p-3 text-right">{run.itemsFlagged}</td></tr>)}</tbody></table></div></section>
      {selectedRunId && <><section className="rounded-lg border bg-card overflow-hidden"><div className="p-4 border-b"><h2 className="font-semibold">Notifiche del run</h2><p className="text-sm text-muted-foreground">L'invio reale è disabilitato. Le segnalazioni volontarie esaurito restano tracciate per lotto.</p></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className="p-3 text-left">Rivenditore</th><th className="p-3 text-left">Stato</th><th className="p-3 text-left">Esito</th><th className="p-3 text-right">Lotti</th></tr></thead><tbody>{notificationRows.map((n) => <tr key={n.id} className="border-t"><td className="p-3">{n.retailerName}</td><td className="p-3">{n.status}</td><td className="p-3">{n.skipReason ?? (n.responseType === "sold_out" ? "Segnalazione esaurito ricevuta" : "—")}</td><td className="p-3 text-right">{n.itemsCount}</td></tr>)}</tbody></table></div></section>
      <section className="rounded-lg border bg-card overflow-hidden"><div className="p-4 border-b"><h2 className="font-semibold">Lotti soppressi per riordino</h2><p className="text-sm text-muted-foreground">Inferenza: il lotto precedente non viene incluso nell'alert; la giacenza non viene modificata.</p></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className="p-3 text-left">Rivenditore</th><th className="p-3 text-left">Prodotto</th><th className="p-3 text-left">Lotto vecchio</th><th className="p-3 text-left">Consegna</th><th className="p-3 text-left">Lotto nuovo</th><th className="p-3 text-left">Consegna</th><th className="p-3 text-right">Tolleranza</th></tr></thead><tbody>{suppressionRows.map((s, index) => <tr key={`${s.oldBatchCode}-${index}`} className="border-t"><td className="p-3">{s.retailerName}</td><td className="p-3">{s.productName}</td><td className="p-3">{s.oldBatchCode}</td><td className="p-3">{new Date(s.oldDeliveryAt).toLocaleDateString()}</td><td className="p-3">{s.newBatchCode}</td><td className="p-3">{new Date(s.newDeliveryAt).toLocaleDateString()}</td><td className="p-3 text-right">{s.toleranceDays} gg</td></tr>)}</tbody></table></div></section></>}
    </div>
  </DashboardLayout>;
}
