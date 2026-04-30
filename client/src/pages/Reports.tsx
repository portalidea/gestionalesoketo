import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";

export default function Reports() {
  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-2">Reportistica</h1>
          <p className="text-muted-foreground">
            Analisi vendite e trend per prodotto e rivenditore
          </p>
        </div>

        {/* Coming Soon */}
        <Card className="border-border bg-card">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <BarChart3 className="h-20 w-20 text-muted-foreground mb-6" />
            <h3 className="text-2xl font-semibold text-foreground mb-3">
              Reportistica in Arrivo
            </h3>
            <p className="text-muted-foreground text-center max-w-lg mb-6">
              Questa sezione includerà report dettagliati su vendite per prodotto e rivenditore,
              analisi dei trend, suggerimenti per il riordino e grafici interattivi per
              visualizzare le performance nel tempo.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl">
              <Card className="border-border bg-accent/50">
                <CardHeader>
                  <CardTitle className="text-lg">Vendite per Prodotto</CardTitle>
                  <CardDescription>
                    Analisi dettagliata delle vendite di ogni prodotto SoKeto
                  </CardDescription>
                </CardHeader>
              </Card>
              <Card className="border-border bg-accent/50">
                <CardHeader>
                  <CardTitle className="text-lg">Performance Rivenditori</CardTitle>
                  <CardDescription>
                    Confronto vendite tra i diversi punti vendita
                  </CardDescription>
                </CardHeader>
              </Card>
              <Card className="border-border bg-accent/50">
                <CardHeader>
                  <CardTitle className="text-lg">Trend Temporali</CardTitle>
                  <CardDescription>
                    Evoluzione delle vendite nel tempo con grafici interattivi
                  </CardDescription>
                </CardHeader>
              </Card>
              <Card className="border-border bg-accent/50">
                <CardHeader>
                  <CardTitle className="text-lg">Suggerimenti Riordino</CardTitle>
                  <CardDescription>
                    Raccomandazioni intelligenti basate sui dati storici
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
