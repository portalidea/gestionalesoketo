import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Alerts from "./pages/Alerts";
import AuthCallback from "./pages/AuthCallback";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Products from "./pages/Products";
import Reports from "./pages/Reports";
import RetailerDetail from "./pages/RetailerDetail";
import Retailers from "./pages/Retailers";
import Team from "./pages/Team";

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/auth/callback" component={AuthCallback} />
      <Route path="/" component={Home} />
      <Route path="/retailers" component={Retailers} />
      <Route path="/retailers/:id" component={RetailerDetail} />
      <Route path="/products" component={Products} />
      <Route path="/alerts" component={Alerts} />
      <Route path="/reports" component={Reports} />
      <Route path="/settings/team" component={Team} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
