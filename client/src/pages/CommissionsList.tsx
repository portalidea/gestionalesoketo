import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Euro, FileText } from "lucide-react";

export default function CommissionsList() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [affiliateFilter, setAffiliateFilter] = useState<string>("all");

  const { data, isLoading } = trpc.affiliates.commissionsList.useQuery({
    status: statusFilter !== "all" ? (statusFilter as "pending" | "paid" | "voided") : undefined,
    affiliateId: affiliateFilter !== "all" ? affiliateFilter : undefined,
  });

  const { data: affiliatesList } = trpc.affiliates.list.useQuery({});

  const commissions = data?.items ?? [];

  const totalPending = commissions
    .filter((c: any) => c.status === "pending")
    .reduce((sum: number, c: any) => sum + Number(c.commissionAmount), 0);

  const totalPaid = commissions
    .filter((c: any) => c.status === "paid")
    .reduce((sum: number, c: any) => sum + Number(c.commissionAmount), 0);

  const statusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="outline" className="text-orange-600 border-orange-300">Pendente</Badge>;
      case "paid":
        return <Badge variant="default" className="bg-green-600">Pagata</Badge>;
      case "voided":
        return <Badge variant="destructive">Annullata</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Commissioni</h1>
          <p className="text-muted-foreground">
            Tutte le commissioni generate dal programma affiliati
          </p>
        </div>
        <Link href="/affiliates/report">
          <Button variant="outline">
            <FileText className="mr-2 h-4 w-4" />
            Report Mensile
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Euro className="h-4 w-4 text-orange-500" />
              <span className="text-sm text-muted-foreground">Totale Pendenti</span>
            </div>
            <p className="text-2xl font-bold mt-1">€{totalPending.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Euro className="h-4 w-4 text-green-500" />
              <span className="text-sm text-muted-foreground">Totale Pagate</span>
            </div>
            <p className="text-2xl font-bold mt-1">€{totalPaid.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Totale Righe</span>
            </div>
            <p className="text-2xl font-bold mt-1">{commissions.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Stato" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutti gli stati</SelectItem>
                <SelectItem value="pending">Pendente</SelectItem>
                <SelectItem value="paid">Pagata</SelectItem>
                <SelectItem value="voided">Annullata</SelectItem>
              </SelectContent>
            </Select>
            <Select value={affiliateFilter} onValueChange={setAffiliateFilter}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Affiliato" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutti gli affiliati</SelectItem>
                {(affiliatesList?.items ?? []).map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Caricamento...</div>
          ) : commissions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nessuna commissione trovata
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Affiliato</TableHead>
                  <TableHead>Ordine</TableHead>
                  <TableHead>Rivenditore</TableHead>
                  <TableHead className="text-right">Totale Ordine</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Commissione</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Stato</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commissions.map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-sm">
                      {new Date(c.pendingAt || c.createdAt).toLocaleDateString("it-IT")}
                    </TableCell>
                    <TableCell>
                      <Link href={`/affiliates/${c.affiliateId}`}>
                        <span className="text-primary hover:underline cursor-pointer text-sm">
                          {c.affiliateName || "-"}
                        </span>
                      </Link>
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
                      <Badge
                        variant={c.isFirstOrder ? "default" : "secondary"}
                        className="text-xs"
                      >
                        {c.isFirstOrder ? "Primo" : "Ricorrente"}
                      </Badge>
                    </TableCell>
                    <TableCell>{statusBadge(c.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
