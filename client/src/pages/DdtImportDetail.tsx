import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Download,
  FileText,
  Link2,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

export default function DdtImportDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const { data: ddtImport, isLoading } = trpc.ddtImports.getById.useQuery(
    { id: id! },
    { enabled: !!id }
  );

  const { data: producersData } = trpc.producers.list.useQuery();
  const { data: productsData } = trpc.products.list.useQuery();

  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [selectedProducerId, setSelectedProducerId] = useState<string>("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  const confirmMutation = trpc.ddtImports.confirm.useMutation({
    onSuccess: (data) => {
      toast.success(
        `DDT confermato: ${data.itemsProcessed} righe processate, ${data.batchesCreated} lotti creati, ${data.batchesMerged} lotti aggiornati`
      );
      setConfirmDialogOpen(false);
      utils.ddtImports.getById.invalidate({ id: id! });
    },
    onError: (err) => {
      toast.error(`Errore conferma: ${err.message}`);
    },
  });

  const retryMutation = trpc.ddtImports.retryExtraction.useMutation({
    onSuccess: () => {
      toast.success("Rielaborazione avviata");
      utils.ddtImports.getById.invalidate({ id: id! });
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
    },
  });

  const updateItemMutation = trpc.ddtImports.updateItem.useMutation({
    onSuccess: () => {
      toast.success("Riga aggiornata");
      utils.ddtImports.getById.invalidate({ id: id! });
      setEditingItemId(null);
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
    },
  });

  const removeItemMutation = trpc.ddtImports.removeItem.useMutation({
    onSuccess: () => {
      toast.success("Riga rimossa");
      utils.ddtImports.getById.invalidate({ id: id! });
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
    },
  });

  const deleteMutation = trpc.ddtImports.delete.useMutation({
    onSuccess: () => {
      toast.success("DDT eliminato");
      setLocation("/ddt-imports");
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
    },
  });

  // --- Dialog creazione prodotto inline ---
  const [createProductOpen, setCreateProductOpen] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [newProductPrice, setNewProductPrice] = useState("");
  const [newProductIva, setNewProductIva] = useState("10");
  const [createForItemId, setCreateForItemId] = useState<string | null>(null);

  const createProductMutation = trpc.products.create.useMutation({
    onSuccess: (newProduct) => {
      toast.success(`Prodotto "${newProductName}" creato`);
      // Auto-match l'item con il nuovo prodotto
      if (createForItemId && newProduct?.id) {
        updateItemMutation.mutate({
          itemId: createForItemId,
          productMatchedId: newProduct.id,
        });
      }
      setCreateProductOpen(false);
      setNewProductName("");
      setNewProductPrice("");
      setNewProductIva("10");
      setCreateForItemId(null);
      utils.products.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Errore creazione prodotto: ${err.message}`);
    },
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  if (!ddtImport) {
    return (
      <DashboardLayout>
        <div className="text-center py-20">
          <p className="text-muted-foreground">DDT non trovato</p>
          <Button variant="outline" onClick={() => setLocation("/ddt-imports")} className="mt-4">
            Torna alla lista
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  const unmatchedCount = ddtImport.items.filter((i) => !i.productMatchedId).length;
  const missingBatchCount = ddtImport.items.filter((i) => !i.batchNumber).length;
  const missingExpiryCount = ddtImport.items.filter((i) => !i.expirationDate).length;
  const canConfirm = ddtImport.status === "review" && unmatchedCount === 0 && missingBatchCount === 0 && missingExpiryCount === 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLocation("/ddt-imports")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                DDT {ddtImport.ddtNumber ?? ddtImport.pdfFileName}
              </h1>
              <p className="text-muted-foreground">
                {ddtImport.producerName ?? "Produttore non assegnato"}
                {ddtImport.ddtDate && ` • ${ddtImport.ddtDate}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {ddtImport.status === "failed" && (
              <Button
                variant="outline"
                onClick={() => retryMutation.mutate({ id: id! })}
                disabled={retryMutation.isPending}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Riprova
              </Button>
            )}
            {ddtImport.status === "review" && (
              <Button
                onClick={() => {
                  setSelectedProducerId(ddtImport.producerId ?? "");
                  setConfirmDialogOpen(true);
                }}
                disabled={!canConfirm}
              >
                <Check className="mr-2 h-4 w-4" />
                Conferma DDT
              </Button>
            )}
            <Button
              variant="destructive"
              size="icon"
              onClick={() => {
                if (confirm("Eliminare questo DDT? L'azione è irreversibile.")) {
                  deleteMutation.mutate({ id: id! });
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Status banner */}
        {ddtImport.status === "failed" && ddtImport.errorMessage && (
          <Card className="border-destructive">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-destructive">Estrazione fallita</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {ddtImport.errorMessage}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {(unmatchedCount > 0 || missingBatchCount > 0 || missingExpiryCount > 0) && ddtImport.status === "review" && (
          <Card className="border-yellow-500/50">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  {unmatchedCount > 0 && (
                    <p className="font-medium text-yellow-600">
                      {unmatchedCount} {unmatchedCount === 1 ? "riga non matchata" : "righe non matchate"}
                      {" — "}assegna manualmente il prodotto corretto.
                    </p>
                  )}
                  {missingBatchCount > 0 && (
                    <p className="font-medium text-yellow-600">
                      {missingBatchCount} {missingBatchCount === 1 ? "riga senza lotto" : "righe senza lotto"}
                      {" — "}inserisci il numero di lotto manualmente.
                    </p>
                  )}
                  {missingExpiryCount > 0 && (
                    <p className="font-medium text-yellow-600">
                      {missingExpiryCount} {missingExpiryCount === 1 ? "riga senza scadenza" : "righe senza scadenza"}
                      {" — "}inserisci la data di scadenza manualmente.
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    Compila tutti i campi mancanti prima di confermare il DDT.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Info card */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">File</p>
              <p className="font-medium truncate">{ddtImport.pdfFileName}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">Righe estratte</p>
              <p className="font-medium">{ddtImport.items.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">Stato</p>
              <Badge
                variant={
                  ddtImport.status === "confirmed"
                    ? "secondary"
                    : ddtImport.status === "failed"
                    ? "destructive"
                    : "default"
                }
              >
                {ddtImport.status}
              </Badge>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">Caricato il</p>
              <p className="font-medium">
                {ddtImport.createdAt
                  ? format(new Date(ddtImport.createdAt), "dd/MM/yyyy HH:mm")
                  : "—"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Items table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Righe estratte</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prodotto (estratto)</TableHead>
                  <TableHead>Prodotto (match)</TableHead>
                  <TableHead>Lotto</TableHead>
                  <TableHead>Scadenza</TableHead>
                  <TableHead>Qtà</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="w-[100px]">Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ddtImport.items.map((item) => (
                  <DdtItemRow
                    key={item.id}
                    item={item}
                    products={productsData ?? []}
                    isEditing={editingItemId === item.id}
                    onEdit={() => setEditingItemId(item.id)}
                    onCancelEdit={() => setEditingItemId(null)}
                    onSave={(data) =>
                      updateItemMutation.mutate({ itemId: item.id, ...data })
                    }
                    onRemove={() => removeItemMutation.mutate({ itemId: item.id })}
                    isReview={ddtImport.status === "review"}
                    onCreateProduct={(itemId, extractedName) => {
                      setCreateForItemId(itemId);
                      setNewProductName(extractedName);
                      setCreateProductOpen(true);
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Create product dialog */}
        <Dialog open={createProductOpen} onOpenChange={setCreateProductOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Crea nuovo prodotto</DialogTitle>
              <DialogDescription>
                Il prodotto estratto dal DDT non corrisponde a nessun prodotto in anagrafica.
                Creane uno nuovo per completare il match.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Nome prodotto</Label>
                <Input
                  value={newProductName}
                  onChange={(e) => setNewProductName(e.target.value)}
                  placeholder="es. Brioche Proteica al Cacao"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Prezzo unitario (€)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newProductPrice}
                    onChange={(e) => setNewProductPrice(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-2">
                  <Label>IVA %</Label>
                  <Select value={newProductIva} onValueChange={setNewProductIva}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="4">4%</SelectItem>
                      <SelectItem value="10">10%</SelectItem>
                      <SelectItem value="22">22%</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateProductOpen(false)}>
                Annulla
              </Button>
              <Button
                onClick={() => {
                  createProductMutation.mutate({
                    name: newProductName,
                    unitPrice: parseFloat(newProductPrice) || 0,
                    vatRate: parseInt(newProductIva),
                  } as any);
                }}
                disabled={!newProductName.trim() || createProductMutation.isPending}
              >
                {createProductMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                Crea e associa
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Confirm dialog */}
        <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Conferma DDT</DialogTitle>
              <DialogDescription>
                Confermando, verranno creati i lotti nel magazzino centrale e registrati
                i movimenti RECEIPT_FROM_PRODUCER. L'operazione non è reversibile.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Produttore</Label>
                <Select
                  value={selectedProducerId}
                  onValueChange={setSelectedProducerId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Seleziona produttore" />
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
              <div className="text-sm text-muted-foreground">
                {ddtImport.items.length} righe verranno processate.
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDialogOpen(false)}>
                Annulla
              </Button>
              <Button
                onClick={() =>
                  confirmMutation.mutate({
                    id: id!,
                    producerId: selectedProducerId,
                  })
                }
                disabled={!selectedProducerId || confirmMutation.isPending}
              >
                {confirmMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                Conferma e importa
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}

// ─── Item Row Component ──────────────────────────────────────────────────────

function DdtItemRow({
  item,
  products,
  isEditing,
  onEdit,
  onCancelEdit,
  onSave,
  onRemove,
  isReview,
  onCreateProduct,
}: {
  item: {
    id: string;
    productNameExtracted: string;
    productCodeExtracted: string | null;
    productMatchedId: string | null;
    productMatchedName: string | null;
    batchNumber: string | null;
    expirationDate: string | null;
    quantityPieces: number;
    status: string;
  };
  products: { id: string; name: string }[];
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (data: {
    productMatchedId?: string;
    batchNumber?: string;
    expirationDate?: string;
    quantityPieces?: number;
  }) => void;
  onRemove: () => void;
  isReview: boolean;
  onCreateProduct?: (itemId: string, extractedName: string) => void;
}) {
  const [editProductId, setEditProductId] = useState(item.productMatchedId ?? "");
  const [editBatch, setEditBatch] = useState(item.batchNumber ?? "");
  const [editExpiry, setEditExpiry] = useState(item.expirationDate ?? "");
  const [editQty, setEditQty] = useState(item.quantityPieces);

  const statusBadge = () => {
    switch (item.status) {
      case "matched":
        return <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />Match</Badge>;
      case "unmatched":
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />No match</Badge>;
      case "confirmed":
        return <Badge variant="secondary" className="gap-1"><Check className="h-3 w-3" />Confermato</Badge>;
      case "merged":
        return <Badge variant="outline" className="gap-1"><Link2 className="h-3 w-3" />Merged</Badge>;
      default:
        return <Badge variant="outline">{item.status}</Badge>;
    }
  };

  if (isEditing) {
    return (
      <TableRow className="bg-muted/30">
        <TableCell className="text-sm text-muted-foreground">
          {item.productNameExtracted}
        </TableCell>
        <TableCell>
          <Select value={editProductId} onValueChange={setEditProductId}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Seleziona..." />
            </SelectTrigger>
            <SelectContent>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
        <TableCell>
          <Input
            value={editBatch}
            onChange={(e) => setEditBatch(e.target.value)}
            className="h-8 text-sm w-24"
          />
        </TableCell>
        <TableCell>
          <Input
            type="date"
            value={editExpiry}
            onChange={(e) => setEditExpiry(e.target.value)}
            className="h-8 text-sm w-32"
          />
        </TableCell>
        <TableCell>
          <Input
            type="number"
            value={editQty}
            onChange={(e) => setEditQty(parseInt(e.target.value) || 0)}
            className="h-8 text-sm w-16"
          />
        </TableCell>
        <TableCell>{statusBadge()}</TableCell>
        <TableCell>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => {
                onSave({
                  productMatchedId: editProductId || undefined,
                  batchNumber: editBatch,
                  expirationDate: editExpiry || undefined,
                  quantityPieces: editQty,
                });
              }}
            >
              <Check className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={onCancelEdit}
            >
              <XCircle className="h-3 w-3" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell>
        <div>
          <span className="font-medium">{item.productNameExtracted}</span>
          {item.productCodeExtracted && (
            <span className="text-xs text-muted-foreground ml-2">
              [{item.productCodeExtracted}]
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        {item.productMatchedName ? (
          <span className="text-sm">{item.productMatchedName}</span>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-destructive italic">Non assegnato</span>
            {isReview && onCreateProduct && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => onCreateProduct(item.id, item.productNameExtracted)}
              >
                <Plus className="h-3 w-3 mr-1" />
                Crea
              </Button>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="font-mono text-sm">
        {item.batchNumber ? (
          item.batchNumber
        ) : (
          <span className="text-yellow-600 italic text-xs flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            Mancante
          </span>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {item.expirationDate ? (
          item.expirationDate
        ) : (
          <span className="text-yellow-600 italic text-xs flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            Mancante
          </span>
        )}
      </TableCell>
      <TableCell className="font-medium">{item.quantityPieces}</TableCell>
      <TableCell>{statusBadge()}</TableCell>
      <TableCell>
        {isReview && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={onEdit}
            >
              <FileText className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive hover:text-destructive"
              onClick={() => {
                if (confirm("Rimuovere questa riga?")) onRemove();
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
