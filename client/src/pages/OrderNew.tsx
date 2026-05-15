/**
 * M6.2.A — OrderNew page (Admin) — UX fix v2
 *
 * Layout responsive:
 * - Carrello VUOTO: nascosto, catalogo full-width. FAB bottom-right "Carrello (0)".
 * - Carrello CON items: sidebar destra ~1/3, sticky scroll. Catalogo si restringe.
 *
 * Catalogo: SKU, Prodotto, Prezzo, Stock disponibile, IVA badge, Azione "+".
 * Ricerca client-side con count risultati. Query prodotti una sola volta.
 *
 * Fix v2:
 * - CartContent estratto come componente separato (no unmount/remount su re-render)
 * - Prezzo riga: lineTotalNet (netto IVA esclusa) per coerenza B2B
 * - Sconto pacchetto: mostra nome pacchetto (es. "Premium 46.48%")
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
  Package,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type CartItem = {
  productId: string;
  quantity: number;
};

type PreviewData = {
  discountPercent: string;
  packageName: string | null;
  items: Array<{
    productId: string;
    lineTotalNet: string;
    lineTotalGross: string;
    stockAvailableConfezioni: number;
    stockWarning: boolean;
  }>;
  subtotalNet: string;
  vatAmount: string;
  totalGross: string;
  warnings: string[];
};

const NO_RETAILER = "__none__";

// ====================== COMPONENTE CARRELLO (estratto per evitare unmount/remount) ======================
function CartContent({
  cart,
  productMap,
  previewData,
  previewIsPending,
  previewError,
  retailerId,
  isSubmitting,
  onSetQuantity,
  onRemove,
  onSubmit,
}: {
  cart: CartItem[];
  productMap: Map<string, any>;
  previewData: PreviewData | undefined;
  previewIsPending: boolean;
  previewError: string | null;
  retailerId: string;
  isSubmitting: boolean;
  onSetQuantity: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
  onSubmit: () => void;
}) {
  // Ref per preservare scroll position durante re-render
  const scrollRef = useRef<HTMLDivElement>(null);

  const totalCartQty = cart.reduce((sum, c) => sum + c.quantity, 0);

  return (
    <div className="space-y-4">
      {cart.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          Aggiungi prodotti dal catalogo
        </p>
      ) : (
        <div ref={scrollRef} className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {cart.map((item) => {
            const prod = productMap.get(item.productId);
            const previewItem = previewData?.items.find(
              (pi) => pi.productId === item.productId,
            );
            return (
              <div key={item.productId} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {prod?.name ?? item.productId}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono">{prod?.sku}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => onRemove(item.productId)}
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
                      onClick={() => onSetQuantity(item.productId, item.quantity - 1)}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      max={9999}
                      value={item.quantity}
                      onChange={(e) =>
                        onSetQuantity(item.productId, parseInt(e.target.value) || 1)
                      }
                      className="w-16 h-7 text-center text-sm font-medium px-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => onSetQuantity(item.productId, item.quantity + 1)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                  {previewItem && (
                    <span className="text-sm font-mono font-medium">
                      € {previewItem.lineTotalNet}
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
      {previewData && cart.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2 text-sm">
            {parseFloat(previewData.discountPercent) > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>
                  Sconto{" "}
                  {previewData.packageName
                    ? `${previewData.packageName}`
                    : "pacchetto"}
                </span>
                <span className="text-green-500">-{previewData.discountPercent}%</span>
              </div>
            )}
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotale netto</span>
              <span className="font-mono">€ {previewData.subtotalNet}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>IVA</span>
              <span className="font-mono">€ {previewData.vatAmount}</span>
            </div>
            <Separator />
            <div className="flex justify-between font-semibold text-base">
              <span>Totale lordo</span>
              <span className="font-mono">€ {previewData.totalGross}</span>
            </div>
          </div>

          {previewData.warnings.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-md p-3 space-y-1">
              {previewData.warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-500 flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  {w}
                </p>
              ))}
            </div>
          )}
        </>
      )}

      {previewIsPending && cart.length > 0 && (
        <div className="flex justify-center py-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {previewError && (
        <p className="text-xs text-destructive text-center">
          Errore calcolo prezzi: {previewError}
        </p>
      )}

      <Button
        className="w-full"
        disabled={retailerId === NO_RETAILER || cart.length === 0 || isSubmitting}
        onClick={onSubmit}
      >
        {isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <ShoppingCart className="h-4 w-4 mr-2" />
        )}
        Crea Ordine ({totalCartQty} pz)
      </Button>
    </div>
  );
}

// ====================== COMPONENTE PRINCIPALE ======================
export default function OrderNew() {
  const [, setLocation] = useLocation();
  const [retailerId, setRetailerId] = useState(NO_RETAILER);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState("");
  const [notesInternal, setNotesInternal] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);

  // Dati
  const retailers = trpc.retailers.list.useQuery();
  const productsQuery = trpc.products.list.useQuery();
  const utils = trpc.useUtils();

  // Preview pricing (debounced)
  const previewInput = useMemo(
    () => ({
      retailerId: retailerId !== NO_RETAILER ? retailerId : "",
      items: cart.map((c) => ({ productId: c.productId, quantity: c.quantity })),
    }),
    [retailerId, cart],
  );

  const preview = trpc.orders.preview.useMutation();

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
      if (data.warnings && data.warnings.length > 0) {
        toast.success(`Ordine ${data.orderNumber} creato con successo`, {
          description: `Lotti FEFO auto-assegnati. ${data.warnings.length} avviso/i stock.`,
          duration: 6000,
        });
        // Mostra warnings individuali
        for (const w of data.warnings) {
          toast.warning(w, { duration: 8000 });
        }
      } else {
        toast.success(`Ordine ${data.orderNumber} creato con successo — lotti FEFO assegnati`);
      }
      utils.orders.list.invalidate();
      setLocation(`/orders/${data.id}`);
    },
    onError: (err) => {
      toast.error(`Errore creazione ordine: ${err.message}`);
      setIsSubmitting(false);
    },
  });

  // Retailer selezionato
  const selectedRetailer = retailers.data?.find((r) => r.id === retailerId);

  // Filtro prodotti client-side
  const filteredProducts = useMemo(() => {
    if (!productsQuery.data) return [];
    const q = productSearch.toLowerCase().trim();
    if (!q) return productsQuery.data;
    return productsQuery.data.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category && p.category.toLowerCase().includes(q)),
    );
  }, [productsQuery.data, productSearch]);

  // Mappa prodotti per lookup rapido nel carrello
  const productMap = useMemo(() => {
    if (!productsQuery.data) return new Map<string, any>();
    return new Map(productsQuery.data.map((p) => [p.id, p]));
  }, [productsQuery.data]);

  // Set prodotti nel carrello
  const cartProductIds = useMemo(() => new Set(cart.map((c) => c.productId)), [cart]);
  const hasCartItems = cart.length > 0;

  // --- Cart actions (useCallback per stabilità reference) ---
  const addToCart = useCallback((productId: string) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.productId === productId);
      if (existing) {
        return prev.map((c) =>
          c.productId === productId ? { ...c, quantity: c.quantity + 1 } : c,
        );
      }
      return [...prev, { productId, quantity: 1 }];
    });
  }, []);

  const setQuantity = useCallback((productId: string, qty: number) => {
    const clamped = Math.max(1, Math.min(9999, qty));
    setCart((prev) =>
      prev.map((c) => (c.productId === productId ? { ...c, quantity: clamped } : c)),
    );
  }, []);

  const removeFromCart = useCallback((productId: string) => {
    setCart((prev) => prev.filter((c) => c.productId !== productId));
  }, []);

  // Submit
  const handleSubmit = useCallback(() => {
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
  }, [retailerId, cart, notes, notesInternal, createOrder]);

  // Conteggio totale pezzi nel carrello
  const totalCartQty = cart.reduce((sum, c) => sum + c.quantity, 0);

  // Props condivise per CartContent (desktop + mobile)
  const cartContentProps = {
    cart,
    productMap,
    previewData: preview.data as PreviewData | undefined,
    previewIsPending: preview.isPending,
    previewError: preview.isError ? preview.error.message : null,
    retailerId,
    isSubmitting,
    onSetQuantity: setQuantity,
    onRemove: removeFromCart,
    onSubmit: handleSubmit,
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
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

        {/* Layout principale: flex con carrello condizionale */}
        <div className="flex gap-6 items-start">
          {/* Colonna sinistra: retailer + catalogo + note — si espande quando carrello vuoto */}
          <div className={`space-y-6 min-w-0 ${hasCartItems ? "flex-1" : "w-full"}`}>
            {/* Selezione retailer */}
            <Card>
              <CardHeader className="pb-3">
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
                  <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
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
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Catalogo Prodotti</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Ricerca + count */}
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Cerca per nome, SKU o categoria..."
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="pl-10"
                    />
                    {productSearch && (
                      <button
                        onClick={() => setProductSearch("")}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {filteredProducts.length} prodott{filteredProducts.length === 1 ? "o" : "i"}
                  </span>
                </div>

                {productsQuery.isLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="max-h-[500px] overflow-y-auto border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[100px]">SKU</TableHead>
                          <TableHead>Prodotto</TableHead>
                          <TableHead className="text-right w-[100px]">Prezzo</TableHead>
                          <TableHead className="text-right w-[120px]">Stock</TableHead>
                          <TableHead className="text-center w-[70px]">IVA</TableHead>
                          <TableHead className="w-[50px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredProducts.map((p) => {
                          const inCart = cartProductIds.has(p.id);
                          const cartQty = cart.find((c) => c.productId === p.id)?.quantity;
                          const ppu = (p as any).piecesPerUnit ?? 1;
                          const stockLabel =
                            ppu > 1
                              ? `${p.centralStock ?? 0} conf (${(p.centralStock ?? 0) * ppu} pz)`
                              : `${p.centralStock ?? 0}`;
                          return (
                            <TableRow
                              key={p.id}
                              className={inCart ? "bg-primary/5" : ""}
                            >
                              <TableCell className="font-mono text-xs">
                                {p.sku}
                              </TableCell>
                              <TableCell>
                                <span className="text-sm">{p.name}</span>
                                {p.category && (
                                  <span className="text-xs text-muted-foreground ml-2">
                                    {p.category}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                € {parseFloat(p.unitPrice ?? "0").toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right">
                                <span
                                  className={`text-sm ${
                                    (p.centralStock ?? 0) === 0
                                      ? "text-destructive"
                                      : (p.centralStock ?? 0) < (p.minStockThreshold ?? 10)
                                        ? "text-amber-500"
                                        : "text-muted-foreground"
                                  }`}
                                >
                                  {stockLabel}
                                </span>
                              </TableCell>
                              <TableCell className="text-center">
                                <Badge variant="outline" className="text-xs font-normal px-1.5 py-0">
                                  {parseFloat(p.vatRate).toFixed(0)}%
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <Button
                                  size="sm"
                                  variant={inCart ? "secondary" : "outline"}
                                  onClick={() => addToCart(p.id)}
                                  className="h-7 w-7 p-0"
                                  title={inCart ? `Nel carrello (${cartQty})` : "Aggiungi al carrello"}
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        {filteredProducts.length === 0 && (
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              className="text-center text-muted-foreground py-8"
                            >
                              <Package className="h-8 w-8 mx-auto mb-2 opacity-30" />
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
              <CardHeader className="pb-3">
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

          {/* Colonna destra: carrello — visibile solo quando ha items (desktop) */}
          {hasCartItems && (
            <div className="hidden lg:block w-[380px] shrink-0">
              <Card className="sticky top-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShoppingCart className="h-4 w-4" />
                    Carrello ({cart.length}{" "}
                    {cart.length === 1 ? "prodotto" : "prodotti"}, {totalCartQty} pz)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CartContent {...cartContentProps} />
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* FAB carrello — visibile su desktop quando carrello vuoto, e sempre su mobile */}
        {/* Desktop: solo badge contatore quando vuoto */}
        {!hasCartItems && (
          <div className="hidden lg:flex fixed bottom-6 right-6 z-50">
            <div className="bg-muted/80 backdrop-blur border rounded-full px-4 py-2.5 flex items-center gap-2 text-sm text-muted-foreground shadow-lg">
              <ShoppingCart className="h-4 w-4" />
              Carrello vuoto
            </div>
          </div>
        )}

        {/* Mobile: Sheet slide-over per il carrello */}
        <div className="lg:hidden fixed bottom-6 right-6 z-50">
          <Sheet open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
            <SheetTrigger asChild>
              <Button size="lg" className="rounded-full shadow-lg gap-2 h-12 px-5">
                <ShoppingCart className="h-5 w-5" />
                {hasCartItems && (
                  <span className="bg-primary-foreground text-primary rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold">
                    {cart.length}
                  </span>
                )}
                {!hasCartItems && <span>Carrello</span>}
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:w-[400px] overflow-y-auto">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4" />
                  Carrello ({cart.length}{" "}
                  {cart.length === 1 ? "prodotto" : "prodotti"})
                </SheetTitle>
              </SheetHeader>
              <div className="mt-4">
                <CartContent {...cartContentProps} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </DashboardLayout>
  );
}
