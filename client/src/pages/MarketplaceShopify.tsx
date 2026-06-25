import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Store,
  RefreshCw,
  Settings,
  Package,
  ShoppingCart,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
} from "lucide-react";

export default function MarketplaceShopify() {
  const { data: store, isLoading, refetch } = trpc.shopify.store.get.useQuery();
  const { data: variantsList } = trpc.shopify.variants.list.useQuery(
    { limit: 1, offset: 0 },
    { enabled: !!store },
  );
  const { data: ordersList } = trpc.shopify.orders.list.useQuery(
    { limit: 1, offset: 0 },
    { enabled: !!store },
  );
  const { data: pendingOrders } = trpc.shopify.orders.list.useQuery(
    { status: "pending", limit: 1, offset: 0 },
    { enabled: !!store },
  );
  const { data: failedOrders } = trpc.shopify.orders.list.useQuery(
    { status: "failed", limit: 1, offset: 0 },
    { enabled: !!store },
  );

  // Config form state
  const [showConfig, setShowConfig] = useState(false);
  const [name, setName] = useState("");
  const [storeIdentifier, setStoreIdentifier] = useState("");
  const [accessToken, setAccessToken] = useState("");

  const configureMutation = trpc.shopify.store.configure.useMutation({
    onSuccess: (data) => {
      if (data.testConnectionSuccess) {
        toast.success("Store configurato e connessione verificata!");
      } else {
        toast.warning("Store salvato ma test connessione fallito. Verifica le credenziali.");
      }
      setShowConfig(false);
      setAccessToken("");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const syncOrdersMutation = trpc.shopify.orders.syncRecent.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Sync completato: ${data.imported} importati, ${data.processedStock} stock processati, ${data.duplicates} duplicati`,
      );
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const syncVariantsMutation = trpc.shopify.variants.syncFromShopify.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Varianti sincronizzate: ${data.imported} nuove, ${data.updated} aggiornate, ${data.unmapped} da mappare`,
      );
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-64" />
            <div className="h-32 bg-muted rounded" />
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Store className="h-6 w-6" />
              Marketplace — Shopify
            </h1>
            <p className="text-muted-foreground mt-1">
              Gestione integrazione Shopify: ordini, varianti, stock
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowConfig(!showConfig)}
            >
              <Settings className="h-4 w-4 mr-1" />
              Configura
            </Button>
            {store && (
              <Button
                size="sm"
                onClick={() => syncOrdersMutation.mutate({ hoursBack: 24, financialStatus: "paid" })}
                disabled={syncOrdersMutation.isPending}
              >
                <RefreshCw className={`h-4 w-4 mr-1 ${syncOrdersMutation.isPending ? "animate-spin" : ""}`} />
                Sync Ordini
              </Button>
            )}
          </div>
        </div>

        {/* Config Panel */}
        {showConfig && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Configurazione Store Shopify</CardTitle>
              <CardDescription>
                Inserisci le credenziali del tuo store Shopify. L&apos;access token si genera da
                Settings → Apps → Develop apps → Admin API access token.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  configureMutation.mutate({ name, storeIdentifier, accessToken });
                }}
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="store-name">Nome Store</Label>
                    <Input
                      id="store-name"
                      placeholder="SoKeto Shopify"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="store-id">Store Identifier</Label>
                    <Input
                      id="store-id"
                      placeholder="mystore.myshopify.com"
                      value={storeIdentifier}
                      onChange={(e) => setStoreIdentifier(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="access-token">Admin API Access Token</Label>
                    <Input
                      id="access-token"
                      type="password"
                      placeholder="shpat_..."
                      value={accessToken}
                      onChange={(e) => setAccessToken(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={configureMutation.isPending}>
                    {configureMutation.isPending ? "Salvataggio..." : "Salva e Testa Connessione"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setShowConfig(false)}>
                    Annulla
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Status Card */}
        {store ? (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium">{store.name}</p>
                    <p className="text-sm text-muted-foreground">{store.storeIdentifier}</p>
                    {store.companyName && (
                      <p className="text-xs text-muted-foreground mt-0.5">Azienda: <span className="font-medium">{store.companyName}</span></p>
                    )}
                  </div>
                </div>
                <div className="text-right text-sm text-muted-foreground">
                  {store.lastSyncAt ? (
                    <p>Ultimo sync: {new Date(store.lastSyncAt).toLocaleString("it-IT")}</p>
                  ) : (
                    <p>Mai sincronizzato</p>
                  )}
                  <Badge variant={store.isConfigured ? "default" : "destructive"} className="mt-1">
                    {store.isConfigured ? "Connesso" : "Non configurato"}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <Store className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">Nessuno store configurato</h3>
              <p className="text-muted-foreground mb-4">
                Configura il tuo store Shopify per iniziare a sincronizzare ordini e stock.
              </p>
              <Button onClick={() => setShowConfig(true)}>
                <Settings className="h-4 w-4 mr-1" />
                Configura Store
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Dashboard Stats */}
        {store && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Link href="/marketplace/shopify/variants">
              <Card className="cursor-pointer hover:shadow-md transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Varianti Totali</p>
                      <p className="text-2xl font-bold">{variantsList?.totalCount ?? 0}</p>
                    </div>
                    <Package className="h-8 w-8 text-blue-500" />
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/marketplace/shopify/orders">
              <Card className="cursor-pointer hover:shadow-md transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Ordini Totali</p>
                      <p className="text-2xl font-bold">{ordersList?.totalCount ?? 0}</p>
                    </div>
                    <ShoppingCart className="h-8 w-8 text-green-500" />
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/marketplace/shopify/orders?status=pending">
              <Card className="cursor-pointer hover:shadow-md transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">In Attesa</p>
                      <p className="text-2xl font-bold">{pendingOrders?.totalCount ?? 0}</p>
                    </div>
                    <Clock className="h-8 w-8 text-yellow-500" />
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/marketplace/shopify/orders?status=failed">
              <Card className="cursor-pointer hover:shadow-md transition-shadow border-red-200">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Falliti</p>
                      <p className="text-2xl font-bold text-red-600">
                        {failedOrders?.totalCount ?? 0}
                      </p>
                    </div>
                    <AlertTriangle className="h-8 w-8 text-red-500" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>
        )}

        {/* Quick Actions */}
        {store && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Azioni Rapide</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Button
                  variant="outline"
                  className="h-auto py-4 flex flex-col items-center gap-2"
                  onClick={() => syncVariantsMutation.mutate()}
                  disabled={syncVariantsMutation.isPending}
                >
                  <Package className="h-5 w-5" />
                  <span className="text-sm">
                    {syncVariantsMutation.isPending ? "Sincronizzazione..." : "Sync Varianti da Shopify"}
                  </span>
                </Button>

                <Button
                  variant="outline"
                  className="h-auto py-4 flex flex-col items-center gap-2"
                  onClick={() => syncOrdersMutation.mutate({ hoursBack: 48, financialStatus: "paid" })}
                  disabled={syncOrdersMutation.isPending}
                >
                  <ShoppingCart className="h-5 w-5" />
                  <span className="text-sm">
                    {syncOrdersMutation.isPending ? "Importazione..." : "Importa Ordini (48h)"}
                  </span>
                </Button>

                <Link href="/marketplace/shopify/variants?unmapped=true">
                  <Button
                    variant="outline"
                    className="h-auto py-4 flex flex-col items-center gap-2 w-full"
                  >
                    <AlertTriangle className="h-5 w-5" />
                    <span className="text-sm">Varianti da Mappare</span>
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
