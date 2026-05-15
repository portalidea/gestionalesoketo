/**
 * M6.2.A — OrderNew page (Admin)
 * Form creazione ordine con:
 * - Select retailer (con pacchetto pricing mostrato)
 * - Ricerca prodotti + aggiungi al carrello
 * - Carrello live con calcolo pricing (chiama trpc.orders.preview)
 * - Note interne/esterne
 * - Submit → trpc.orders.create → redirect a /orders/:id
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Minus,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type CartItem = {
  productId: string;
  quantity: number;
};

const NO_RETAILER = "__none__";

export default function OrderNew() {
  const [, setLocation] = useLocation();
  const [retailerId, setRetailerId] = useState(NO_RETAILER);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState("");
  const [notesInternal, setNotesInternal] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Dati
  const retailers = trpc.retailers.list.useQuery();
  const productsQuery = trpc.products.list.useQuery();
  const utils = trpc.useUtils();

  // Preview pricing
  const previewInput = useMemo(() => ({
    retailerId: retailerId !== NO_RETAILER ? retailerId : "",
    items: cart.map((c) => ({ productId: c.productId, quantity: c.quantity })),
  }), [retailerId, cart]);

  const preview = trpc.orders.preview.useMutation();

  // Ricalcola preview quando cambia carrello o retailer
  useEffect(() => {
    if (retailerId === NO_RETAILER || cart.length === 0) return;
    const timer = setTimeout(() => {
      preview.mutate(previewInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [previewInput]);

  // Crea ordine
  const createOrder = trpc.orders.create.useMutation({
    onSuccess: (data) => {
      toast.success(`Ordine ${data.orderNumber} creato con successo`);
      utils.orders.list.invalidate();
      setLocation(`/orders/${data.id}`);
    },
    onError: (err) => {
      toast.error(`Errore creazione ordine: ${err.message}`);
      setIsSubmitting(false);
    },
  });

  // Retailer selezionato con info pacchetto
  const selectedRetailer = retailers.data?.find((r) => r.id === retailerId);

  // Filtro prodotti per ricerca
  const filteredProducts = useMemo(() => {
    if (!productsQuery.data) return [];
    const q = productSearch.toLowerCase().trim();
    if (!q) return productsQuery.data;
    return productsQuery.data.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category && p.category.toLowerCase().includes(q))
    );
  }, [productsQuery.data, productSearch]);

  // Prodotti nel carrello (mappa per lookup rapido)
  const cartProductIds = useMemo(() => new Set(cart.map((c) => c.productId)), [cart]);

  // Aggiungi prodotto al carrello
  const addToCart = useCallback((productId: string) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.productId === productId);
      if (existing) {
        return prev.map((c) =>
          c.productId === productId ? { ...c, quantity: c.quantity + 1 } : c
        );
      }
      return [...prev, { productId, quantity: 1 }];
    });
  }, []);

  // Modifica quantità
  const updateQuantity = useCallback((productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((c) =>
          c.productId === productId
            ? { ...c, quantity: Math.max(1, c.quantity + delta) }
            : c
        )
    );
  }, []);

  // Rimuovi dal carrello
  const removeFromCart = useCallback((productId: string) => {
    setCart((prev) => prev.filter((c) => c.productId !== productId));
  }, []);

  // Submit
  const handleSubmit = () => {
    if (retailerId === NO_RETAILER) {
      toast.error("Seleziona un rivenditore");
      return;
    }
    if (cart.length === 0) {
      toast.error("Aggiungi almeno un prodotto al carrello");
      return;
    }
    setIsSubmitting(true);
    createOrder.mutate({
      retailerId,
      items: cart.map((c) => ({ productId: c.productId, quantity: c.quantity })),
      notes: notes || undefined,
      notesInternal: notesInternal || undefined,
    });
  };

  // Mappa prodotti per nome/sku nel carrello
  const productMap = useMemo(() => {
    if (!productsQuery.data) return new Map<string, { name: string; sku: string; unitPrice: string }>();
    return new Map(productsQuery.data.map((p) => [p.id, { name: p.name, sku: p.sku, unitPrice: p.unitPrice ?? "0" }]));
  }, [productsQuery.data]);

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/orders")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Nuovo Ordine</h1>
            <p className="text-sm text-muted-foreground">
              Crea un ordine B2B per un rivenditore
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Colonna sinistra: retailer + prodotti */}
          <div className="lg:col-span-2 space-y-6">
            {/* Selezione retailer */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Rivenditore</CardTitle>
              </CardHeader>
              <CardContent>
                <Select value={retailerId} onValueChange={setRetailerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleziona rivenditore..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_RETAILER} disabled>
                      Seleziona rivenditore...
                    </SelectItem>
                    {retailers.data?.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                        {r.city ? ` — ${r.city}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedRetailer && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                    {selectedRetailer.pricingPackageId ? (
                      <Badge variant="secondary">Pacchetto assegnato</Badge>
                    ) : (
                      <Badge variant="outline">Nessun pacchetto (prezzo pieno)</Badge>
                    )}
                    {selectedRetailer.ficClientId ? (
                      <Badge variant="secondary">FiC collegato</Badge>
                    ) : (
                      <Badge variant="outline">FiC non collegato</Badge>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Catalogo prodotti */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Catalogo Prodotti</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Cerca per nome, SKU o categoria..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="pl-10"
                  />
                </div>

                {productsQuery.isLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="max-h-[400px] overflow-y-auto border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>Prodotto</TableHead>
                          <TableHead className="text-right">Prezzo</TableHead>
                          <TableHead className="text-right">IVA</TableHead>
                          <TableHead className="w-[80px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredProducts.map((p) => (
                          <TableRow key={p.id}>
                            <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                            <TableCell className="text-sm">{p.name}</TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              € {parseFloat(p.unitPrice ?? "0").toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {p.vatRate}%
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant={cartProductIds.has(p.id) ? "secondary" : "outline"}
                                onClick={() => addToCart(p.id)}
                                className="h-7 px-2"
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                        {filteredProducts.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                              Nessun prodotto trovato
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Note */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Note</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Note ordine (visibili al retailer)</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Note visibili al rivenditore..."
                    rows={2}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Note interne (solo admin)</Label>
                  <Textarea
                    value={notesInternal}
                    onChange={(e) => setNotesInternal(e.target.value)}
                    placeholder="Note interne per il team..."
                    rows={2}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Colonna destra: carrello + riepilogo */}
          <div className="space-y-6">
            <Card className="sticky top-4">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4" />
                  Carrello ({cart.length} {cart.length === 1 ? "prodotto" : "prodotti"})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {cart.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Aggiungi prodotti dal catalogo
                  </p>
                ) : (
                  <div className="space-y-3">
                    {cart.map((item) => {
                      const prod = productMap.get(item.productId);
                      const previewItem = preview.data?.items.find(
                        (pi) => pi.productId === item.productId
                      );
                      return (
                        <div key={item.productId} className="border rounded-lg p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {prod?.name ?? item.productId}
                              </p>
                              <p className="text-xs text-muted-foreground font-mono">
                                {prod?.sku}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => removeFromCart(item.productId)}
                            >
                              <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1">
                              <Button
                                variant="outline"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => updateQuantity(item.productId, -1)}
                              >
                                <Minus className="h-3 w-3" />
                              </Button>
                              <span className="w-10 text-center text-sm font-medium">
                                {item.quantity}
                              </span>
                              <Button
                                variant="outline"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => updateQuantity(item.productId, 1)}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            </div>
                            {previewItem && (
                              <span className="text-sm font-mono">
                                € {previewItem.lineTotalGross}
                              </span>
                            )}
                          </div>
                          {previewItem?.stockWarning && (
                            <div className="flex items-center gap-1 text-xs text-amber-500">
                              <AlertTriangle className="h-3 w-3" />
                              Stock insufficiente ({previewItem.stockAvailableConfezioni} disp.)
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Riepilogo pricing */}
                {preview.data && cart.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2 text-sm">
                      {parseFloat(preview.data.discountPercent) > 0 && (
                        <div className="flex justify-between text-muted-foreground">
                          <span>Sconto pacchetto</span>
                          <span className="text-green-500">-{preview.data.discountPercent}%</span>
                        </div>
                      )}
                      <div className="flex justify-between text-muted-foreground">
                        <span>Subtotale netto</span>
                        <span className="font-mono">€ {preview.data.subtotalNet}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>IVA</span>
                        <span className="font-mono">€ {preview.data.vatAmount}</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between font-semibold text-base">
                        <span>Totale lordo</span>
                        <span className="font-mono">€ {preview.data.totalGross}</span>
                      </div>
                    </div>

                    {/* Warnings */}
                    {preview.data.warnings.length > 0 && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-md p-3 space-y-1">
                        {preview.data.warnings.map((w, i) => (
                          <p key={i} className="text-xs text-amber-500 flex items-start gap-1">
                            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                            {w}
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {preview.isPending && cart.length > 0 && (
                  <div className="flex justify-center py-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}

                {preview.isError && (
                  <p className="text-xs text-destructive text-center">
                    Errore calcolo prezzi: {preview.error.message}
                  </p>
                )}

                <Button
                  className="w-full"
                  disabled={
                    retailerId === NO_RETAILER ||
                    cart.length === 0 ||
                    isSubmitting
                  }
                  onClick={handleSubmit}
                >
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <ShoppingCart className="h-4 w-4 mr-2" />
                  )}
                  Crea Ordine
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
