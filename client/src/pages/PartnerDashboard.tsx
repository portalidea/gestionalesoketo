/**
 * F3+F16+F17 — Enhanced PartnerDashboard
 * Dashboard del portale partner retailer con:
 * - Sezione promo in alto (F16)
 * - KPI cards con fatturato mese e tier (F3)
 * - Alert scadenze (F17)
 * - Suggerimenti riordino (F17)
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Calendar,
  Euro,
  Loader2,
  Package,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Warehouse,
} from "lucide-react";

export default function PartnerDashboard() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const statsQuery = trpc.retailerPortal.dashboardStats.useQuery(undefined, {
    enabled: Boolean(user),
  });
  const expiringQuery = trpc.retailerPortal.expiringBatches.useQuery(undefined, {
    enabled: Boolean(user),
  });
  const reorderQuery = trpc.retailerPortal.reorderSuggestions.useQuery(undefined, {
    enabled: Boolean(user),
  });
  const promosQuery = trpc.retailerPortal.activePromotions.useQuery(undefined, {
    enabled: Boolean(user),
  });

  // Fetch retailer name
  const retailerQuery = trpc.retailers.getById.useQuery(
    { id: user?.retailerId ?? "" },
    { enabled: Boolean(user?.retailerId) },
  );
  const retailerName = retailerQuery.data?.name ?? "Partner";

  const promos = promosQuery.data ?? [];
  const expiring = expiringQuery.data ?? [];
  const reorderItems = reorderQuery.data ?? [];
  const expiredCount = expiring.filter((b) => b.isExpired).length;
  const expiringCount = expiring.filter((b) => !b.isExpired).length;

  return (
    <PartnerLayout>
      <div className="space-y-6">
        {/* F16: Promo Banner Section */}
        {promos.length > 0 && (
          <div className="space-y-3">
            {promos.map((promo) => (
              <div
                key={promo.id}
                className="relative overflow-hidden rounded-xl p-4 text-white"
                style={{ backgroundColor: promo.bannerColor || "#7AB648" }}
              >
                <div className="flex items-center gap-3">
                  <Sparkles className="h-6 w-6 flex-shrink-0" />
                  <div className="flex-1">
                    <h3 className="font-bold text-lg">{promo.title}</h3>
                    <p className="text-white/90 text-sm">{promo.description}</p>
                    {promo.discountPercent && (
                      <Badge className="mt-1 bg-white/20 text-white border-white/30">
                        -{promo.discountPercent}%
                      </Badge>
                    )}
                  </div>
                  {promo.validTo && (
                    <div className="text-right text-xs text-white/70">
                      <Calendar className="h-3 w-3 inline mr-1" />
                      Fino al {new Date(promo.validTo).toLocaleDateString("it-IT")}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-1">
            Benvenuto, {user?.name || user?.email}
          </h1>
          <p className="text-muted-foreground">
            Portale partner di <span className="font-medium text-[#7AB648]">{retailerName}</span>
            {statsQuery.data?.tierName && (
              <Badge variant="outline" className="ml-2 text-[#7AB648] border-[#7AB648]">
                {statsQuery.data.tierName}
              </Badge>
            )}
          </p>
        </div>

        {/* KPI Cards */}
        {statsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <KpiCard
              title="Fatturato mese"
              value={parseFloat(statsQuery.data?.currentMonthRevenue ?? "0").toFixed(0)}
              prefix="€"
              icon={Euro}
              color="#2D5A27"
              subtitle={statsQuery.data?.tierThreshold ? `Soglia: €${parseFloat(statsQuery.data.tierThreshold).toFixed(0)}` : undefined}
            />
            <KpiCard
              title="Ordini totali"
              value={statsQuery.data?.totalOrders ?? 0}
              icon={ShoppingCart}
              color="#2D5A27"
            />
            <KpiCard
              title="Ordini in attesa"
              value={statsQuery.data?.pendingOrders ?? 0}
              icon={Package}
              color="#7AB648"
              highlight={(statsQuery.data?.pendingOrders ?? 0) > 0}
            />
            <KpiCard
              title="Stock attivo"
              value={statsQuery.data?.activeStock ?? 0}
              suffix="pz"
              icon={Warehouse}
              color="#2D5A27"
            />
            <KpiCard
              title="Valore inventario"
              value={statsQuery.data?.inventoryValue ?? "0.00"}
              prefix="€"
              icon={TrendingUp}
              color="#7AB648"
            />
          </div>
        )}

        {/* F17: Alert Scadenze */}
        {(expiredCount > 0 || expiringCount > 0) && (
          <Card className={expiredCount > 0 ? "border-red-200 bg-red-50/50" : "border-amber-200 bg-amber-50/50"}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <AlertTriangle className={`h-5 w-5 ${expiredCount > 0 ? "text-red-500" : "text-amber-500"}`} />
                Attenzione Scadenze
                {expiredCount > 0 && (
                  <Badge variant="destructive" className="ml-2">{expiredCount} scaduti</Badge>
                )}
                {expiringCount > 0 && (
                  <Badge className="ml-1 bg-amber-100 text-amber-800 border-amber-300">{expiringCount} in scadenza</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {expiring.slice(0, 8).map((batch) => (
                  <div
                    key={batch.batchId}
                    className={`flex items-center justify-between p-2 rounded-lg ${
                      batch.isExpired ? "bg-red-100/80" : "bg-amber-100/80"
                    }`}
                  >
                    <div>
                      <span className="font-medium text-sm">{batch.productName}</span>
                      <span className="text-xs text-muted-foreground ml-2">Lotto {batch.batchNumber}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{batch.quantity} pz</span>
                      <Badge variant={batch.isExpired ? "destructive" : "outline"} className="text-xs">
                        {batch.isExpired ? "SCADUTO" : `${batch.daysLeft}gg`}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* F17: Suggerimenti Riordino */}
        {reorderItems.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <RefreshCw className="h-5 w-5 text-[#7AB648]" />
                Suggerimenti Riordino
                <Badge variant="outline" className="ml-2">{reorderItems.length} prodotti</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {reorderItems.map((item) => (
                  <div
                    key={item.productId}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex-1">
                      <span className="font-medium text-sm">{item.productName}</span>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-muted-foreground">
                          Stock: <strong>{item.currentStock}</strong> pz
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Media mensile: <strong>{item.avgMonthlyQty}</strong> pz
                        </span>
                        <Badge variant={item.daysOfStock <= 7 ? "destructive" : "outline"} className="text-xs">
                          {item.daysOfStock <= 0 ? "Esaurito" : `~${item.daysOfStock}gg rimasti`}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[#7AB648]"
                      onClick={() => navigate("/partner-portal/catalog")}
                    >
                      Ordina <ArrowRight className="h-3 w-3 ml-1" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {!statsQuery.isLoading &&
          (statsQuery.data?.totalOrders ?? 0) === 0 &&
          reorderItems.length === 0 &&
          expiring.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <ShoppingCart className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  Nessun ordine ancora
                </h3>
                <p className="text-muted-foreground max-w-md">
                  Quando inizierai a effettuare ordini, qui vedrai un riepilogo
                  completo della tua attività con suggerimenti personalizzati.
                </p>
                <Button
                  className="mt-4 bg-[#7AB648] hover:bg-[#6aa03d]"
                  onClick={() => navigate("/partner-portal/catalog")}
                >
                  Vai al Catalogo <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </CardContent>
            </Card>
          )}

        {/* Notifiche */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Bell className="h-5 w-5 text-[#7AB648]" />
              Notifiche recenti
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Bell className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">
                Nessuna notifica al momento. Le notifiche su ordini, spedizioni e
                aggiornamenti appariranno qui.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </PartnerLayout>
  );
}

function KpiCard({
  title,
  value,
  prefix,
  suffix,
  subtitle,
  icon: Icon,
  color,
  highlight,
}: {
  title: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color: string;
  highlight?: boolean;
}) {
  return (
    <Card
      className={`transition-all ${highlight ? "ring-1 ring-[#7AB648]/40" : ""}`}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <div
          className="h-8 w-8 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${color}15` }}
        >
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {prefix && (
            <span className="text-lg font-normal text-muted-foreground mr-0.5">
              {prefix}
            </span>
          )}
          {typeof value === "number" ? value.toLocaleString("it-IT") : value}
          {suffix && (
            <span className="text-sm font-normal text-muted-foreground ml-1">
              {suffix}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}
