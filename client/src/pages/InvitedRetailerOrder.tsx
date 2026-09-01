import { AlertCircle, CheckCircle2, Loader2, Package, ShieldCheck, Truck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

const euro = (value: string | number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value));
type Contact = { legalName: string; contactName: string; email: string; phone: string; businessType: string; address: string; postalCode: string; city: string; province: string; vatNumber: string; notes: string; privacyAccepted: boolean; website: string };
const emptyContact: Contact = { legalName: "", contactName: "", email: "", phone: "", businessType: "", address: "", postalCode: "", city: "", province: "", vatNumber: "", notes: "", privacyAccepted: false, website: "" };

export default function InvitedRetailerOrder() {
  const [, params] = useRoute("/ordine-rivenditore/:token");
  const token = params?.token ?? "";
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [contact, setContact] = useState<Contact>(emptyContact);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const invitationQuery = trpc.prospectSimulator.getInvitationPublicData.useQuery({ token }, { enabled: Boolean(token), retry: false });
  const data = invitationQuery.data;
  const available = data?.available === true;

  useEffect(() => {
    if (available) {
      setContact((current) => ({ ...current, legalName: data.invitation.legalName, contactName: data.invitation.contactName, email: data.invitation.email, phone: data.invitation.phone }));
    }
  }, [available, data]);

  const cartItems = useMemo(
    () => Object.entries(quantities)
      .map(([productId, quantity]) => ({ productId, quantity: Number(quantity) }))
      .filter((item) => Number.isInteger(item.quantity) && item.quantity > 0),
    [quantities],
  );
  const calculation = trpc.prospectSimulator.calculateInvitation.useQuery({ token, items: cartItems }, { enabled: available && cartItems.length > 0, retry: false });
  const submit = trpc.prospectSimulator.submitInvitationOrder.useMutation({ onSuccess: (result) => { setSubmitted(result.id); setQuantities({}); } });
  const update = (key: keyof Contact, value: string | boolean) => setContact((previous) => ({ ...previous, [key]: value }));

  if (invitationQuery.isLoading) return <main className="grid min-h-screen place-items-center bg-[#FAF7F0]"><Loader2 className="h-7 w-7 animate-spin text-[#2D5A27]" /></main>;
  if (!available) return <main className="grid min-h-screen place-items-center bg-[#FAF7F0] p-6"><Card className="w-full max-w-xl border-[#2D5A27]/15"><CardHeader><CardTitle className="flex gap-2 text-[#2D5A27]"><AlertCircle className="text-[#F5A623]" />Questo link non è più valido</CardTitle><CardDescription>Contattaci per ricevere un nuovo link personale. Il listino commerciale non è disponibile da questa pagina.</CardDescription></CardHeader><CardContent><a className="font-semibold text-[#2D5A27] underline" href="mailto:info@soketo.it">Contatta SoKeto</a></CardContent></Card></main>;

  const result = calculation.data;
  const complete = cartItems.length > 0 && contact.legalName && contact.contactName && contact.email && contact.phone && contact.businessType && contact.address && contact.postalCode && contact.city && contact.province && contact.vatNumber && contact.privacyAccepted;

  return <main className="min-h-screen bg-[#FAF7F0] text-[#254521]">
    <header className="bg-[#2D5A27] px-5 py-7 text-white"><div className="mx-auto max-w-7xl"><p className="text-xs font-semibold uppercase tracking-[.16em] text-[#A9D57C]">Invito personale</p><h1 className="mt-2 font-[Poppins] text-3xl font-bold">Completa il tuo ordine SoKeto</h1><p className="mt-2 text-sm text-[#EAF3E6]">Prezzi rivenditore IVA esclusa.</p></div></header>
    <div className="mx-auto grid max-w-7xl gap-7 px-4 py-6 pb-24 sm:px-5 sm:py-8 lg:grid-cols-[minmax(0,1fr)_390px] lg:pb-8">
      <section>
        <h2 className="font-[Poppins] text-2xl font-bold text-[#2D5A27]">Il tuo assortimento</h2>
        <p className="mt-1 text-sm text-[#52634d]">Il listino è il prezzo consigliato di vendita al pubblico, IVA esclusa. Inserisci quantità intere maggiori di zero.</p>
        <div className="mt-5 overflow-hidden rounded-xl border border-[#2D5A27]/10 bg-white">
          {data.products.map((product) => <div className="grid gap-3 border-b border-[#2D5A27]/10 px-4 py-4 last:border-0 md:grid-cols-[minmax(0,1fr)_120px_112px] md:items-center" key={product.id}>
            <div className="min-w-0"><p className="truncate font-medium" title={product.name}>{product.name}</p><p className="truncate text-xs text-[#6B7C66]" title={product.sku}>{product.sku} · IVA {Number(product.vatRate).toFixed(0)}% · {product.piecesPerUnit} {product.unitLabel}</p></div>
            <div className="flex items-center justify-between gap-3 md:contents">
              <p className="w-[132px] whitespace-nowrap font-semibold text-[#2D5A27]">{euro(product.unitListNet)} <span className="text-xs font-normal text-[#6B7C66]">IVA escl.</span></p>
              <Input aria-label={`Quantità ${product.name}`} className="h-12 w-[124px] border-2 border-[#2D5A27]/45 bg-[#F3F7ED] text-center text-base font-bold text-[#254521] shadow-sm focus-visible:ring-[#7AB648] md:h-11 md:w-[112px] md:text-sm" type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={quantities[product.id] ?? ""} onChange={(event) => setQuantities((previous) => ({ ...previous, [product.id]: event.target.value }))} />
            </div>
          </div>)}
        </div>

        {result && <section className="mt-7">
          <div className="mb-4"><h2 className="font-[Poppins] text-xl font-bold text-[#2D5A27]">Prezzi del tuo assortimento</h2><p className="mt-1 text-sm text-[#52634d]">Listino e fasce sono prezzi unitari per rivenditori, <strong>IVA esclusa</strong>. Le soglie delle fasce si applicano al netto pagato dal rivenditore con la relativa fascia.</p></div>
          <div className="space-y-3 md:hidden">
            {result.items.map((item) => <article key={item.id} className="rounded-xl border border-[#2D5A27]/10 bg-white p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold text-[#254521]" title={item.name}>{item.name}</p><p className="mt-0.5 truncate text-xs text-[#6B7C66]" title={item.sku}>{item.sku} · IVA {Number(item.vatRate).toFixed(0)}%</p></div><span className="shrink-0 rounded-full bg-[#F3F7ED] px-2.5 py-1 text-xs font-bold text-[#2D5A27]">{item.quantity} pz</span></div><dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[#2D5A27]/10 pt-3 text-sm"><div><dt className="text-xs text-[#6B7C66]">Listino netto</dt><dd className="mt-0.5 font-bold text-[#254521]">{euro(item.unitListNet)}</dd></div>{item.tierPrices.map((price) => <div key={price.tierCode}><dt className="text-xs text-[#6B7C66]">{result.tiers.find((tier) => tier.code === price.tierCode)?.name}</dt><dd className="mt-0.5 font-bold text-[#254521]">{euro(price.unitNet)}</dd></div>)}</dl></article>)}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-[#2D5A27]/10 bg-white shadow-sm md:block lg:overflow-visible">
            <table className="w-full min-w-[760px] table-fixed text-sm lg:min-w-0 lg:text-xs xl:text-sm"><colgroup><col className="w-[27%]" /><col className="w-[7%]" /><col className="w-[13%]" /><col className="w-[13.25%]" /><col className="w-[13.25%]" /><col className="w-[13.25%]" /><col className="w-[13.25%]" /></colgroup><thead className="bg-[#F3F7ED] text-left text-[10px] uppercase tracking-wide text-[#426b2f]"><tr><th className="px-3 py-3 lg:px-2">Prodotto</th><th className="px-1 py-3 text-center">Q.tà</th><th className="px-2 py-3 text-center lg:px-1"><span className="block">Listino netto</span><span className="normal-case tracking-normal">IVA escl.</span></th>{result.tiers.map((tier) => <th key={tier.code} className="px-2 py-3 text-center text-[#426b2f] lg:px-1"><span className="block truncate">{tier.name}</span><span className="block normal-case tracking-normal">-{Number(tier.discount_percent).toFixed(2)}%</span></th>)}</tr></thead><tbody>{result.items.map((item) => <tr key={item.id} className="border-t border-[#2D5A27]/10"><td className="min-w-0 px-3 py-3 font-medium text-[#254521] lg:px-2"><span className="block truncate" title={item.name}>{item.name}</span><span className="block truncate text-xs font-normal text-[#6B7C66]" title={item.sku}>{item.sku} · IVA {Number(item.vatRate).toFixed(0)}%</span></td><td className="px-1 py-3 text-center font-medium">{item.quantity}</td><td className="whitespace-nowrap px-2 py-3 text-center font-semibold lg:px-1">{euro(item.unitListNet)}</td>{item.tierPrices.map((price) => <td key={price.tierCode} className="whitespace-nowrap px-2 py-3 text-center font-semibold text-[#254521] lg:px-1">{euro(price.unitNet)}</td>)}</tr>)}</tbody></table>
          </div>
          <p className="mt-3 rounded-lg border border-[#2D5A27]/15 bg-[#F3F7ED] px-3 py-2.5 text-xs leading-5 text-[#426b2f]"><strong>Prezzi IVA esclusa.</strong> Il listino indica il prezzo consigliato di vendita al pubblico al netto dell’IVA; le quattro colonne mostrano il prezzo unitario riservato a ciascuna fascia. Le soglie si verificano sul netto merce effettivamente pagato dal rivenditore.</p>
        </section>}
      </section>

      <aside className="space-y-5 lg:sticky lg:top-5 lg:self-start">
        <Card className="overflow-hidden border-[#2D5A27]/15"><CardHeader className="bg-[#2D5A27] text-white"><CardTitle className="text-white">Riepilogo ordine</CardTitle><CardDescription className="text-[#EAF3E6]">Dati calcolati sul server.</CardDescription></CardHeader><CardContent className="space-y-3 bg-[#FAF7F0] p-5">{calculation.isFetching ? <Loader2 className="h-5 w-5 animate-spin text-[#2D5A27]" /> : result ? <><p className="text-sm text-[#426b2f]">Totale listino netto <strong className="float-right text-[#254521]">{euro(result.listSubtotalNet)}</strong></p><div className="rounded-lg bg-[#F3F7ED] p-3"><p className="text-xs font-semibold uppercase text-[#426b2f]">Fascia raggiunta</p><p className="text-xl font-bold text-[#2D5A27]">{result.reachedTier.name}</p><p className="text-sm text-[#426b2f]">Netto merce pagato: <strong className="text-[#254521]">{euro(result.currentTierMerchandiseNet)}</strong></p><p className="mt-1 text-xs text-[#426b2f]">Soglia applicata al netto pagato dal rivenditore, IVA esclusa.</p>{result.nextTier && <p className="mt-2 text-sm text-[#426b2f]">Mancano {euro(result.nextTier.additionalMerchandiseNet)} di netto scontato per {result.nextTier.name}.</p>}</div><p className="flex gap-2 text-sm text-[#426b2f]"><Truck className="h-4 w-4 text-[#5D973B]" />{result.freeShippingApplied ? "Spedizione gratuita" : `Spedizione ${euro(result.shippingNet)} IVA esclusa`}</p><p className="flex gap-2 text-sm text-[#426b2f]"><Package className="h-4 w-4 text-[#5D973B]" />{result.displayStandUnlocked ? "Espositore in omaggio incluso" : `Espositore sopra ${euro(result.displayStandThreshold)} di netto merce scontato`}</p></> : <p className="text-sm text-[#52634d]">Aggiungi prodotti per vedere il riepilogo.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-[#2D5A27]">Dati per la consegna</CardTitle><CardDescription>I dati dell’invito sono già compilati; completa quelli mancanti.</CardDescription></CardHeader><CardContent>{submitted ? <div className="rounded-lg bg-[#2D5A27] p-4 text-sm text-[#FAF7F0]"><CheckCircle2 className="mb-2 text-[#A9D57C]" /><strong className="text-white">Ordine ricevuto.</strong><p className="mt-1 text-[#EAF3E6]">Ti contatteremo per l’approvazione e l’evasione.</p></div> : <form id="prospect-order-form" className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (complete) submit.mutate({ token, ...contact, privacyAccepted: true, items: cartItems }); }}><div className="hidden"><Input tabIndex={-1} value={contact.website} onChange={(event) => update("website", event.target.value)} /></div><Input required placeholder="Ragione sociale" value={contact.legalName} onChange={(event) => update("legalName", event.target.value)} /><Input required placeholder="Referente" value={contact.contactName} onChange={(event) => update("contactName", event.target.value)} /><Input required type="email" placeholder="Email" value={contact.email} onChange={(event) => update("email", event.target.value)} /><Input required placeholder="Telefono" value={contact.phone} onChange={(event) => update("phone", event.target.value)} /><Input required placeholder="Tipo attività" value={contact.businessType} onChange={(event) => update("businessType", event.target.value)} /><Input required placeholder="Via e numero civico" value={contact.address} onChange={(event) => update("address", event.target.value)} /><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input required placeholder="CAP" value={contact.postalCode} onChange={(event) => update("postalCode", event.target.value)} /><Input required placeholder="Città" value={contact.city} onChange={(event) => update("city", event.target.value)} /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input required placeholder="Provincia (es. MI)" maxLength={2} value={contact.province} onChange={(event) => update("province", event.target.value.toUpperCase())} /><Input required placeholder="P. IVA" value={contact.vatNumber} onChange={(event) => update("vatNumber", event.target.value)} /></div><textarea className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base sm:min-h-20 sm:text-sm" placeholder="Note per l’ordine (opzionali)" value={contact.notes} onChange={(event) => update("notes", event.target.value)} /><label className="flex gap-2 text-xs leading-5 text-[#52634d]"><Checkbox checked={contact.privacyAccepted} onCheckedChange={(value) => update("privacyAccepted", value === true)} /><span>Ho letto l’<a className="font-semibold text-[#2D5A27] underline" href={data.config.privacyPolicyUrl} target="_blank" rel="noreferrer">informativa privacy</a> e acconsento al trattamento dei dati per la gestione dell’ordine.</span></label>{submit.error && <p className="text-sm text-destructive">{submit.error.message}</p>}<Button className="hidden w-full bg-[#2D5A27] text-[#FAF7F0] hover:bg-[#254521] hover:text-white md:inline-flex" disabled={!complete || submit.isPending}>{submit.isPending ? <Loader2 className="animate-spin" /> : "Invia ordine"}</Button></form>}</CardContent></Card>
      </aside>
    </div>
    {!submitted && <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[#2D5A27]/15 bg-[#FAF7F0]/95 p-3 shadow-[0_-8px_22px_rgba(45,90,39,0.12)] backdrop-blur md:hidden"><Button form="prospect-order-form" type="submit" className="h-12 w-full bg-[#2D5A27] text-base text-[#FAF7F0] hover:bg-[#254521] hover:text-white" disabled={!complete || submit.isPending}>{submit.isPending ? <Loader2 className="animate-spin" /> : "Invia ordine"}</Button></div>}
    <footer className="border-t border-[#2D5A27]/10 px-5 py-6 text-center text-xs text-[#6B7C66]"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />Questo link è personale e resta valido fino all’invio dell’ordine o alla sua scadenza.</footer>
  </main>;
}
