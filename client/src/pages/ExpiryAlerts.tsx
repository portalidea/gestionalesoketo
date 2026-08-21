import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

type RunRow = { id: string; runDate: string; mode: string; status: string; retailersEvaluated: number; itemsFlagged: number };
type NotificationRow = { id: string; retailerName: string; status: string; skipReason: string | null; itemsCount: number };

export default function ExpiryAlerts() {
  const utils = trpc.useUtils();
  const settings = trpc.expiryAlerts.getSettings.useQuery();
  const runs = trpc.expiryAlerts.listRuns.useQuery({ limit: 30 });
  const [threshold, setThreshold] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const notifications = trpc.expiryAlerts.getNotifications.useQuery({ runId: selectedRunId ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(selectedRunId) });
  const dryRun = trpc.expiryAlerts.runAlignment.useMutation({ onSuccess: () => utils.expiryAlerts.listRuns.invalidate() });
  const updateSettings = trpc.expiryAlerts.updateSettings.useMutation({ onSuccess: () => utils.expiryAlerts.getSettings.invalidate() });
  const currentThreshold = threshold ?? settings.data?.minPiecesThreshold ?? 5;
  const runRows = (runs.data ?? []) as RunRow[];
  const notificationRows = (notifications.data ?? []) as NotificationRow[];

  return <DashboardLayout>
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header><p className="text-sm font-semibold text-emerald-700">M13 · modalità sicura</p><h1 className="text-3xl font-bold">Alert scadenze rivenditori</h1><p className="mt-2 text-muted-foreground">Il dry-run crea solo snapshot e notifiche: l’invio email reale è disabilitato.</p></header>
      <section className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="text-sm">Soglia minima (pezzi)<input type="number" min="1" className="ml-2 w-24 rounded border px-2 py-1" value={currentThreshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
        <button className="rounded border px-3 py-2" onClick={() => updateSettings.mutate({ minPiecesThreshold: currentThreshold })} disabled={updateSettings.isPending}>Salva soglia</button>
        <button className="rounded bg-emerald-700 px-3 py-2 text-white disabled:opacity-50" onClick={() => dryRun.mutate({})} disabled={dryRun.isPending}>{dryRun.isPending ? "Elaborazione…" : "Avvia dry-run alignment"}</button>
      </section>
      {dryRun.data && <div className="rounded border border-emerald-200 bg-emerald-50 p-4 text-sm">Run {dryRun.data.runId}: {dryRun.data.retailersEvaluated} rivenditori, {dryRun.data.itemsFlagged} righe snapshot, 0 email inviate.</div>}
      <section className="rounded-lg border bg-card overflow-hidden"><div className="p-4 border-b"><h2 className="font-semibold">Storico run</h2></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className="p-3 text-left">Data</th><th className="p-3 text-left">Modalità</th><th className="p-3 text-left">Stato</th><th className="p-3 text-right">Rivenditori</th><th className="p-3 text-right">Righe</th></tr></thead><tbody>{runRows.map((run) => <tr key={run.id} onClick={() => setSelectedRunId(run.id)} className="border-t cursor-pointer hover:bg-muted/40"><td className="p-3">{run.runDate}</td><td className="p-3">{run.mode}</td><td className="p-3">{run.status}</td><td className="p-3 text-right">{run.retailersEvaluated}</td><td className="p-3 text-right">{run.itemsFlagged}</td></tr>)}</tbody></table></div></section>
      {selectedRunId && <section className="rounded-lg border bg-card overflow-hidden"><div className="p-4 border-b"><h2 className="font-semibold">Notifiche del run</h2></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className="p-3 text-left">Rivenditore</th><th className="p-3 text-left">Stato</th><th className="p-3 text-left">Motivo</th><th className="p-3 text-right">Righe</th></tr></thead><tbody>{notificationRows.map((n) => <tr key={n.id} className="border-t"><td className="p-3">{n.retailerName}</td><td className="p-3">{n.status}</td><td className="p-3">{n.skipReason ?? "—"}</td><td className="p-3 text-right">{n.itemsCount}</td></tr>)}</tbody></table></div></section>}
    </div>
  </DashboardLayout>;
}
