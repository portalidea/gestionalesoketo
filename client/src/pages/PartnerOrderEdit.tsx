/**
 * M6.2.B Parte B — PartnerOrderEdit
 * Modifica ordine pending: aggiorna quantità, aggiungi/rimuovi items, ricalcola totali.
 * Usa retailerSelfService.modifyOrder + retailerSelfService.cartPreview.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  ArrowLeft,
  Loader2,
  Minus,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

interface EditItem {
  productId: string;
  productName: string;
  productSku: string;
  quantity: number;
  unitPriceFinal: string;
}

export default function PartnerOrderEdit() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const orderQuery = trpc.retailerSelfService.ordersGetById.useQuery(
    { orderId: id! },
    { enabled: Boolean(id) },
  );

  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [notes, setNotes] = useState("");
  const [initialized, setInitialized] = useState(false);

  // Inizializza items dall'ordine
  useEffect(() => {
    if (orderQuery.data && !initialized) {
      const orderData = orderQuery.data;

      // Raggruppa per productId (somma qty)
      const grouped = (orderData.items ?? []).reduce(
        (acc: Record<string, EditItem>, item: any) => {
          if (!acc[item.productId]) {
            acc[item.productId] = {
              productId: item.productId,
              productName: item.productName,
              productSku: item.productSku,
              quantity: item.quantity,
              unitPriceFinal: item.unitPriceFinal,
            };
          } else {
            acc[item.productId].quantity += item.quantity;
          }
          return acc;
        },
        {} as Record<string, EditItem>,
      );

      setEditItems(Object.values(grouped));
      setNotes(orderData.order.notes ?? "");
      setInitialized(true);
    }
  }, [orderQuery.data, initialized]);

  // Preview totali live
  const previewInput = useMemo(
    () => editItems.filter((i) => i.quantity > 0).map((i) => ({ productId: i.productId, quantity: i.quantity })),
    [editItems],
  );

  const previewMutation = trpc.retailerSelfService.cartPreview.useMutation();

  // Trigger preview when items change
  useEffect(() => {
    if (previewInput.length > 0) {
      previewMutation.mutate({ items: previewInput });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(previewInput)]);

  const modifyMutation = trpc.retailerSelfService.ordersModifyItems.useMutation({
    onSuccess: () => {
      toast.success("Ordine aggiornato con successo");
      utils.retailerSelfService.ordersGetById.invalidate({ orderId: id! });
      utils.retailerSelfService.ordersList.invalidate();
      setLocation(`/partner-portal/orders/${id}`);
    },
    onError: (err: any) => {
      toast.error("Errore aggiornamento", { description: err.message });
    },
  });

  const handleUpdateQty = (productId: string, qty: number) => {
    setEditItems((prev) =>
      prev.map((i) => (i.productId === productId ? { ...i, quantity: Math.max(0, qty) } : i)),
    );
  };

  const handleRemove = (productId: string) => {
    setEditItems((prev) => prev.filter((i) => i.productId !== productId));
  };

  const handleSave = () => {
    const validItems = editItems.filter((i) => i.quantity > 0);
    if (validItems.length === 0) {
      toast.error("L'ordine deve contenere almeno un prodotto");
      return;
    }
    modifyMutation.mutate({
      orderId: id!,
      items: validItems.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      // notes non supportato in ordersModifyItems
    });
  };

  const orderData2 = orderQuery.data;
  const order = orderData2?.order;
  const pricing = previewMutation.data;

  if (orderQuery.isLoading) {
    return (
      <PartnerLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
        </div>
      </PartnerLayout>
    );
  }

  if (!order || order.status !== "pending" || !orderData2) {
    return (
      <PartnerLayout>
        <div className="text-center py-16">
          <p className="text-muted-foreground">
            {!order ? "Ordine non trovato." : "Solo ordini in stato 'pending' possono essere modificati."}
          </p>
          <Button
            variant="ghost"
            className="mt-4"
            onClick={() => setLocation("/partner-portal/orders")}
          >
            Torna agli ordini
          </Button>
        </div>
      </PartnerLayout>
    );
  }

  return (
    <PartnerLayout>
      <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation(`/partner-portal/orders/${id}`)}
            className="gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            Dettaglio
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Modifica ordine #{order.orderNumber}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Modifica quantità o rimuovi prodotti. I lotti verranno riassegnati automaticamente (FEFO).
            </p>
          </div>
        </div>

        {/* Tabella items editabile */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prodotti</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[45%]">Prodotto</TableHead>
                  <TableHead className="text-center">Quantità</TableHead>
                  <TableHead className="text-right">Prezzo unit.</TableHead>
                  <TableHead className="text-right">Totale</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {editItems.map((item) => (
                  <TableRow key={item.productId} className={item.quantity === 0 ? "opacity-40" : ""}>
                    <TableCell>
                      <p className="font-medium text-sm">{item.productName}</p>
                      <p className="text-xs text-muted-foreground">{item.productSku}</p>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          className="p-1 rounded hover:bg-accent transition-colors"
                          onClick={() => handleUpdateQty(item.productId, item.quantity - 1)}
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <input
                          type="number"
                          min={0}
                          value={item.quantity}
                          onChange={(e) =>
                            handleUpdateQty(item.productId, parseInt(e.target.value) || 0)
                          }
                          className="w-14 text-center text-sm bg-transparent border rounded py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          className="p-1 rounded hover:bg-accent transition-colors"
                          onClick={() => handleUpdateQty(item.productId, item.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      &euro;{item.unitPriceFinal}
                    </TableCell>
                    <TableCell className="text-right font-medium text-sm">
                      &euro;{(parseFloat(item.unitPriceFinal) * item.quantity).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <button
                        className="p-1.5 rounded hover:bg-destructive/10 text-destructive transition-colors"
                        onClick={() => handleRemove(item.productId)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Note */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Note ordine</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              placeholder="Istruzioni speciali..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </CardContent>
        </Card>

        {/* Totali aggiornati */}
        <Card>
          <CardContent className="p-6 space-y-3">
              {previewMutation.isPending ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Ricalcolo totali...</span>
              </div>
            ) : pricing ? (
              <>
                {pricing.warnings && (pricing.warnings as any[]).length > 0 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mb-3">
                    {(pricing.warnings as any[]).map((w: any, i: number) => (
                      <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400">
                        {typeof w === 'string' ? w : w.message}
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotale netto</span>
                  <span>&euro;{parseFloat(pricing.subtotalNet).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">IVA</span>
                  <span>&euro;{parseFloat(pricing.vatAmount).toFixed(2)}</span>
                </div>
                <div className="border-t pt-2 flex justify-between text-lg font-bold">
                  <span>Totale</span>
                  <span className="text-[#2D5A27] dark:text-[#7AB648]">
                    &euro;{parseFloat(pricing.totalGross).toFixed(2)}
                  </span>
                </div>
              </>
            ) : null}

            <div className="flex gap-3 pt-4">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setLocation(`/partner-portal/orders/${id}`)}
              >
                Annulla
              </Button>
              <Button
                className="flex-1 bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
                onClick={handleSave}
                disabled={modifyMutation.isPending || editItems.filter((i) => i.quantity > 0).length === 0}
              >
                {modifyMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Salvataggio...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4 mr-2" />
                    Salva modifiche
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              I lotti verranno riassegnati automaticamente (FEFO) e la proforma rigenerata.
            </p>
          </CardContent>
        </Card>
      </div>
    </PartnerLayout>
  );
}
