/**
 * M6.1.1 — RequireRole
 * Route guard: controlla che user.role sia tra quelli consentiti.
 * Se non autorizzato: retailer_* → /partner-portal/dashboard, altri → /login.
 */
import { useAuth } from "@/_core/hooks/useAuth";
import { Redirect } from "wouter";
import { Loader2 } from "lucide-react";

interface RequireRoleProps {
  allowedRoles: string[];
  children: React.ReactNode;
}

export default function RequireRole({ allowedRoles, children }: RequireRoleProps) {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  if (!allowedRoles.includes(user.role)) {
    // Retailer che tenta di accedere a route admin → redirect al portale partner
    if (user.role === "retailer_admin" || user.role === "retailer_user") {
      return <Redirect to="/partner-portal/dashboard" />;
    }
    // Admin/operator che tenta di accedere a route partner → redirect a dashboard admin
    return <Redirect to="/" />;
  }

  return <>{children}</>;
}
