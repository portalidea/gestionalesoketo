/**
 * M6.2.B Parte B — PartnerCheckout
 * Pagina checkout: recap ordine, note, conferma, proforma auto, redirect a ordine.
 * Success page mostra IBAN per pagamento (advance_transfer).
 * Usa retailerSelfService.checkout + cartPreview.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useCart } from "@/contexts/CartContext";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  FileText,
  Loader2,
  ShoppingCart,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

// IBAN aziendale SoKeto
const COMPANY_IBAN = "IT60X0542811101000000123456";
const COMPANY_BANK = "Banca Popolare di Lodi";
const COMPANY_BIC = "BPLOIT2L";
const COMPANY_NAME = "SoKeto S.r.l.";

export default function PartnerCheckout() {
  const [, setLocation] = useLocation();
  const { items, clearCart } = useCart();
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderResult, setOrderResult] = useState<{
    orderId: string;
    orderNumber: string;
    ficProformaNumber: string | null;
    grandTotal: number;
    paymentTerms: string;
  } | null>(null);

  const previewInput = useMemo(
    () => items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    [items],
  );

  const previewMutation = trpc.retailerSelfService.cartPreview.useMutation();

  // Trigger preview when items change
  useEffect(() => {
    if (previewInput.length > 0 && !orderResult) {
      previewMutation.mutate({ items: previewInput });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(previewInput)]);

  const createMutation = trpc.retailerSelfService.cartCheckout.useMutation({
    onSuccess: (data) => {
      setOrderResult({
        orderId: data.orderId,
        orderNumber: data.orderNumber,
        ficProformaNumber: null,
        grandTotal: parseFloat(previewMutation.data?.totalGross ?? '0'),
        paymentTerms: previewMutation.data?.paymentTerms ?? 'advance_transfer',
      });
      clearCart();
      toast.success("Ordine confermato!");
    },
    onError: (err) => {
      toast.error("Errore nella creazione dell'ordine", {
        description: err.message,
      });
      setIsSubmitting(false);
    },
  });

  const handleConfirm = () => {
    if (items.length === 0) return;
    setIsSubmitting(true);
    createMutation.mutate({
      items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      notes: notes || undefined,
    });
  };

  const preview = previewMutation.data;

  // Redirect se carrello vuoto e nessun risultato
  if (items.length === 0 && !orderResult) {
    return (
      <PartnerLayout>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ShoppingCart className="h-16 w-16 text-muted-foreground/30 mb-4" />
          <h2 className="text-xl font-semibold mb-2">Carrello vuoto</h2>
          <p className="text-muted-foreground mb-6">
            Aggiungi prodotti dal catalogo prima di procedere al checkout.
          </p>
          <Button
            onClick={() => setLocation("/partner-portal/catalog")}
            className="bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
          >
            Vai al catalogo
          </Button>
        </div>
      </PartnerLayout>
    );
  }

  // Successo — ordine creato
  if (orderResult) {
    const isAdvanceTransfer = orderResult.paymentTerms === "advance_transfer";

    return (
      <PartnerLayout>
        <div className="flex flex-col items-center justify-center py-12 text-center max-w-lg mx-auto">
          <div className="h-16 w-16 rounded-full bg-[#7AB648]/10 flex items-center justify-center mb-6">
            <CheckCircle2 className="h-10 w-10 text-[#7AB648]" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Ordine confermato!</h2>
          <p className="text-muted-foreground mb-2">
            Il tuo ordine <strong>{orderResult.orderNumber}</strong> è stato creato con successo.
          </p>
          {orderResult.ficProformaNumber && (
            <p className="text-sm text-muted-foreground mb-4">
              <FileText className="inline h-4 w-4 mr-1" />
              Proforma n. <strong>{orderResult.ficProformaNumber}</strong> generata.
            </p>
          )}

          {/* IBAN box per bonifico anticipato */}
          {isAdvanceTransfer && (
            <Card className="w-full text-left mt-4 mb-6 border-[#2D5A27]/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-[#2D5A27] dark:text-[#7AB648]">
                  Dati per il bonifico
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-[100px_1fr] gap-y-2">
                  <span className="text-muted-foreground">Intestatario:</span>
                  <span className="font-medium">{COMPANY_NAME}</span>
                  <span className="text-muted-foreground">IBAN:</span>
                  <span className="font-mono font-medium flex items-center gap-2">
                    {COMPANY_IBAN}
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(COMPANY_IBAN);
                        toast.success("IBAN copiato");
                      }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </span>
                  <span className="text-muted-foreground">BIC/SWIFT:</span>
                  <span className="font-mono">{COMPANY_BIC}</span>
                  <span className="text-muted-foreground">Banca:</span>
                  <span>{COMPANY_BANK}</span>
                  <span className="text-muted-foreground">Importo:</span>
                  <span className="font-bold text-[#2D5A27] dark:text-[#7AB648]">
                    &euro;{orderResult.grandTotal.toFixed(2)}
                  </span>
                  <span className="text-muted-foreground">Causale:</span>
                  <span className="font-medium">
                    Ordine {orderResult.orderNumber}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground pt-2 border-t">
                  L'ordine verrà processato dopo la ricezione del pagamento.
                  Riceverai una email di conferma con questi dati.
                </p>
              </CardContent>
            </Card>
          )}

          {!isAdvanceTransfer && (
            <p className="text-sm text-muted-foreground mb-6">
              Pagamento alla consegna. L'ordine verrà preparato e spedito.
            </p>
          )}

          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => setLocation("/partner-portal/catalog")}
            >
              Continua acquisti
            </Button>
            <Button
              className="bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
              onClick={() => setLocation(`/partner-portal/orders/${orderResult.orderId}`)}
            >
              Vedi ordine
            </Button>
          </div>
        </div>
      </PartnerLayout>
    );
  }

  return (
    <PartnerLayout>
      <div className="space-y-6 max-w-3xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation("/partner-portal/cart")}
            className="gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            Carrello
          </Button>
          <h1 className="text-2xl font-bold text-foreground">Checkout</h1>
        </div>

        {/* Recap items */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Riepilogo ordine</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.map((item) => (
              <div
                key={item.productId}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.quantity} x &euro;{item.unitPriceFinal}
                  </p>
                </div>
                <p className="text-sm font-medium ml-4">
                  &euro;{(parseFloat(item.unitPriceFinal) * item.quantity).toFixed(2)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Note */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Note ordine (opzionale)</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              placeholder="Istruzioni speciali, orari di consegna preferiti, ecc."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </CardContent>
        </Card>

        {/* Totali */}
        <Card>
          <CardContent className="p-6 space-y-3">
            {previewMutation.isPending ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Calcolo totali...</span>
              </div>
            ) : preview ? (
              <>
                {preview.warnings && preview.warnings.length > 0 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mb-3">
                    {preview.warnings.map((w: { productId: string; message: string }, i: number) => (
                      <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400">
                        {w.message}
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotale netto</span>
                  <span>&euro;{parseFloat(preview.subtotalNet).toFixed(2)}</span>
                </div>
                {parseFloat(preview.discountPercent ?? '0') > 0 && (
                  <div className="flex justify-between text-sm text-[#7AB648]">
                    <span>Sconto {preview.packageName}: {preview.discountPercent}%</span>
                    <span>applicato</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">IVA</span>
                  <span>&euro;{parseFloat(preview.vatAmount).toFixed(2)}</span>
                </div>
                <div className="border-t pt-3 flex justify-between text-xl font-bold">
                  <span>Totale</span>
                  <span className="text-[#2D5A27] dark:text-[#7AB648]">
                    &euro;{parseFloat(preview.totalGross).toFixed(2)}
                  </span>
                </div>
              </>
            ) : null}

            <div className="pt-4 space-y-3">
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">
                  <strong>Pagamento:</strong> Bonifico bancario anticipato. I dettagli bancari
                  saranno mostrati dopo la conferma e inclusi nella email di conferma.
                </p>
              </div>
              <Button
                className="w-full h-12 text-base bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
                onClick={handleConfirm}
                disabled={isSubmitting || previewMutation.isPending}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creazione ordine...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Conferma ordine
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </PartnerLayout>
  );
}
