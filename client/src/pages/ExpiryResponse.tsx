import { useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";

type ResponseItem = { id: string; productName: string; batchCode: string; expiryDate: string; quantityPieces: number; piecesPerUnit: number; declaredQuantity: number | null; deliveryStatus: string; adjustmentApplied: boolean };
type ResponseNotification = { retailerName: string; respondedAt: string | null; tokenExpiresAt: string };

export default function ExpiryResponse() {
  const [, params] = useRoute("/scadenze/:token");
  const token = params?.token ?? "";
  const response = trpc.expiryAlerts.getResponseByToken.useQuery({ token }, { enabled: Boolean(token) });
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const submit = trpc.expiryAlerts.submitResponse.useMutation({ onSuccess: () => response.refetch() });

  if (response.isLoading) return <main className="max-w-3xl mx-auto p-6 text-center">Caricamento inventario…</main>;
  if (response.error || !response.data) return <main className="max-w-3xl mx-auto p-6 text-center text-destructive">Link non valido o non disponibile.</main>;
  const { notification: rawNotification, items: rawItems } = response.data;
  const notification = rawNotification as unknown as ResponseNotification;
  const items = rawItems as unknown as ResponseItem[];
  const blocked = Boolean(notification.respondedAt) || new Date(notification.tokenExpiresAt) < new Date();

  return <main className="min-h-screen bg-slate-50 p-4 md:p-10">
    <section className="max-w-3xl mx-auto rounded-xl bg-white shadow-sm border p-6 md:p-8">
      <p className="text-sm font-semibold text-emerald-700">SoKeto · verifica inventario</p>
      <h1 className="text-2xl font-bold mt-1">Dichiarazione giacenza — {notification.retailerName}</h1>
      <p className="text-sm text-muted-foreground mt-3">Indica i pezzi realmente presenti. Le confezioni sono mostrate come riferimento; la rettifica, se necessaria, verrà registrata come movimento ADJUSTMENT con causale M13.</p>
      {blocked && <p className="mt-4 rounded-md bg-amber-50 text-amber-800 p-3 text-sm">{notification.respondedAt ? "La dichiarazione è già stata registrata." : "Questo link è scaduto."}</p>}
      <div className="mt-6 space-y-3">
        {items.map((item) => {
          const value = quantities[item.id] ?? item.declaredQuantity ?? item.quantityPieces;
          return <div key={item.id} className="grid gap-2 md:grid-cols-[1fr_150px] border rounded-lg p-4">
            <div><p className="font-medium">{item.productName}</p><p className="text-sm text-muted-foreground">Lotto {item.batchCode} · Scadenza {item.expiryDate} · {Math.floor(item.quantityPieces / item.piecesPerUnit)} confezioni + {item.quantityPieces % item.piecesPerUnit} pz</p></div>
            <label className="text-sm">Pezzi reali<input disabled={blocked || submit.isPending} className="mt-1 w-full rounded border px-2 py-1" type="number" min="0" value={value} onChange={(e) => setQuantities({ ...quantities, [item.id]: Number(e.target.value) })} /></label>
          </div>;
        })}
      </div>
      {submit.error && <p className="mt-4 text-sm text-destructive">{submit.error.message}</p>}
      {!blocked && <button disabled={submit.isPending} onClick={() => submit.mutate({ token, items: items.map((item) => ({ itemId: item.id, declaredQuantity: quantities[item.id] ?? item.quantityPieces })) })} className="mt-6 rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-50">{submit.isPending ? "Registrazione…" : "Conferma dichiarazione"}</button>}
    </section>
  </main>;
}
