/**
 * M11.B — /settings/companies
 *
 * Admin-only page for managing companies and user access.
 * Layout: 2-column grid
 *   - Left: list of companies + edit form for selected company
 *   - Right: user access management for selected company
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Building2,
  Check,
  Plus,
  Shield,
  Star,
  Trash2,
  UserPlus,
} from "lucide-react";

export default function Companies() {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  // Data queries
  const { data: allCompanies, isLoading: loadingCompanies } =
    trpc.companies.listAll.useQuery();
  const { data: allUsers } = trpc.companies.listUsers.useQuery();

  // State
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(
    null,
  );
  const [editName, setEditName] = useState("");
  const [editVat, setEditVat] = useState("");
  const [editFiscal, setEditFiscal] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [grantUserId, setGrantUserId] = useState("");
  const [revokeDialog, setRevokeDialog] = useState<{
    userId: string;
    email: string;
  } | null>(null);

  // Selected company user access
  const { data: companyUsers, isLoading: loadingUsers } =
    trpc.companies.listUserAccess.useQuery(
      { companyId: selectedCompanyId! },
      { enabled: !!selectedCompanyId },
    );

  // Mutations
  const updateCompany = trpc.companies.update.useMutation({
    onSuccess: () => {
      toast.success("Azienda aggiornata");
      utils.companies.listAll.invalidate();
      utils.companies.getActive.invalidate();
      utils.companies.listMine.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const grantAccess = trpc.companies.grantUserAccess.useMutation({
    onSuccess: () => {
      toast.success("Accesso concesso");
      utils.companies.listUserAccess.invalidate();
      setGrantUserId("");
    },
    onError: (err) => toast.error(err.message),
  });

  const revokeAccess = trpc.companies.revokeUserAccess.useMutation({
    onSuccess: () => {
      toast.success("Accesso revocato");
      utils.companies.listUserAccess.invalidate();
      setRevokeDialog(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const setDefault = trpc.companies.setUserDefault.useMutation({
    onSuccess: () => {
      toast.success("Default aggiornato");
      utils.companies.listUserAccess.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  // Guard: admin only
  if (user?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">
          Solo gli amministratori possono gestire le aziende.
        </p>
      </div>
    );
  }

  const selectedCompany = allCompanies?.find(
    (c) => c.id === selectedCompanyId,
  );

  const handleSelectCompany = (companyId: string) => {
    setSelectedCompanyId(companyId);
    const company = allCompanies?.find((c) => c.id === companyId);
    if (company) {
      setEditName(company.name);
      setEditVat(company.vatNumber ?? "");
      setEditFiscal(company.fiscalCode ?? "");
      setEditActive(company.isActive);
    }
  };

  const handleSave = () => {
    if (!selectedCompanyId) return;
    updateCompany.mutate({
      id: selectedCompanyId,
      name: editName || undefined,
      vatNumber: editVat || null,
      fiscalCode: editFiscal || null,
      isActive: editActive,
    });
  };

  const handleGrantAccess = () => {
    if (!selectedCompanyId || !grantUserId) return;
    grantAccess.mutate({
      userId: grantUserId,
      companyId: selectedCompanyId,
      isDefault: false,
    });
  };

  const handleRevokeAccess = () => {
    if (!revokeDialog || !selectedCompanyId) return;
    revokeAccess.mutate({
      userId: revokeDialog.userId,
      companyId: selectedCompanyId,
    });
  };

  const handleSetDefault = (userId: string) => {
    if (!selectedCompanyId) return;
    setDefault.mutate({ userId, companyId: selectedCompanyId });
  };

  // Users not yet in this company (for the "add" select)
  const usersNotInCompany = allUsers?.filter(
    (u) => !companyUsers?.some((cu) => cu.userId === u.id),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight">
          Gestione Aziende
        </h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* LEFT COLUMN: Company list + edit form */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Aziende</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {loadingCompanies ? (
                <p className="text-sm text-muted-foreground">Caricamento...</p>
              ) : (
                allCompanies?.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleSelectCompany(c.id)}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                      selectedCompanyId === c.id
                        ? "bg-primary/10 border border-primary/30"
                        : "hover:bg-accent/50 border border-transparent"
                    }`}
                  >
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      {c.vatNumber && (
                        <p className="text-xs text-muted-foreground">
                          P.IVA: {c.vatNumber}
                        </p>
                      )}
                    </div>
                    {!c.isActive && (
                      <Badge variant="secondary" className="text-xs shrink-0">
                        Disattivata
                      </Badge>
                    )}
                    {selectedCompanyId === c.id && (
                      <Check className="h-4 w-4 text-primary shrink-0" />
                    )}
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          {/* Edit form */}
          {selectedCompany && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Modifica: {selectedCompany.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="company-name">Nome azienda</Label>
                  <Input
                    id="company-name"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company-vat">Partita IVA</Label>
                  <Input
                    id="company-vat"
                    value={editVat}
                    onChange={(e) => setEditVat(e.target.value)}
                    placeholder="IT..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company-fiscal">Codice Fiscale</Label>
                  <Input
                    id="company-fiscal"
                    value={editFiscal}
                    onChange={(e) => setEditFiscal(e.target.value)}
                    placeholder="IT..."
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id="company-active"
                    checked={editActive}
                    onCheckedChange={setEditActive}
                  />
                  <Label htmlFor="company-active" className="text-sm">
                    Azienda attiva
                  </Label>
                </div>
                <Button
                  onClick={handleSave}
                  disabled={updateCompany.isPending}
                  className="w-full"
                >
                  {updateCompany.isPending ? "Salvataggio..." : "Salva modifiche"}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* RIGHT COLUMN: User access management */}
        <div className="space-y-4">
          {selectedCompanyId ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="h-4 w-4" />
                    Accessi utente — {selectedCompany?.name}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {loadingUsers ? (
                    <p className="text-sm text-muted-foreground">
                      Caricamento...
                    </p>
                  ) : companyUsers && companyUsers.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Utente</TableHead>
                            <TableHead>Ruolo</TableHead>
                            <TableHead className="text-center">
                              Default
                            </TableHead>
                            <TableHead className="text-right">Azioni</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {companyUsers.map((cu) => (
                            <TableRow key={cu.userId}>
                              <TableCell>
                                <div>
                                  <p className="text-sm font-medium">
                                    {cu.name || cu.email}
                                  </p>
                                  {cu.name && (
                                    <p className="text-xs text-muted-foreground">
                                      {cu.email}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-xs">
                                  {cu.role}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center">
                                {cu.isDefault ? (
                                  <Star className="h-4 w-4 text-amber-500 mx-auto" />
                                ) : (
                                  <button
                                    onClick={() =>
                                      handleSetDefault(cu.userId)
                                    }
                                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                    title="Imposta come default"
                                  >
                                    <Star className="h-4 w-4 mx-auto" />
                                  </button>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() =>
                                    setRevokeDialog({
                                      userId: cu.userId,
                                      email: cu.email,
                                    })
                                  }
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Nessun utente con accesso a questa azienda.
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Add user access */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <UserPlus className="h-4 w-4" />
                    Aggiungi accesso
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2">
                    <Select
                      value={grantUserId}
                      onValueChange={setGrantUserId}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Seleziona utente..." />
                      </SelectTrigger>
                      <SelectContent>
                        {usersNotInCompany?.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name || u.email} ({u.role})
                          </SelectItem>
                        ))}
                        {usersNotInCompany?.length === 0 && (
                          <SelectItem value="__none" disabled>
                            Tutti gli utenti hanno già accesso
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleGrantAccess}
                      disabled={!grantUserId || grantAccess.isPending}
                      size="icon"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <Building2 className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  Seleziona un'azienda per gestire gli accessi utente.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Revoke confirmation dialog */}
      <Dialog
        open={!!revokeDialog}
        onOpenChange={(open) => !open && setRevokeDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conferma revoca accesso</DialogTitle>
            <DialogDescription>
              Stai per revocare l'accesso di{" "}
              <strong>{revokeDialog?.email}</strong> a{" "}
              <strong>{selectedCompany?.name}</strong>. L'utente non potrà più
              operare su questa azienda.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeDialog(null)}
            >
              Annulla
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevokeAccess}
              disabled={revokeAccess.isPending}
            >
              {revokeAccess.isPending ? "Revoca..." : "Revoca accesso"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
