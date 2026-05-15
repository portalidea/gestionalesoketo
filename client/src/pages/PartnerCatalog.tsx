/**
 * M6.2.B — PartnerCatalog
 * Griglia catalogo prodotti per retailer con:
 * - Search bar + filtro categoria
 * - Card prodotto: immagine, nome, SKU, prezzo barrato/scontato, stock, aggiungi al carrello
 * - Floating cart button
 * - Paginazione
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const [category, setCategory] = useState<string>("");
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

  const catalogQuery = trpc.catalogPortal.list.useQuery({
    search: debouncedSearch || undefined,
    category: category || undefined,
    page,
    pageSize,
  });

  const categoriesQuery = trpc.catalogPortal.categories.useQuery();

  const totalPages = Math.ceil((catalogQuery.data?.total ?? 0) / pageSize);

  // Quantità locale per input "aggiungi"
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const getQty = (productId: string) => quantities[productId] ?? 1;
  const setQty = (productId: string, qty: number) => {
    setQuantities((prev) => ({ ...prev, [productId]: Math.max(1, qty) }));
  };

  const handleAdd = (item: NonNullable<typeof catalogQuery.data>["items"][0]) => {
    const qty = getQty(item.productId);
    addItem({
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      unitPriceFinal: item.unitPriceFinal,
      unitPriceBase: item.unitPriceBase,
      vatRate: item.vatRate,
      imageUrl: item.imageUrl,
      sellableUnitLabel: item.sellableUnitLabel,
      stockAvailable: item.stockAvailable,
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
              {catalogQuery.data?.total ?? 0} prodotti disponibili
            </p>
          </div>
        </div>

        {/* Filtri */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Cerca per nome, SKU o categoria..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select
            value={category}
            onValueChange={(v) => {
              setCategory(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder="Tutte le categorie" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutte le categorie</SelectItem>
              {categoriesQuery.data?.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Loading */}
        {catalogQuery.isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
          </div>
        )}

        {/* Empty state */}
        {!catalogQuery.isLoading && (catalogQuery.data?.items.length ?? 0) === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Package className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-2">Nessun prodotto trovato</h3>
            <p className="text-muted-foreground text-sm">
              Prova a modificare i filtri di ricerca.
            </p>
          </div>
        )}

        {/* Grid prodotti */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {catalogQuery.data?.items.map((item) => {
            const inCart = getItemQuantity(item.productId);
            const hasDiscount = parseFloat(item.discountPercent) > 0;
            const stockLow = item.stockAvailable > 0 && item.stockAvailable < 10;
            const outOfStock = item.stockAvailable <= 0;

            return (
              <Card
                key={item.productId}
                className={`overflow-hidden transition-all hover:shadow-md ${outOfStock ? "opacity-60" : ""}`}
              >
                {/* Immagine */}
                <div
                  className="aspect-square bg-muted/30 flex items-center justify-center cursor-pointer relative"
                  onClick={() => setLocation(`/partner-portal/catalog/${item.productId}`)}
                >
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Package className="h-12 w-12 text-muted-foreground/30" />
                  )}
                  {inCart > 0 && (
                    <div className="absolute top-2 right-2 bg-[#7AB648] text-white text-xs font-bold rounded-full h-6 w-6 flex items-center justify-center">
                      {inCart}
                    </div>
                  )}
                  {outOfStock && (
                    <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
                      <Badge variant="destructive" className="text-sm">Esaurito</Badge>
                    </div>
                  )}
                </div>

                <CardContent className="p-4 space-y-3">
                  {/* Nome + SKU */}
                  <div>
                    <h3
                      className="font-semibold text-sm leading-tight line-clamp-2 cursor-pointer hover:text-[#7AB648] transition-colors"
                      onClick={() => setLocation(`/partner-portal/catalog/${item.productId}`)}
                    >
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
                        &euro;{item.unitPriceBase}
                      </span>
                    )}
                    <span className="text-lg font-bold text-[#2D5A27] dark:text-[#7AB648]">
                      &euro;{item.unitPriceFinal}
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
                      : `${item.stockAvailable} ${item.sellableUnitLabel.toLowerCase()} disponibili`}
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
                          max={item.stockAvailable}
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
