import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Warehouse, ShoppingCart, ShoppingBag, ArrowRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatEur, formatNum } from "@/components/reports";
import { getDefaultDateRange } from "@/components/reports";

export default function ReportsHub() {
  const dateRange = getDefaultDateRange();

  // Micro-preview queries
  const warehouseOverview = trpc.reports.warehouse.getOverview.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
  });

  const salesOverview = trpc.reports.sales.getOverview.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
  });

  const marketplaceOverview = trpc.reports.marketplace.getOverview.useQuery({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
  });

  const cards = [
    {
      title: "Magazzino",
      description: "Valore stock, movimenti, scadenze, top prodotti",
      href: "/reports/warehouse",
      icon: <Warehouse className="h-8 w-8 text-green-700" />,
      preview: warehouseOverview.data
        ? `Valore: ${formatEur(warehouseOverview.data.snapshot.totalValueAtCost)} · ${formatNum(warehouseOverview.data.snapshot.totalUnits)} pezzi`
        : "Caricamento...",
    },
    {
      title: "Vendite & Ordini",
      description: "Fatturato, ordini, retailer, top prodotti",
      href: "/reports/sales",
      icon: <ShoppingCart className="h-8 w-8 text-green-700" />,
      preview: salesOverview.data
        ? `Fatturato: ${formatEur(salesOverview.data.revenue.grossTotal)} · ${formatNum(salesOverview.data.orders.total)} ordini`
        : "Caricamento...",
    },
    {
      title: "Marketplace",
      description: "Shopify, confronto canali, top SKU",
      href: "/reports/marketplace",
      icon: <ShoppingBag className="h-8 w-8 text-green-700" />,
      preview: marketplaceOverview.data
        ? `Vendite: ${formatEur(marketplaceOverview.data.summary.totalGross)} · ${formatNum(marketplaceOverview.data.summary.ordersCount)} ordini`
        : "Caricamento...",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Reportistica</h1>
      <p className="text-muted-foreground">
        Dashboard interattive con statistiche, grafici e tabelle. Seleziona un report per iniziare.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {cards.map((card) => (
          <Link key={card.href} href={card.href}>
            <a className="block group">
              <Card className="h-full transition-all hover:shadow-md hover:border-green-500/50 group-hover:scale-[1.01]">
                <CardHeader className="flex flex-row items-center gap-4 pb-2">
                  {card.icon}
                  <div>
                    <CardTitle className="text-lg">{card.title}</CardTitle>
                    <p className="text-sm text-muted-foreground">{card.description}</p>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{card.preview}</span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-green-600 transition-colors" />
                  </div>
                </CardContent>
              </Card>
            </a>
          </Link>
        ))}
      </div>
    </div>
  );
}
