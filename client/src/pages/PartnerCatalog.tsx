/**
 * M6.2.B Parte B — PartnerCatalog
 * Griglia catalogo prodotti per retailer con:
 * - Search bar
 * - Card prodotto: immagine, nome, SKU, prezzo barrato/scontato, stock, aggiungi al carrello
 * - Floating cart button con badge count
 * - Paginazione
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCart } from "@/contexts/CartContext";
import { trpc } from "@/lib/trpc";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Minus,
  Package,
  Plus,
  Search,
  ShoppingCart,
} from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function PartnerCatalog() {
  const [, setLocation] = useLocation();
  const { addItem, getItemQuantity, itemCount } = useCart();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 24;

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchTimer, setSearchTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = (value: string) => {
    setSearch(value);
    if (searchTimer) clearTimeout(searchTimer);
    const timer = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
    setSearchTimer(timer);
  };

  const catalogQuery = trpc.retailerSelfService.catalogList.useQuery({
    search: debouncedSearch || undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const totalPages = Math.ceil((catalogQuery.data?.totalCount ?? 0) / pageSize);

  // Quantità locale per input "aggiungi"
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const getQty = (productId: string) => quantities[productId] ?? 1;
  const setQty = (productId: string, qty: number) => {
    setQuantities((prev) => ({ ...prev, [productId]: Math.max(1, qty) }));
  };

  const handleAdd = (item: NonNullable<typeof catalogQuery.data>["products"][0]) => {
    const qty = getQty(item.productId);
    addItem({
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      unitPriceFinal: item.discountedPrice.toFixed(2),
      unitPriceBase: item.listPrice.toFixed(2),
      vatRate: item.vatRate.toFixed(2),
      imageUrl: item.imageUrl,
      sellableUnitLabel: item.sellableUnitLabel,
      stockAvailable: item.availableStock,
      quantity: qty,
    });
    toast.success(`${item.name} aggiunto al carrello`, {
      description: `${qty} ${item.sellableUnitLabel.toLowerCase()}`,
    });
    setQuantities((prev) => ({ ...prev, [item.productId]: 1 }));
  };

  return (
    <PartnerLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Catalogo</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {catalogQuery.data?.totalCount ?? 0} prodotti disponibili
              {catalogQuery.data?.packageName && (
                <span className="ml-2 text-[#7AB648] font-medium">
                  — Sconto {catalogQuery.data.discountPercent}% ({catalogQuery.data.packageName})
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Filtri */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Cerca per nome prodotto..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        {/* Loading */}
        {catalogQuery.isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
          </div>
        )}

        {/* Empty state */}
        {!catalogQuery.isLoading && catalogQuery.data?.products.length === 0 && (
          <div className="text-center py-16">
            <Package className="h-12 w-12 mx-auto text-muted-foreground/40" />
            <p className="mt-4 text-muted-foreground">
              {debouncedSearch
                ? `Nessun prodotto trovato per "${debouncedSearch}"`
                : "Nessun prodotto disponibile al momento"}
            </p>
          </div>
        )}

        {/* Griglia prodotti */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {catalogQuery.data?.products.map((item) => {
            const outOfStock = item.availableStock <= 0;
            const stockLow = item.availableStock > 0 && item.availableStock <= 5;
            const hasDiscount = item.discountPercentage > 0;
            const inCart = getItemQuantity(item.productId);

            return (
              <Card
                key={item.productId}
                className={`overflow-hidden transition-all hover:shadow-md ${outOfStock ? "opacity-60" : ""}`}
              >
                {/* Immagine */}
                <div className="relative aspect-square bg-muted">
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Package className="h-12 w-12 text-muted-foreground/30" />
                    </div>
                  )}
                  {inCart > 0 && (
                    <div className="absolute top-2 right-2 bg-[#2D5A27] text-white text-xs font-bold rounded-full h-6 w-6 flex items-center justify-center">
                      {inCart}
                    </div>
                  )}
                  {hasDiscount && (
                    <div className="absolute top-2 left-2 bg-[#F5A623] text-white text-xs font-bold rounded-md px-2 py-0.5">
                      -{item.discountPercentage.toFixed(0)}%
                    </div>
                  )}
                  {outOfStock && (
                    <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
                      <Badge variant="destructive" className="text-sm">Esaurito</Badge>
                    </div>
                  )}
                </div>

                <CardContent className="p-4 space-y-2">
                  {/* Nome e SKU */}
                  <div>
                    <h3 className="font-semibold text-sm leading-tight line-clamp-2">
                      {item.name}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{item.sku}</p>
                  </div>

                  {/* Categoria */}
                  {item.category && (
                    <Badge variant="outline" className="text-xs">
                      {item.category}
                    </Badge>
                  )}

                  {/* Prezzo */}
                  <div className="flex items-baseline gap-2">
                    {hasDiscount && (
                      <span className="text-sm text-muted-foreground line-through">
                        &euro;{item.listPrice.toFixed(2)}
                      </span>
                    )}
                    <span className="text-lg font-bold text-[#2D5A27] dark:text-[#7AB648]">
                      &euro;{item.discountedPrice.toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      /{item.sellableUnitLabel.toLowerCase()}
                    </span>
                  </div>

                  {/* Stock */}
                  <p
                    className={`text-xs font-medium ${
                      outOfStock
                        ? "text-destructive"
                        : stockLow
                          ? "text-yellow-600 dark:text-yellow-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {outOfStock
                      ? "Non disponibile"
                      : `${item.availableStock} ${item.sellableUnitLabel.toLowerCase()} disponibili`}
                  </p>

                  {/* Aggiungi al carrello */}
                  {!outOfStock && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center border rounded-md">
                        <button
                          className="p-1.5 hover:bg-accent transition-colors"
                          onClick={() => setQty(item.productId, getQty(item.productId) - 1)}
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          max={item.availableStock}
                          value={getQty(item.productId)}
                          onChange={(e) => setQty(item.productId, parseInt(e.target.value) || 1)}
                          className="w-10 text-center text-sm bg-transparent border-x py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          className="p-1.5 hover:bg-accent transition-colors"
                          onClick={() => setQty(item.productId, getQty(item.productId) + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                      <Button
                        size="sm"
                        className="flex-1 bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
                        onClick={() => handleAdd(item)}
                      >
                        <ShoppingCart className="h-3.5 w-3.5 mr-1" />
                        Aggiungi
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Paginazione */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Pagina {page} di {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
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
