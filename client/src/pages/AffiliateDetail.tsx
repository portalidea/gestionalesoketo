import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { toast } from "sonner";
import {
  ArrowLeft,
  Edit,
  Euro,
  Users,
  TrendingUp,
  CheckCircle,
} from "lucide-react";

export default function AffiliateDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [payDialog, setPayDialog] = useState<{ open: boolean; ids: string[] }>({
    open: false,
    ids: [],
  });
  const [paymentRef, setPaymentRef] = useState("");

  const { data: affiliate, isLoading } = trpc.affiliates.getById.useQuery(
    { id: params.id! },
    { enabled: !!params.id }
  );

  const { data: commissionsData } = trpc.affiliates.commissionsList.useQuery(
    { affiliateId: params.id!, status: "pending" },
    { enabled: !!params.id }
  );

  const markPaidMutation = trpc.affiliates.markPaid.useMutation({
    onSuccess: () => {
      toast.success("Commissioni segnate come pagate");
      utils.affiliates.getById.invalidate({ id: params.id! });
      utils.affiliates.commissionsList.invalidate();
      setPayDialog({ open: false, ids: [] });
      setPaymentRef("");
    },
    onError: (err) => {
      toast.error("Errore: " + err.message);
    },
  });

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Caricamento...</div>;
  }

  if (!affiliate) {
    return <div className="text-center py-8 text-muted-foreground">Affiliato non trovato</div>;
  }

  const pendingCommissions = commissionsData?.items ?? [];
  const totalPending = pendingCommissions.reduce(
    (sum: number, c: any) => sum + Number(c.commissionAmount),
    0
  );

  const handlePayAll = () => {
    const ids = pendingCommissions.map((c: any) => c.id);
    if (ids.length === 0) {
      toast.info("Nessuna commissione pendente");
      return;
    }
    setPayDialog({ open: true, ids });
  };

  const confirmPay = () => {
    markPaidMutation.mutate({
      commissionIds: payDialog.ids,
      paymentReference: paymentRef || "Pagamento manuale",
    });
  };

  return (
    <DashboardLayout>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/affiliates")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{affiliate.name}</h1>
            <p className="text-muted-foreground">
              Codice: <code className="bg-muted px-2 py-0.5 rounded">{affiliate.referralCode}</code>
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/affiliates/${params.id}/edit`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Modifica
            </Button>
          </Link>
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Badge
                variant={affiliate.status === "active" ? "default" : "secondary"}
              >
                {affiliate.status === "active" ? "Attivo" : "Inattivo"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Dal {new Date(affiliate.createdAt).toLocaleDateString("it-IT")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Commissioni</span>
            </div>
            <p className="text-lg font-bold mt-1">
              {affiliate.firstOrderRate}% / {affiliate.recurringRate}%
            </p>
            <p className="text-xs text-muted-foreground">Primo / Ricorrente</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Rivenditori</span>
            </div>
            <p className="text-2xl font-bold mt-1">{affiliate.stats?.retailersCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Euro className="h-4 w-4 text-orange-500" />
              <span className="text-sm text-muted-foreground">Pendenti</span>
            </div>
            <p className="text-2xl font-bold mt-1">€{totalPending.toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Stats */}
      {affiliate.stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">Totale Guadagnato</span>
              <p className="text-xl font-bold mt-1">€{affiliate.stats.totalEarned.toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">Totale Pagato</span>
              <p className="text-xl font-bold mt-1 text-green-600">€{affiliate.stats.totalPaid.toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">Totale Pendente</span>
              <p className="text-xl font-bold mt-1 text-orange-600">€{affiliate.stats.totalPending.toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <span className="text-sm text-muted-foreground">N. Commissioni</span>
              <p className="text-xl font-bold mt-1">{affiliate.stats.commissionsCount}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Dettagli contatto */}
      <Card>
        <CardHeader>
          <CardTitle>Dettagli</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            {affiliate.email && (
              <div>
                <span className="text-muted-foreground">Email:</span>{" "}
                <span className="font-medium">{affiliate.email}</span>
              </div>
            )}
            {affiliate.phone && (
              <div>
                <span className="text-muted-foreground">Telefono:</span>{" "}
                <span className="font-medium">{affiliate.phone}</span>
              </div>
            )}
            {affiliate.taxCode && (
              <div>
                <span className="text-muted-foreground">Codice Fiscale:</span>{" "}
                <span className="font-medium">{affiliate.taxCode}</span>
              </div>
            )}
            {affiliate.vatNumber && (
              <div>
                <span className="text-muted-foreground">P.IVA:</span>{" "}
                <span className="font-medium">{affiliate.vatNumber}</span>
              </div>
            )}
            {affiliate.iban && (
              <div>
                <span className="text-muted-foreground">IBAN:</span>{" "}
                <span className="font-mono text-xs">{affiliate.iban}</span>
              </div>
            )}
            {affiliate.notes && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Note:</span>{" "}
                <span>{affiliate.notes}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Commissioni Pendenti */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Commissioni Pendenti</CardTitle>
            {pendingCommissions.length > 0 && (
              <Button size="sm" onClick={handlePayAll}>
                <CheckCircle className="mr-2 h-4 w-4" />
                Paga Tutte (€{totalPending.toFixed(2)})
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {pendingCommissions.length === 0 ? (
            <p className="text-center py-4 text-muted-foreground">
              Nessuna commissione pendente
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Ordine</TableHead>
                  <TableHead>Rivenditore</TableHead>
                  <TableHead className="text-right">Totale Ordine</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Commissione</TableHead>
                  <TableHead>Tipo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingCommissions.map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-sm">
                      {new Date(c.pendingAt).toLocaleDateString("it-IT")}
                    </TableCell>
                    <TableCell>
                      <Link href={`/orders/${c.orderId}`}>
                        <span className="text-primary hover:underline cursor-pointer text-sm">
                          #{c.orderNumber || c.orderId?.slice(0, 8)}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{c.retailerName || "-"}</TableCell>
                    <TableCell className="text-right text-sm">
                      €{Number(c.orderTotal).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {c.commissionRate}%
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      €{Number(c.commissionAmount).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.isFirstOrder ? "default" : "secondary"} className="text-xs">
                        {c.isFirstOrder ? "Primo" : "Ricorrente"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Rivenditori associati */}
      {affiliate.retailers && affiliate.retailers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Rivenditori Associati</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Città</TableHead>
                  <TableHead>Data Creazione</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {affiliate.retailers.map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/retailers/${r.id}`}>
                        <span className="text-primary hover:underline cursor-pointer font-medium">
                          {r.name}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>{r.city || "-"}</TableCell>
                    <TableCell>
                      {new Date(r.createdAt).toLocaleDateString("it-IT")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Pay Dialog */}
      <Dialog open={payDialog.open} onOpenChange={(o) => setPayDialog({ ...payDialog, open: o })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conferma Pagamento Commissioni</DialogTitle>
            <DialogDescription>
              Stai per segnare {payDialog.ids.length} commissioni come pagate per un totale di €
              {totalPending.toFixed(2)}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="paymentRef">Riferimento Pagamento</Label>
              <Input
                id="paymentRef"
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                placeholder="Es. Bonifico 15/05/2026"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDialog({ open: false, ids: [] })}>
              Annulla
            </Button>
            <Button onClick={confirmPay} disabled={markPaidMutation.isPending}>
              {markPaidMutation.isPending ? "Pagamento..." : "Conferma Pagamento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </DashboardLayout>
  );
}
