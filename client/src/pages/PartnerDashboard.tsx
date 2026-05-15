/**
 * M6.1 — PartnerDashboard
 * Dashboard base del portale partner retailer.
 * Mostra KPI cards (ordini, stock, valore inventario) e placeholder notifiche.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import {
  Bell,
  Loader2,
  Package,
  ShoppingCart,
  TrendingUp,
  Warehouse,
} from "lucide-react";

export default function PartnerDashboard() {
  const { user } = useAuth();
  const statsQuery = trpc.retailerPortal.dashboardStats.useQuery(undefined, {
    enabled: Boolean(user),
  });

  // Fetch retailer name
  const retailerQuery = trpc.retailers.getById.useQuery(
    { id: user?.retailerId ?? "" },
    { enabled: Boolean(user?.retailerId) },
  );
  const retailerName = retailerQuery.data?.name ?? "Partner";

  return (
    <PartnerLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-1">
            Benvenuto, {user?.name || user?.email}
          </h1>
          <p className="text-muted-foreground">
            Portale partner di <span className="font-medium text-[#7AB648]">{retailerName}</span>
          </p>
        </div>

        {/* KPI Cards */}
        {statsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-[#7AB648]" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
              highlight={
                (statsQuery.data?.pendingOrders ?? 0) > 0
              }
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

        {/* Empty state */}
        {!statsQuery.isLoading &&
          (statsQuery.data?.totalOrders ?? 0) === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <ShoppingCart className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  Nessun ordine ancora
                </h3>
                <p className="text-muted-foreground max-w-md">
                  Quando inizierai a effettuare ordini, qui vedrai un riepilogo
                  completo della tua attività. La sezione Ordini sarà disponibile
                  prossimamente.
                </p>
              </CardContent>
            </Card>
          )}

        {/* Placeholder Notifiche */}
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
  icon: Icon,
  color,
  highlight,
}: {
  title: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
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
      </CardContent>
    </Card>
  );
}
