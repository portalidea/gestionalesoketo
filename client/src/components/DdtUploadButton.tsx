/**
 * Componente bottone riutilizzabile per upload DDT.
 * Usato su /producers/:id e /warehouse come punto di ingresso alternativo.
 *
 * M5.4 refactor: flusso in 2 step (upload → Edge extract → confirmExtraction).
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { callDdtExtract } from "@/lib/ddt-extract";
import { FileUp, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

interface DdtUploadButtonProps {
  /** Se fornito, pre-popola il produttore */
  producerId?: string;
  /** Variante del bottone */
  variant?: "default" | "outline" | "secondary";
  /** Testo del bottone */
  label?: string;
  /** Classe CSS aggiuntiva */
  className?: string;
}

type UploadStep = "idle" | "uploading" | "extracting" | "saving" | "error";

const STEP_LABELS: Record<UploadStep, string> = {
  idle: "",
  uploading: "Caricamento PDF...",
  extracting: "Estrazione AI in corso (max 30s)...",
  saving: "Salvataggio dati estratti...",
  error: "Errore",
};

export default function DdtUploadButton({
  producerId,
  variant = "outline",
  label = "+ Carico da DDT",
  className,
}: DdtUploadButtonProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [selectedProducerId, setSelectedProducerId] = useState(producerId ?? "");
  const [step, setStep] = useState<UploadStep>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [, setLocation] = useLocation();

  const { data: producersData } = trpc.producers.list.useQuery();
  const uploadMutation = trpc.ddtImports.upload.useMutation();
  const markExtractingMutation = trpc.ddtImports.markExtracting.useMutation();
  const confirmExtractionMutation = trpc.ddtImports.confirmExtraction.useMutation();
  const markFailedMutation = trpc.ddtImports.markFailed.useMutation();

  const isProcessing = step === "uploading" || step === "extracting" || step === "saving";

  const handleUpload = async () => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Il file supera il limite di 10MB");
      return;
    }

    setStep("uploading");
    setErrorMessage("");

    try {
      // Step 1: Upload PDF su Storage (Serverless)
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ""
        )
      );

      const uploadResult = await uploadMutation.mutateAsync({
        fileBase64: base64,
        fileName: file.name,
        fileSize: file.size,
        producerId: selectedProducerId || undefined,
      });

      const { id: ddtImportId, storagePath } = uploadResult;

      // Step 2: Estrazione AI via Edge Function (max 30s)
      setStep("extracting");
      await markExtractingMutation.mutateAsync({ id: ddtImportId });

      let extractedData;
      try {
        extractedData = await callDdtExtract(storagePath, ddtImportId);
      } catch (extractErr) {
        const errMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
        await markFailedMutation.mutateAsync({ id: ddtImportId, errorMessage: errMsg });
        throw extractErr;
      }

      // Step 3: Conferma estrazione (Serverless)
      setStep("saving");
      const confirmResult = await confirmExtractionMutation.mutateAsync({
        ddtImportId,
        extractedData,
      });

      toast.success(`DDT caricato — ${confirmResult.itemCount} righe estratte`);
      setOpen(false);
      setFile(null);
      setStep("idle");
      setLocation(`/ddt-imports/${ddtImportId}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setStep("error");
      setErrorMessage(errMsg);
      toast.error(`Errore: ${errMsg}`);
    }
  };

  return (
    <>
      <Button variant={variant} className={className} onClick={() => setOpen(true)}>
        <FileUp className="mr-2 h-4 w-4" />
        {label}
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!isProcessing) setOpen(v); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Carica DDT</DialogTitle>
            <DialogDescription>
              Carica un PDF di un Documento Di Trasporto. Il sistema estrarrà automaticamente
              i prodotti, lotti e scadenze tramite AI.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>File PDF</Label>
              <Input
                type="file"
                accept=".pdf"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setStep("idle");
                  setErrorMessage("");
                }}
                disabled={isProcessing}
              />
              {file && (
                <p className="text-xs text-muted-foreground">
                  {file.name} ({(file.size / 1024).toFixed(0)} KB)
                </p>
              )}
            </div>
            {!producerId && (
              <div className="space-y-2">
                <Label>Produttore (opzionale)</Label>
                <Select
                  value={selectedProducerId}
                  onValueChange={setSelectedProducerId}
                  disabled={isProcessing}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Seleziona produttore..." />
                  </SelectTrigger>
                  <SelectContent>
                    {(producersData ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Progress */}
            {isProcessing && (
              <div className="rounded-lg bg-muted/50 p-3 flex items-center gap-3">
                <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                <div>
                  <p className="text-sm font-medium">{STEP_LABELS[step]}</p>
                  {step === "extracting" && (
                    <p className="text-xs text-muted-foreground">
                      Claude Vision sta analizzando il PDF (fino a 30s).
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Error */}
            {step === "error" && errorMessage && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 flex items-start gap-2">
                <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm text-destructive">{errorMessage}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isProcessing}>
              Annulla
            </Button>
            <Button onClick={handleUpload} disabled={!file || isProcessing}>
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {STEP_LABELS[step]}
                </>
              ) : (
                <>
                  <FileUp className="mr-2 h-4 w-4" />
                  Carica e analizza
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
