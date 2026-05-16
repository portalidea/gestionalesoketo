import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Plus, Search, Users, Euro, TrendingUp } from "lucide-react";

export default function AffiliatesList() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading } = trpc.affiliates.list.useQuery({
    search: search || undefined,
    status: statusFilter !== "all" ? (statusFilter as "active" | "inactive") : undefined,
  });

  const affiliates = data?.items ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Affiliati</h1>
          <p className="text-muted-foreground">
            Gestisci il programma di affiliazione e le commissioni
          </p>
        </div>
        <Link href="/affiliates/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Nuovo Affiliato
          </Button>
        </Link>
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Totale Affiliati</span>
            </div>
            <p className="text-2xl font-bold mt-1">{data?.total ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Cerca per nome, email, codice referral..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Stato" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutti gli stati</SelectItem>
                <SelectItem value="active">Attivo</SelectItem>
                <SelectItem value="inactive">Inattivo</SelectItem>
                <SelectItem value="suspended">Sospeso</SelectItem>
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
          ) : affiliates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nessun affiliato trovato
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Codice Referral</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="text-right">% Primo Ordine</TableHead>
                  <TableHead className="text-right">% Ricorrente</TableHead>
                  <TableHead className="text-right">Rivenditori</TableHead>
                  <TableHead className="text-right">Comm. Pendenti</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {affiliates.map((affiliate: any) => (
                  <TableRow key={affiliate.id}>
                    <TableCell>
                      <Link href={`/affiliates/${affiliate.id}`}>
                        <span className="font-medium text-primary hover:underline cursor-pointer">
                          {affiliate.name}
                        </span>
                      </Link>
                      {affiliate.email && (
                        <p className="text-xs text-muted-foreground">{affiliate.email}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-sm bg-muted px-2 py-0.5 rounded">
                        {affiliate.referralCode}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          affiliate.status === "active"
                            ? "default"
                            : affiliate.status === "suspended"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {affiliate.status === "active"
                          ? "Attivo"
                          : affiliate.status === "suspended"
                            ? "Sospeso"
                            : "Inattivo"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {affiliate.firstOrderRate}%
                    </TableCell>
                    <TableCell className="text-right">
                      {affiliate.recurringRate}%
                    </TableCell>
                    <TableCell className="text-right">
                      {affiliate.retailerCount ?? 0}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      €{affiliate.pendingCommissions ?? "0.00"}
                    </TableCell>
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
