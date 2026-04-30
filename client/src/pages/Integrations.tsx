import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Plug, Construction } from "lucide-react";

export default function Integrations() {
  const { user: me } = useAuth({ redirectOnUnauthenticated: true });

  if (me && me.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <p className="text-muted-foreground">
            Accesso riservato agli amministratori.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">
            Integrazioni
          </h1>
          <p className="text-muted-foreground">
            Gestione delle connessioni a servizi esterni.
          </p>
        </div>

        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Plug className="h-6 w-6 text-primary" />
              <div>
                <CardTitle>Fatture in Cloud</CardTitle>
                <CardDescription>
                  Connessione globale singola all'account fiscale SoKeto.
                  I 13 retailer sono mappati come clienti nell'anagrafica
                  FiC; proforma e fatture si emettono dall'unico account.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <Construction className="h-5 w-5 shrink-0" />
              <span>
                In arrivo. La gestione OAuth e il mapping retailer ↔ cliente
                FiC saranno disponibili dopo il cutover di migrazione.
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
