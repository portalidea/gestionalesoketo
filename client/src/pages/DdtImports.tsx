import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { callDdtExtract } from "@/lib/ddt-extract";
import { format } from "date-fns";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Plus,
  Upload,
  XCircle,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }
> = {
  uploaded: { label: "Caricato", variant: "secondary", icon: Upload },
  extracting: { label: "In estrazione...", variant: "outline", icon: Clock },
  review: { label: "Da revisionare", variant: "default", icon: AlertCircle },
  confirmed: { label: "Confermato", variant: "secondary", icon: CheckCircle2 },
  failed: { label: "Errore", variant: "destructive", icon: XCircle },
};

export default function DdtImports() {
  const [, setLocation] = useLocation();
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);

  const { data, isLoading, refetch } = trpc.ddtImports.list.useQuery({
    status: statusFilter as any,
    limit: 50,
    offset: 0,
  });

  const { data: producersData } = trpc.producers.list.useQuery();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">DDT Import</h1>
            <p className="text-muted-foreground">
              Carica i DDT dei produttori per importare automaticamente lotti e scadenze
            </p>
          </div>
          <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Carica DDT
              </Button>
            </DialogTrigger>
            <UploadDialog
              producers={producersData ?? []}
              onSuccess={(ddtImportId) => {
                setUploadDialogOpen(false);
                refetch();
                setLocation(`/ddt-imports/${ddtImportId}`);
              }}
              onError={() => {
                refetch();
              }}
            />
          </Dialog>
        </div>

        {/* Filtri */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-4">
              <div className="w-48">
                <Select
                  value={statusFilter ?? "all"}
                  onValueChange={(v) => setStatusFilter(v === "all" ? undefined : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Filtra per stato" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tutti gli stati</SelectItem>
                    <SelectItem value="review">Da revisionare</SelectItem>
                    <SelectItem value="confirmed">Confermati</SelectItem>
                    <SelectItem value="failed">Errore</SelectItem>
                    <SelectItem value="extracting">In estrazione</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="text-sm text-muted-foreground">
                {data?.total ?? 0} DDT totali
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabella */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !data?.items.length ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FileText className="h-12 w-12 mb-3 opacity-50" />
                <p className="font-medium">Nessun DDT importato</p>
                <p className="text-sm">Carica il primo DDT per iniziare</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>DDT</TableHead>
                    <TableHead>Produttore</TableHead>
                    <TableHead>Data DDT</TableHead>
                    <TableHead>Righe</TableHead>
                    <TableHead>Stato</TableHead>
                    <TableHead>Caricato il</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => {
                    const statusCfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.uploaded;
                    const StatusIcon = statusCfg.icon;
                    return (
                      <TableRow
                        key={item.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setLocation(`/ddt-imports/${item.id}`)}
                      >
                        <TableCell className="font-medium">
                          {item.ddtNumber ?? item.pdfFileName}
                        </TableCell>
                        <TableCell>{item.producerName ?? "—"}</TableCell>
                        <TableCell>
                          {item.ddtDate ?? "—"}
                        </TableCell>
                        <TableCell>{item.itemCount}</TableCell>
                        <TableCell>
                          <Badge variant={statusCfg.variant} className="gap-1">
                            <StatusIcon className="h-3 w-3" />
                            {statusCfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {item.createdAt
                            ? format(new Date(item.createdAt), "dd/MM/yyyy HH:mm")
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

// ─── Upload Dialog (M5.4 — Flusso in 2 step) ────────────────────────────────
//
// Step 1: Upload PDF → Serverless (salva su Storage, crea record)
// Step 2: Estrazione AI → Edge Function /api/ddt-extract (30s timeout)
// Step 3: Conferma estrazione → Serverless (salva dati + crea items)

type UploadStep = "idle" | "uploading" | "extracting" | "saving" | "done" | "error";

const STEP_LABELS: Record<UploadStep, string> = {
  idle: "",
  uploading: "Caricamento PDF...",
  extracting: "Estrazione AI in corso (max 30s)...",
  saving: "Salvataggio dati estratti...",
  done: "Completato!",
  error: "Errore",
};

function UploadDialog({
  producers,
  onSuccess,
  onError,
}: {
  producers: { id: string; name: string }[];
  onSuccess: (ddtImportId: string) => void;
  onError: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [producerId, setProducerId] = useState<string>("");
  const [step, setStep] = useState<UploadStep>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const uploadMutation = trpc.ddtImports.upload.useMutation();
  const markExtractingMutation = trpc.ddtImports.markExtracting.useMutation();
  const confirmExtractionMutation = trpc.ddtImports.confirmExtraction.useMutation();
  const markFailedMutation = trpc.ddtImports.markFailed.useMutation();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      if (selected.type !== "application/pdf") {
        toast.error("Solo file PDF sono supportati");
        return;
      }
      if (selected.size > 10 * 1024 * 1024) {
        toast.error("Il file supera il limite di 10MB");
        return;
      }
      setFile(selected);
      setStep("idle");
      setErrorMessage("");
    }
  };

  const handleUpload = useCallback(async () => {
    if (!file) return;

    setStep("uploading");
    setErrorMessage("");

    try {
      // ─── Step 1: Upload PDF su Storage (Serverless, veloce) ──────────
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = (reader.result as string).split(",")[1];
          resolve(result);
        };
        reader.onerror = () => reject(new Error("Errore lettura file"));
        reader.readAsDataURL(file);
      });

      const uploadResult = await uploadMutation.mutateAsync({
        fileBase64: base64,
        fileName: file.name,
        fileSize: file.size,
        producerId: producerId || undefined,
      });

      const { id: ddtImportId, storagePath } = uploadResult;

      // ─── Step 2: Estrazione AI via Edge Function (max 30s) ───────────
      setStep("extracting");

      // Segna come 'extracting' in DB per aggiornare lo stato in UI
      await markExtractingMutation.mutateAsync({ id: ddtImportId });

      let extractedData;
      try {
        extractedData = await callDdtExtract(storagePath, ddtImportId);
      } catch (extractErr) {
        // Segna come 'failed' in DB
        const errMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
        await markFailedMutation.mutateAsync({
          id: ddtImportId,
          errorMessage: errMsg,
        });
        throw extractErr;
      }

      // ─── Step 3: Conferma estrazione (Serverless, salva in DB) ───────
      setStep("saving");

      const confirmResult = await confirmExtractionMutation.mutateAsync({
        ddtImportId,
        extractedData,
      });

      // ─── Successo ────────────────────────────────────────────────────
      setStep("done");
      toast.success(
        `DDT caricato con successo. ${confirmResult.itemCount} righe estratte.`
      );
      onSuccess(ddtImportId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setStep("error");
      setErrorMessage(errMsg);
      toast.error(`Errore: ${errMsg}`);
      onError();
    }
  }, [
    file,
    producerId,
    uploadMutation,
    markExtractingMutation,
    confirmExtractionMutation,
    markFailedMutation,
    onSuccess,
    onError,
  ]);

  const isProcessing = step === "uploading" || step === "extracting" || step === "saving";

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Carica DDT (PDF)</DialogTitle>
        <DialogDescription>
          Carica il PDF del Documento di Trasporto. L'AI estrarrà automaticamente
          prodotti, lotti, scadenze e quantità.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        {/* File input */}
        <div className="space-y-2">
          <Label>File PDF</Label>
          <div
            className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => !isProcessing && fileInputRef.current?.click()}
          >
            {file ? (
              <div className="flex items-center justify-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <span className="font-medium">{file.name}</span>
                <span className="text-sm text-muted-foreground">
                  ({(file.size / 1024).toFixed(0)} KB)
                </span>
              </div>
            ) : (
              <div className="space-y-1">
                <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Clicca per selezionare o trascina qui il PDF
                </p>
                <p className="text-xs text-muted-foreground">Max 10MB</p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
            disabled={isProcessing}
          />
        </div>

        {/* Producer select */}
        <div className="space-y-2">
          <Label>Produttore (opzionale)</Label>
          <Select
            value={producerId}
            onValueChange={setProducerId}
            disabled={isProcessing}
          >
            <SelectTrigger>
              <SelectValue placeholder="Seleziona produttore" />
            </SelectTrigger>
            <SelectContent>
              {producers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Progress indicator */}
        {isProcessing && (
          <div className="rounded-lg bg-muted/50 p-4 space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">{STEP_LABELS[step]}</p>
                {step === "extracting" && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Claude Vision sta analizzando il PDF. Questo può richiedere fino a 30 secondi.
                  </p>
                )}
              </div>
            </div>
            {/* Step indicators */}
            <div className="flex gap-2">
              <StepDot active={step === "uploading"} done={["extracting", "saving", "done"].includes(step)} label="Upload" />
              <StepDot active={step === "extracting"} done={["saving", "done"].includes(step)} label="AI" />
              <StepDot active={step === "saving"} done={["done"].includes(step)} label="Salva" />
            </div>
          </div>
        )}

        {/* Error message */}
        {step === "error" && errorMessage && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
            <div className="flex items-start gap-2">
              <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-sm text-destructive">{errorMessage}</p>
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button
          onClick={handleUpload}
          disabled={!file || isProcessing}
          className="w-full"
        >
          {isProcessing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {STEP_LABELS[step]}
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Carica e analizza
            </>
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ─── Step Dot Component ──────────────────────────────────────────────────────

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`h-2 w-2 rounded-full transition-colors ${
          done
            ? "bg-green-500"
            : active
              ? "bg-primary animate-pulse"
              : "bg-muted-foreground/30"
        }`}
      />
      <span
        className={`text-xs ${
          active ? "text-foreground font-medium" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
