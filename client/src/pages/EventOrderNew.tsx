/**
 * M6.2.D — EventOrderNew page (Admin)
 *
 * Crea un ordine evento (fiera, evento, omaggio, uso interno, altro).
 * Nessun retailer coinvolto. Pricing a prezzo pieno (sconto 0%).
 * FEFO allocation automatica.
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
  Calendar,
  Loader2,
  Minus,
  Package,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  EVENT_TYPES,
  eventTypeLabels,
  type EventType,
} from "../../../shared/eventTypeLabels";

type CartItem = {
  productId: string;
  quantity: number;
};

export default function EventOrderNew() {
  const [, setLocation] = useLocation();
  // Event fields
  const [eventType, setEventType] = useState<EventType | "">("");
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [fiscalReceiptRef, setFiscalReceiptRef] = useState("");
  // Cart & notes
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState("");
  const [notesInternal, setNotesInternal] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Data
  const productsQuery = trpc.products.list.useQuery();
  const utils = trpc.useUtils();

  // Create event order mutation
  const createEventOrder = trpc.orders.createEventOrder.useMutation({
    onSuccess: (data) => {
      if (data.fefoWarnings && data.fefoWarnings.length > 0) {
        toast.success(`Ordine evento ${data.orderNumber} creato`, {
          description: `${data.fefoWarnings.length} avviso/i stock.`,
          duration: 6000,
        });
        for (const w of data.fefoWarnings) {
          toast.warning(w, { duration: 8000 });
        }
      } else {
        toast.success(`Ordine evento ${data.orderNumber} creato — lotti FEFO assegnati`);
      }
      utils.orders.list.invalidate();
      setLocation(`/orders/${data.id}`);
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
      setIsSubmitting(false);
    },
  });

  // Products
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

  const productMap = useMemo(() => {
    if (!productsQuery.data) return new Map<string, any>();
    return new Map(productsQuery.data.map((p) => [p.id, p]));
  }, [productsQuery.data]);

  const cartProductIds = useMemo(() => new Set(cart.map((c) => c.productId)), [cart]);
  const hasCartItems = cart.length > 0;

  // Cart actions
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
    if (!eventType) {
      toast.error("Seleziona il tipo evento");
      return;
    }
    if (!eventName.trim()) {
      toast.error("Inserisci il nome evento");
      return;
    }
    if (cart.length === 0) {
      toast.error("Aggiungi almeno un prodotto al carrello");
      return;
    }
    setIsSubmitting(true);
    createEventOrder.mutate({
      eventType: eventType as EventType,
      eventName: eventName.trim(),
      eventDate: eventDate || undefined,
      fiscalReceiptRef: fiscalReceiptRef || undefined,
      items: cart.map((c) => ({ productId: c.productId, quantity: c.quantity })),
      notes: notes || undefined,
      notesInternal: notesInternal || undefined,
    });
  }, [eventType, eventName, eventDate, fiscalReceiptRef, cart, notes, notesInternal, createEventOrder]);

  const totalCartQty = cart.reduce((sum, c) => sum + c.quantity, 0);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/orders")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Nuovo Ordine Evento</h1>
            <p className="text-sm text-muted-foreground">
              Crea un ordine per fiera, evento, omaggio o uso interno (no retailer)
            </p>
          </div>
        </div>

        <div className="flex gap-6 items-start">
          {/* Left column */}
          <div className={`space-y-6 min-w-0 ${hasCartItems ? "flex-1" : "w-full"}`}>
            {/* Event details card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Dettagli Evento
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Tipo evento *</Label>
                    <Select value={eventType} onValueChange={(v) => setEventType(v as EventType)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Seleziona tipo..." />
                      </SelectTrigger>
                      <SelectContent>
                        {EVENT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {eventTypeLabels[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Nome evento *</Label>
                    <Input
                      value={eventName}
                      onChange={(e) => setEventName(e.target.value)}
                      placeholder="Es. Fiera del Bio 2026"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Data evento</Label>
                    <Input
                      type="date"
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Rif. scontrino/ricevuta</Label>
                    <Input
                      value={fiscalReceiptRef}
                      onChange={(e) => setFiscalReceiptRef(e.target.value)}
                      placeholder="Es. RIC-2026-001"
                      maxLength={50}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Product catalog */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Catalogo Prodotti</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
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
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="max-h-[400px] overflow-y-auto border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[80px]">SKU</TableHead>
                          <TableHead>Prodotto</TableHead>
                          <TableHead className="text-right w-[90px]">Prezzo</TableHead>
                          <TableHead className="text-right w-[70px]">IVA</TableHead>
                          <TableHead className="text-center w-[60px]">Azione</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredProducts.map((p) => (
                          <TableRow key={p.id} className={cartProductIds.has(p.id) ? "bg-accent/30" : ""}>
                            <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                            <TableCell>
                              <span className="font-medium text-sm">{p.name}</span>
                              {p.category && (
                                <span className="text-xs text-muted-foreground ml-2">{p.category}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              €{parseFloat(p.unitPrice || "0").toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge variant="outline" className="text-xs">
                                {p.vatRate}%
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center">
                              <Button
                                size="sm"
                                variant={cartProductIds.has(p.id) ? "secondary" : "default"}
                                className="h-7 w-7 p-0"
                                onClick={() => addToCart(p.id)}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                        {filteredProducts.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
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

            {/* Notes */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Note</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Note ordine</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Note sull'evento..."
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

          {/* Right column: cart */}
          {hasCartItems && (
            <div className="hidden lg:block w-[380px] shrink-0">
              <Card className="sticky top-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShoppingCart className="h-4 w-4" />
                    Carrello ({cart.length} {cart.length === 1 ? "prodotto" : "prodotti"}, {totalCartQty} pz)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="max-h-[400px] overflow-y-auto space-y-2">
                    {cart.map((item) => {
                      const product = productMap.get(item.productId);
                      if (!product) return null;
                      const unitPrice = parseFloat(product.unitPrice || "0");
                      const lineTotal = unitPrice * item.quantity;
                      return (
                        <div key={item.productId} className="flex items-center gap-2 p-2 border rounded-md">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{product.name}</p>
                            <p className="text-xs text-muted-foreground">
                              €{unitPrice.toFixed(2)} × {item.quantity} = €{lineTotal.toFixed(2)}
                            </p>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 w-6 p-0"
                              onClick={() => setQuantity(item.productId, item.quantity - 1)}
                              disabled={item.quantity <= 1}
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <Input
                              type="number"
                              value={item.quantity}
                              onChange={(e) => setQuantity(item.productId, parseInt(e.target.value) || 1)}
                              className="h-6 w-12 text-center text-xs p-0"
                              min={1}
                              max={9999}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 w-6 p-0"
                              onClick={() => setQuantity(item.productId, item.quantity + 1)}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 text-destructive"
                              onClick={() => removeFromCart(item.productId)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <Separator />
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Sconto</span>
                      <span>0% (prezzo pieno)</span>
                    </div>
                    <div className="flex justify-between font-medium">
                      <span>Totale stimato</span>
                      <span>
                        €{cart.reduce((sum, item) => {
                          const p = productMap.get(item.productId);
                          return sum + (p ? parseFloat(p.unitPrice || "0") * item.quantity : 0);
                        }, 0).toFixed(2)} + IVA
                      </span>
                    </div>
                  </div>
                  <Button
                    className="w-full"
                    onClick={handleSubmit}
                    disabled={!eventType || !eventName.trim() || cart.length === 0 || isSubmitting}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Creazione...
                      </>
                    ) : (
                      <>
                        <Package className="h-4 w-4 mr-2" />
                        Crea Ordine Evento
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* Empty cart indicator */}
        {!hasCartItems && (
          <div className="hidden lg:flex fixed bottom-6 right-6 z-50">
            <div className="bg-muted/80 backdrop-blur border rounded-full px-4 py-2.5 flex items-center gap-2 text-sm text-muted-foreground shadow-lg">
              <ShoppingCart className="h-4 w-4" />
              Carrello vuoto
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
