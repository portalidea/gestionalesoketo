import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Download, Loader2, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function InventoryExport() {
  const today = new Date().toISOString().slice(0, 10);
  const [atDate, setAtDate] = useState(today);
  const [driftCount, setDriftCount] = useState<number | null>(null);

  const exportMutation = trpc.inventoryExport.exportSnapshot.useMutation({
    onSuccess: (data) => {
      // Download the file
      const byteCharacters = atob(data.fileBase64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setDriftCount(data.driftReport.count);
      toast.success("Export pronto", {
        description: `File ${data.filename} scaricato.`,
      });
    },
    onError: (err) => {
      toast.error("Errore generazione export", {
        description: err.message,
      });
    },
  });

  const handleExport = () => {
    if (!atDate) return;
    // Validate date not in future
    if (atDate > today) {
      toast.error("Data non valida", { description: "Non è possibile esportare per date future." });
      return;
    }
    setDriftCount(null);
    exportMutation.mutate({ atDate });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Esporta Magazzino</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Genera un export XLSX dello stato del magazzino centrale ad una data specifica.
          </p>
        </div>

        {/* Export Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Parametri export</CardTitle>
            <CardDescription>
              Seleziona la data di riferimento per lo snapshot del magazzino.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="atDate">Data di riferimento</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p>
                      Per la data odierna vengono usati i dati correnti.
                      Per date passate il magazzino viene ricostruito dallo storico
                      movimenti — verifica i risultati con cura.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <Input
                id="atDate"
                type="date"
                value={atDate}
                max={today}
                onChange={(e) => setAtDate(e.target.value)}
                className="w-[200px]"
              />
            </div>

            <Button
              onClick={handleExport}
              disabled={exportMutation.isPending || !atDate}
              className="bg-[#2D5A27] hover:bg-[#2D5A27]/90 text-white"
            >
              {exportMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generazione in corso...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Genera Export
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Drift Warning */}
        {driftCount !== null && driftCount > 0 && (
          <Alert className="border-yellow-500/50 bg-yellow-500/5">
            <AlertTriangle className="h-4 w-4 text-yellow-600" />
            <AlertTitle className="text-yellow-700 dark:text-yellow-400">
              Discrepanze rilevate
            </AlertTitle>
            <AlertDescription className="text-yellow-600 dark:text-yellow-300">
              Attenzione: {driftCount} batch hanno discrepanze tra movimenti e magazzino
              corrente. Vedi dettagli nel file (righe rosse in fondo).
            </AlertDescription>
          </Alert>
        )}

        {/* Info about past dates */}
        {atDate < today && (
          <Alert className="border-blue-500/30 bg-blue-500/5">
            <Info className="h-4 w-4 text-blue-600" />
            <AlertTitle className="text-blue-700 dark:text-blue-400">
              Ricostruzione storica
            </AlertTitle>
            <AlertDescription className="text-blue-600 dark:text-blue-300">
              Per date passate, il magazzino viene ricostruito analizzando lo storico
              dei movimenti. Il drift check non è applicabile.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </DashboardLayout>
  );
}
