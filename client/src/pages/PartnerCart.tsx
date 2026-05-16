/**
 * M6.2.B Parte B — PartnerCart
 * Carrello retailer: tabella items, modifica quantità, rimozione, totali live, pulsante checkout.
 * Usa retailerSelfService.cartPreview per pricing server-side.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCart } from "@/contexts/CartContext";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  Loader2,
  Minus,
  Package,
  Plus,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { useLocation } from "wouter";

export default function PartnerCart() {
  const [, setLocation] = useLocation();
  const { items, itemCount, updateQuantity, removeItem, clearCart } = useCart();

  // Preview totali dal server
  const previewInput = useMemo(
    () => items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    [items],
  );

  const previewMutation = trpc.retailerSelfService.cartPreview.useMutation();

  // Trigger preview when items change
  useEffect(() => {
    if (previewInput.length > 0) {
      previewMutation.mutate({ items: previewInput });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(previewInput)]);

  const preview = previewMutation.data;

  // Calcolo totali locali (fallback se preview non disponibile)
  const localSubtotal = useMemo(
    () =>
      items.reduce(
        (sum, i) => sum + parseFloat(i.unitPriceFinal) * i.quantity,
        0,
      ),
    [items],
  );

  if (items.length === 0) {
    return (
      <PartnerLayout>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ShoppingCart className="h-16 w-16 text-muted-foreground/30 mb-4" />
          <h2 className="text-xl font-semibold mb-2">Il carrello è vuoto</h2>
          <p className="text-muted-foreground mb-6">
            Aggiungi prodotti dal catalogo per iniziare un ordine.
          </p>
          <Button
            onClick={() => setLocation("/partner-portal/catalog")}
            className="bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
          >
            <Package className="h-4 w-4 mr-2" />
            Vai al catalogo
          </Button>
        </div>
      </PartnerLayout>
    );
  }

  return (
    <PartnerLayout>
      <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Carrello</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {itemCount} {itemCount === 1 ? "articolo" : "articoli"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation("/partner-portal/catalog")}
            className="gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            Catalogo
          </Button>
        </div>

        {/* Tabella items */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50%]">Prodotto</TableHead>
                  <TableHead className="text-center">Quantità</TableHead>
                  <TableHead className="text-right">Prezzo unit.</TableHead>
                  <TableHead className="text-right">Totale</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const serverItem = preview?.items.find(
                    (si) => si.productId === item.productId,
                  );
                  const unitPrice = serverItem
                    ? parseFloat(serverItem.unitPriceFinal).toFixed(2)
                    : item.unitPriceFinal;
                  const lineTotal = serverItem
                    ? parseFloat(serverItem.lineTotalNet).toFixed(2)
                    : (parseFloat(item.unitPriceFinal) * item.quantity).toFixed(2);

                  return (
                    <TableRow key={item.productId}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={item.name}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <Package className="h-4 w-4 text-muted-foreground/40" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{item.sku}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-center gap-1">
                          <button
                            className="p-1 rounded hover:bg-accent transition-colors"
                            onClick={() => updateQuantity(item.productId, item.quantity - 1)}
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                          <input
                            type="number"
                            min={1}
                            max={item.stockAvailable}
                            value={item.quantity}
                            onChange={(e) =>
                              updateQuantity(item.productId, parseInt(e.target.value) || 1)
                            }
                            className="w-12 text-center text-sm bg-transparent border rounded py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <button
                            className="p-1 rounded hover:bg-accent transition-colors"
                            onClick={() => updateQuantity(item.productId, item.quantity + 1)}
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        &euro;{unitPrice}
                      </TableCell>
                      <TableCell className="text-right font-medium text-sm">
                        &euro;{lineTotal}
                      </TableCell>
                      <TableCell>
                        <button
                          className="p-1.5 rounded hover:bg-destructive/10 text-destructive transition-colors"
                          onClick={() => removeItem(item.productId)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Totali + Checkout */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Svuota carrello */}
          <div className="md:col-span-1">
            <Button
              variant="outline"
              className="w-full text-destructive border-destructive/30 hover:bg-destructive/5"
              onClick={clearCart}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Svuota carrello
            </Button>
          </div>

          {/* Riepilogo totali */}
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Riepilogo ordine</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {previewMutation.isPending ? (
                <div className="flex items-center gap-2 py-2">
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
                  {parseFloat(preview.discountPercent) > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-[#7AB648]">
                        Sconto {preview.packageName}: {preview.discountPercent}%
                      </span>
                      <span className="text-[#7AB648]">applicato</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">IVA</span>
                    <span>&euro;{parseFloat(preview.vatAmount).toFixed(2)}</span>
                  </div>
                  <div className="border-t pt-2 flex justify-between text-lg font-bold">
                    <span>Totale</span>
                    <span className="text-[#2D5A27] dark:text-[#7AB648]">
                      &euro;{parseFloat(preview.totalGross).toFixed(2)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotale stimato</span>
                  <span>&euro;{localSubtotal.toFixed(2)}</span>
                </div>
              )}

              <Button
                className="w-full mt-4 bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white h-12 text-base"
                onClick={() => setLocation("/partner-portal/checkout")}
                disabled={previewMutation.isPending}
              >
                Procedi al checkout
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </PartnerLayout>
  );
}
