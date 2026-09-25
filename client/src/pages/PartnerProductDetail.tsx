/**
 * M6.2.B — PartnerProductDetail
 * Dettaglio prodotto per retailer: immagine, pricing, lotti FEFO, aggiungi al carrello.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCart } from "@/contexts/CartContext";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  Loader2,
  Minus,
  Package,
  Plus,
  ShoppingCart,
} from "lucide-react";
import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

export default function PartnerProductDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { addItem, getItemQuantity, itemCount } = useCart();
  const [qty, setQty] = useState(1);

  const detailQuery = trpc.retailerSelfService.catalogGetById.useQuery(
    { productId: id! },
    { enabled: Boolean(id) },
  );

  const data = detailQuery.data;
  const product = data?.product;
  const hasDiscount = product ? parseFloat(product.discountPercent) > 0 : false;
  const hasPromotion = Boolean(product?.promotionId);
  const inCart = getItemQuantity(id ?? "");

  const handleAdd = () => {
    if (!product) return;
    addItem({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      unitPriceFinal: product.unitPriceFinal,
      unitPriceBase: product.unitPriceBase,
      vatRate: product.vatRate.toFixed(2),
      imageUrl: product.imageUrl,
      sellableUnitLabel: product.sellableUnitLabel,
      quantity: qty,
    });
    toast.success(`${product.name} aggiunto al carrello`, {
      description: `${qty} ${product.sellableUnitLabel.toLowerCase()}`,
    });
    setQty(1);
  };

  return (
    <PartnerLayout>
      <div className="space-y-6 max-w-4xl">
        {/* Back */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/partner-portal/catalog")}
          className="gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
          Torna al catalogo
        </Button>

        {detailQuery.isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
          </div>
        )}

        {product && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Immagine */}
            <div className="aspect-square bg-muted/30 rounded-xl flex items-center justify-center overflow-hidden">
              {product.imageUrl ? (
                <img
                  src={product.imageUrl}
                  alt={product.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <Package className="h-20 w-20 text-muted-foreground/30" />
              )}
            </div>

            {/* Info */}
            <div className="space-y-5">
              <div>
                <p className="text-sm text-muted-foreground">{product.sku}</p>
                <h1 className="text-2xl font-bold text-foreground mt-1">{product.name}</h1>
                {product.category && (
                  <Badge variant="outline" className="mt-2">
                    {product.category}
                  </Badge>
                )}
              </div>

              {product.description && (
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {product.description}
                </p>
              )}

              {/* Pricing */}
              <Card>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-baseline gap-3">
                    {hasDiscount && (
                      <span className="text-lg text-muted-foreground line-through">
                        &euro;{product.unitPriceBeforePromotion ?? product.unitPriceBase}
                      </span>
                    )}
                    <span className="text-3xl font-bold text-[#2D5A27] dark:text-[#7AB648]">
                      &euro;{product.unitPriceFinal}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      /{product.sellableUnitLabel.toLowerCase()}
                    </span>
                  </div>
                  {hasPromotion && (
                    <p className="text-sm text-[#7AB648] font-medium">
                      Promo {product.promotionTitle}: -{product.promotionDiscountPercent}% sul tuo prezzo riservato
                    </p>
                  )}
                  {!hasPromotion && hasDiscount && product.packageName && (
                    <p className="text-sm text-[#7AB648] font-medium">
                      Sconto pacchetto {product.packageName}: {product.discountPercent}%
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    IVA {product.vatRate}% — Prezzo netto IVA esclusa
                  </p>
                </CardContent>
              </Card>

              {inCart > 0 && (
                <Badge className="bg-[#7AB648] text-white">
                  {inCart} nel carrello
                </Badge>
              )}

              {/* Aggiungi al carrello */}
              <div className="flex items-center gap-3">
                <div className="flex items-center border rounded-lg">
                  <button
                    className="p-2 hover:bg-accent transition-colors"
                    onClick={() => setQty(Math.max(1, qty - 1))}
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <input
                    type="number"
                    min={1}
                    value={qty}
                    onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-14 text-center text-base bg-transparent border-x py-2 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <button
                    className="p-2 hover:bg-accent transition-colors"
                    onClick={() => setQty(qty + 1)}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <Button
                  className="flex-1 bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white h-11"
                  onClick={handleAdd}
                >
                  <ShoppingCart className="h-4 w-4 mr-2" />
                  Aggiungi al carrello
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Floating cart button */}
        {itemCount > 0 && (
          <button
            onClick={() => setLocation("/partner-portal/cart")}
            className="fixed bottom-6 right-6 z-50 bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white rounded-full p-4 shadow-lg transition-all hover:scale-105"
          >
            <ShoppingCart className="h-6 w-6" />
            <span className="absolute -top-1 -right-1 bg-[#7AB648] text-white text-xs font-bold rounded-full h-6 w-6 flex items-center justify-center">
              {itemCount}
            </span>
          </button>
        )}
      </div>
    </PartnerLayout>
  );
}
