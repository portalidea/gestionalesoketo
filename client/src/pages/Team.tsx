import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Building2, KeyRound, Loader2, Mail, Pencil, Trash2, UserPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { useState, useEffect, type FormEvent } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

type Role = "admin" | "operator" | "viewer";

const roleBadgeClass: Record<Role, string> = {
  admin: "bg-primary/10 text-primary border-primary/20",
  operator: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  viewer: "bg-muted text-muted-foreground",
};

function SendResetButton({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const mutation = trpc.users.sendSetPasswordToUser.useMutation({
    onSuccess: () => {
      toast.success(`Link inviato a ${email}`);
      setOpen(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <KeyRound className="w-3.5 h-3.5" />
          Reset
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invia link reset password</DialogTitle>
          <DialogDescription>
            Verrà inviata un'email a <strong>{email}</strong> con il link per
            impostare/reimpostare la password. Procedere?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annulla</Button>
          </DialogClose>
          <Button
            onClick={() => mutation.mutate({ email })}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Invio..." : "Invia link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProfileButton({ user }: { user: { id: string; email: string; name: string | null } }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);
  const utils = trpc.useUtils();

  const mutation = trpc.users.updateProfile.useMutation({
    onSuccess: () => {
      toast.success("Profilo aggiornato");
      utils.users.list.invalidate();
      setOpen(false);
    },
    onError: (err) => toast.error(err.message),
  });

  useEffect(() => {
    if (open) {
      setName(user.name ?? "");
      setEmail(user.email);
    }
  }, [open, user.name, user.email]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <Pencil className="w-3.5 h-3.5" />
          Modifica
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Modifica profilo</DialogTitle>
          <DialogDescription>Modifica nome e email dell'operatore.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="edit-name">Nome</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome completo"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-email">Email</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annulla</Button>
          </DialogClose>
          <Button
            onClick={() => {
              const updates: { id: string; name?: string; email?: string } = { id: user.id };
              if (name !== (user.name ?? "")) updates.name = name;
              if (email !== user.email) updates.email = email;
              mutation.mutate(updates);
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Salvataggio..." : "Salva"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageCompaniesButton({ user }: { user: { id: string; email: string } }) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const companiesQuery = trpc.companies.listAll.useQuery(undefined, { enabled: open });
  const userCompaniesQuery = trpc.companies.listUserCompanies.useQuery(
    { userId: user.id },
    { enabled: open },
  );

  const grantAccess = trpc.companies.grantUserAccess.useMutation({
    onSuccess: () => {
      toast.success("Accesso concesso");
      utils.companies.listUserCompanies.invalidate({ userId: user.id });
    },
    onError: (err) => toast.error(err.message),
  });

  const revokeAccess = trpc.companies.revokeUserAccess.useMutation({
    onSuccess: () => {
      toast.success("Accesso revocato");
      utils.companies.listUserCompanies.invalidate({ userId: user.id });
    },
    onError: (err) => toast.error(err.message),
  });

  const assignedIds = new Set(
    (userCompaniesQuery.data ?? []).map((c) => c.companyId),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <Building2 className="w-3.5 h-3.5" />
          Aziende
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aziende assegnate</DialogTitle>
          <DialogDescription>
            Seleziona le aziende a cui <strong>{user.email}</strong> ha accesso.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {companiesQuery.isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            companiesQuery.data?.map((company) => {
              const isAssigned = assignedIds.has(company.id);
              return (
                <div key={company.id} className="flex items-center gap-3">
                  <Checkbox
                    id={`company-${company.id}`}
                    checked={isAssigned}
                    disabled={grantAccess.isPending || revokeAccess.isPending}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        grantAccess.mutate({ userId: user.id, companyId: company.id });
                      } else {
                        revokeAccess.mutate({ userId: user.id, companyId: company.id });
                      }
                    }}
                  />
                  <label htmlFor={`company-${company.id}`} className="text-sm font-medium cursor-pointer">
                    {company.name}
                  </label>
                </div>
              );
            })
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Chiudi</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SetPasswordAllCard() {
  const [results, setResults] = useState<Array<{ email: string; status: string }> | null>(null);
  const [open, setOpen] = useState(false);

  const mutation = trpc.users.sendSetPasswordToAll.useMutation({
    onSuccess: (data) => {
      setResults(data);
      setOpen(false);
      toast.success(`Email inviate: ${data.filter((r) => r.status === "inviato").length}/${data.length}`);
    },
    onError: (err) => {
      toast.error(`Errore: ${err.message}`);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5" />
          Gestione Password
        </CardTitle>
        <CardDescription>
          Invia un'email con link per impostare la password a <strong>tutti</strong> gli
          utenti registrati. Da usare una sola volta dopo il passaggio a login
          email+password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="default" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Invio in corso...</>
              ) : (
                "Invia a tutti"
              )}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Conferma invio</DialogTitle>
              <DialogDescription>
                Verranno inviate email a tutti gli utenti registrati con un link per
                impostare la propria password. Procedere?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Annulla</Button>
              </DialogClose>
              <Button
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : null}
                Conferma invio
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {results && (
          <div className="text-sm space-y-1 border rounded-md p-3">
            <p className="font-medium mb-2">Risultati:</p>
            {results.map((r, i) => (
              <div key={i} className="flex justify-between py-0.5">
                <span className="text-muted-foreground">{r.email}</span>
                <span className={r.status === "inviato" ? "text-green-500 font-medium" : "text-red-500"}>
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Team() {
  const { user: me } = useAuth();
  const utils = trpc.useUtils();
  const usersQuery = trpc.users.list.useQuery(undefined, {
    enabled: me?.role === "admin",
  });

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("operator");

  const inviteMutation = trpc.users.invite.useMutation({
    onSuccess: () => {
      toast.success(`Invito inviato a ${inviteEmail}`);
      setInviteEmail("");
      setInviteRole("operator");
      utils.users.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const updateRoleMutation = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      toast.success("Ruolo aggiornato");
      utils.users.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.users.delete.useMutation({
    onSuccess: () => {
      toast.success("Utente rimosso");
      utils.users.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (me && me.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <p className="text-muted-foreground">Accesso riservato agli amministratori.</p>
        </div>
      </DashboardLayout>
    );
  }

  const handleInvite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    inviteMutation.mutate({ email: inviteEmail, role: inviteRole });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            Gestisci gli operatori che hanno accesso a SoKeto Gestionale.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Invita un nuovo utente
            </CardTitle>
            <CardDescription>
              L'utente riceverà un'email con un link di accesso. Il ruolo predefinito
              è <strong>operator</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="collaboratore@soketo.it"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-role">Ruolo</Label>
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Role)}>
                  <SelectTrigger id="invite-role" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="operator">Operator</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={inviteMutation.isPending}>
                {inviteMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Invia invito"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* M10: Card gestione password — solo admin */}
        <SetPasswordAllCard />

        <Card>
          <CardHeader>
            <CardTitle>Utenti attivi</CardTitle>
          </CardHeader>
          <CardContent>
            {usersQuery.isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Ruolo</TableHead>
                    <TableHead className="text-right">Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usersQuery.data?.map((u) => {
                    const isMe = me?.id === u.id;
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">{u.email}</TableCell>
                        <TableCell>{u.name ?? "—"}</TableCell>
                        <TableCell>
                          <Select
                            value={u.role}
                            disabled={isMe}
                            onValueChange={(role) =>
                              updateRoleMutation.mutate({ id: u.id, role: role as Role })
                            }
                          >
                            <SelectTrigger className="w-32">
                              <SelectValue>
                                <Badge variant="outline" className={roleBadgeClass[u.role as Role]}>
                                  {u.role}
                                </Badge>
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="operator">Operator</SelectItem>
                              <SelectItem value="viewer">Viewer</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2 flex-wrap">
                            <EditProfileButton user={u} />
                            <ManageCompaniesButton user={u} />
                            <SendResetButton email={u.email} />
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isMe}
                              onClick={() => {
                                if (confirm(`Rimuovere ${u.email}?`)) {
                                  deleteMutation.mutate({ id: u.id });
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
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
