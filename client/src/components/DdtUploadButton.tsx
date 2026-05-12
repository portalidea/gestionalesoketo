/**
 * Componente bottone riutilizzabile per upload DDT.
 * Usato su /producers/:id e /warehouse come punto di ingresso alternativo.
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
import { FileUp, Loader2 } from "lucide-react";
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

export default function DdtUploadButton({
  producerId,
  variant = "outline",
  label = "+ Carico da DDT",
  className,
}: DdtUploadButtonProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [selectedProducerId, setSelectedProducerId] = useState(producerId ?? "");
  const [isUploading, setIsUploading] = useState(false);
  const [, setLocation] = useLocation();

  const { data: producersData } = trpc.producers.list.useQuery();
  const uploadMutation = trpc.ddtImports.upload.useMutation({
    onSuccess: (data) => {
      toast.success(`DDT caricato — ${data.itemCount} righe estratte`);
      setOpen(false);
      setFile(null);
      setIsUploading(false);
      setLocation(`/ddt-imports/${data.id}`);
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
      setIsUploading(false);
    },
  });

  const handleUpload = async () => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Il file supera il limite di 10MB");
      return;
    }

    setIsUploading(true);
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        ""
      )
    );

    uploadMutation.mutate({
      fileBase64: base64,
      fileName: file.name,
      fileSize: file.size,
      producerId: selectedProducerId || undefined,
    });
  };

  return (
    <>
      <Button variant={variant} className={className} onClick={() => setOpen(true)}>
        <FileUp className="mr-2 h-4 w-4" />
        {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
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
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
                <Select value={selectedProducerId} onValueChange={setSelectedProducerId}>
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annulla
            </Button>
            <Button onClick={handleUpload} disabled={!file || isUploading}>
              {isUploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Analisi in corso...
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
