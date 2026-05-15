import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { CartProvider } from "./contexts/CartContext";
import { useAuth } from "./_core/hooks/useAuth";
import Alerts from "./pages/Alerts";
import AuthCallback from "./pages/AuthCallback";
import Home from "./pages/Home";
import Integrations from "./pages/Integrations";
import Login from "./pages/Login";
import Movements from "./pages/Movements";
import Packages from "./pages/Packages";
import ProducerDetail from "./pages/ProducerDetail";
import Producers from "./pages/Producers";
import ProductDetail from "./pages/ProductDetail";
import Products from "./pages/Products";
import Reports from "./pages/Reports";
import RetailerDetail from "./pages/RetailerDetail";
import Retailers from "./pages/Retailers";
import Team from "./pages/Team";
import Warehouse from "./pages/Warehouse";
import DdtImports from "./pages/DdtImports";
import DdtImportDetail from "./pages/DdtImportDetail";
import Orders from "./pages/Orders";
import OrderNew from "./pages/OrderNew";
import OrderDetail from "./pages/OrderDetail";
import PartnerDashboard from "./pages/PartnerDashboard";
import PartnerCatalog from "./pages/PartnerCatalog";
import PartnerCart from "./pages/PartnerCart";
import PartnerCheckout from "./pages/PartnerCheckout";
import PartnerOrders from "./pages/PartnerOrders";
import PartnerOrderDetail from "./pages/PartnerOrderDetail";
import PartnerOrderEdit from "./pages/PartnerOrderEdit";
import PartnerProductDetail from "./pages/PartnerProductDetail";

/**
 * M6.1: Redirect root "/" basato sul ruolo utente.
 * retailer_admin / retailer_user → /partner-portal/dashboard
 * admin / operator / viewer → Home (dashboard admin)
 */
function RootRedirect() {
  const { user, loading } = useAuth();

  if (loading) return null;

  if (
    user &&
    (user.role === "retailer_admin" || user.role === "retailer_user")
  ) {
    return <Redirect to="/partner-portal/dashboard" />;
  }

  return <Home />;
}

/**
 * M6.1: Guard per le route /partner-portal/*.
 * Se l'utente non è retailer, redirect a /.
 */
function PartnerGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });

  if (loading || !user) return null;

  if (user.role !== "retailer_admin" && user.role !== "retailer_user") {
    return <Redirect to="/" />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/auth/callback" component={AuthCallback} />

      {/* M6.2.B: Partner Portal routes */}
      <Route path="/partner-portal/dashboard">
        <PartnerGuard>
          <PartnerDashboard />
        </PartnerGuard>
      </Route>
      <Route path="/partner-portal/catalog">
        <PartnerGuard>
          <PartnerCatalog />
        </PartnerGuard>
      </Route>
      <Route path="/partner-portal/catalog/:id">
        <PartnerGuard>
          <PartnerProductDetail />
        </PartnerGuard>
      </Route>
      <Route path="/partner-portal/cart">
        <PartnerGuard>
          <PartnerCart />
        </PartnerGuard>
      </Route>
      <Route path="/partner-portal/checkout">
        <PartnerGuard>
          <PartnerCheckout />
        </PartnerGuard>
      </Route>
      <Route path="/partner-portal/orders">
        <PartnerGuard>
          <PartnerOrders />
        </PartnerGuard>
      </Route>
      <Route path="/partner-portal/orders/:id/edit">
        <PartnerGuard>
          <PartnerOrderEdit />
        </PartnerGuard>
      </Route>
      <Route path="/partner-portal/orders/:id">
        <PartnerGuard>
          <PartnerOrderDetail />
        </PartnerGuard>
      </Route>

      {/* Admin/Operator routes */}
      <Route path="/" component={RootRedirect} />
      <Route path="/producers" component={Producers} />
      <Route path="/producers/:id" component={ProducerDetail} />
      <Route path="/products" component={Products} />
      <Route path="/products/:id" component={ProductDetail} />
      <Route path="/warehouse" component={Warehouse} />
      <Route path="/movements" component={Movements} />
      <Route path="/ddt-imports" component={DdtImports} />
      <Route path="/ddt-imports/:id" component={DdtImportDetail} />
      <Route path="/retailers" component={Retailers} />
      <Route path="/retailers/:id" component={RetailerDetail} />
      <Route path="/orders" component={Orders} />
      <Route path="/orders/new" component={OrderNew} />
      <Route path="/orders/:id" component={OrderDetail} />
      <Route path="/alerts" component={Alerts} />
      <Route path="/reports" component={Reports} />
      <Route path="/settings/team" component={Team} />
      <Route path="/settings/packages" component={Packages} />
      <Route path="/settings/integrations" component={Integrations} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <CartProvider>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </CartProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
