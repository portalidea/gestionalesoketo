import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { CartProvider } from "./contexts/CartContext";
import RequireRole from "./components/auth/RequireRole";
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

const ADMIN_ROLES = ["admin", "operator", "viewer"];
const RETAILER_ROLES = ["retailer_admin", "retailer_user"];

/**
 * M6.1.1: Redirect root "/" basato sul ruolo utente.
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

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/auth/callback" component={AuthCallback} />

      {/* ═══════════════════════════════════════════════════════════
          Partner Portal routes — only retailer_admin / retailer_user
         ═══════════════════════════════════════════════════════════ */}
      <Route path="/partner-portal/dashboard">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerDashboard />
        </RequireRole>
      </Route>
      <Route path="/partner-portal/catalog">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerCatalog />
        </RequireRole>
      </Route>
      <Route path="/partner-portal/catalog/:id">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerProductDetail />
        </RequireRole>
      </Route>
      <Route path="/partner-portal/cart">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerCart />
        </RequireRole>
      </Route>
      <Route path="/partner-portal/checkout">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerCheckout />
        </RequireRole>
      </Route>
      <Route path="/partner-portal/orders">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerOrders />
        </RequireRole>
      </Route>
      <Route path="/partner-portal/orders/:id/edit">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerOrderEdit />
        </RequireRole>
      </Route>
      <Route path="/partner-portal/orders/:id">
        <RequireRole allowedRoles={RETAILER_ROLES}>
          <PartnerOrderDetail />
        </RequireRole>
      </Route>

      {/* ═══════════════════════════════════════════════════════════
          Admin/Operator routes — only admin / operator / viewer
         ═══════════════════════════════════════════════════════════ */}
      <Route path="/" component={RootRedirect} />
      <Route path="/producers">
        <RequireRole allowedRoles={ADMIN_ROLES}><Producers /></RequireRole>
      </Route>
      <Route path="/producers/:id">
        <RequireRole allowedRoles={ADMIN_ROLES}><ProducerDetail /></RequireRole>
      </Route>
      <Route path="/products">
        <RequireRole allowedRoles={ADMIN_ROLES}><Products /></RequireRole>
      </Route>
      <Route path="/products/:id">
        <RequireRole allowedRoles={ADMIN_ROLES}><ProductDetail /></RequireRole>
      </Route>
      <Route path="/warehouse">
        <RequireRole allowedRoles={ADMIN_ROLES}><Warehouse /></RequireRole>
      </Route>
      <Route path="/movements">
        <RequireRole allowedRoles={ADMIN_ROLES}><Movements /></RequireRole>
      </Route>
      <Route path="/ddt-imports">
        <RequireRole allowedRoles={ADMIN_ROLES}><DdtImports /></RequireRole>
      </Route>
      <Route path="/ddt-imports/:id">
        <RequireRole allowedRoles={ADMIN_ROLES}><DdtImportDetail /></RequireRole>
      </Route>
      <Route path="/retailers">
        <RequireRole allowedRoles={ADMIN_ROLES}><Retailers /></RequireRole>
      </Route>
      <Route path="/retailers/:id">
        <RequireRole allowedRoles={ADMIN_ROLES}><RetailerDetail /></RequireRole>
      </Route>
      <Route path="/orders">
        <RequireRole allowedRoles={ADMIN_ROLES}><Orders /></RequireRole>
      </Route>
      <Route path="/orders/new">
        <RequireRole allowedRoles={ADMIN_ROLES}><OrderNew /></RequireRole>
      </Route>
      <Route path="/orders/:id">
        <RequireRole allowedRoles={ADMIN_ROLES}><OrderDetail /></RequireRole>
      </Route>
      <Route path="/alerts">
        <RequireRole allowedRoles={ADMIN_ROLES}><Alerts /></RequireRole>
      </Route>
      <Route path="/reports">
        <RequireRole allowedRoles={ADMIN_ROLES}><Reports /></RequireRole>
      </Route>
      <Route path="/settings/team">
        <RequireRole allowedRoles={["admin"]}><Team /></RequireRole>
      </Route>
      <Route path="/settings/packages">
        <RequireRole allowedRoles={["admin"]}><Packages /></RequireRole>
      </Route>
      <Route path="/settings/integrations">
        <RequireRole allowedRoles={["admin"]}><Integrations /></RequireRole>
      </Route>
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
