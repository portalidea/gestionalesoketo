import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  Check,
  ChevronsUpDown,
  Loader2,
  Plug,
  Plus,
  Store,
  X,
} from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

const EMPTY_FORM = {
  name: "",
  businessType: "",
  address: "",
  city: "",
  province: "",
  postalCode: "",
  phone: "",
  email: "",
  contactPerson: "",
  notes: "",
};

type FicClient = {
  id: number;
  name: string;
  vat_number?: string;
  tax_code?: string;
  email?: string;
  phone?: string;
  address_street?: string;
  address_postal_code?: string;
  address_city?: string;
  address_province?: string;
  contact_person?: string;
};

export default function Retailers() {
  const { data: retailers, isLoading } = trpc.retailers.list.useQuery();
  const [, setLocation] = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const utils = trpc.useUtils();

  const [formData, setFormData] = useState(EMPTY_FORM);
  // M3.0.6: id cliente FiC associato (NULL se "crea da zero")
  const [selectedFicClientId, setSelectedFicClientId] = useState<number | null>(
    null,
  );
  const [comboboxOpen, setComboboxOpen] = useState(false);

  const { data: ficStatus } = trpc.ficIntegration.getStatus.useQuery();
  const { data: ficClientsData } = trpc.ficClients.list.useQuery(undefined, {
    enabled: !!ficStatus?.connected && dialogOpen,
    retry: false,
  });
  const ficClients = (ficClientsData?.clients ?? []) as FicClient[];
  const selectedFicClient =
    selectedFicClientId !== null
      ? ficClients.find((c) => c.id === selectedFicClientId)
      : null;

  const createMutation = trpc.retailers.create.useMutation({
    onSuccess: () => {
      utils.retailers.list.invalidate();
      setDialogOpen(false);
      toast.success(
        selectedFicClientId
          ? "Rivenditore creato + cliente FiC associato"
          : "Rivenditore creato (nessun cliente FiC mappato)",
      );
      setFormData(EMPTY_FORM);
      setSelectedFicClientId(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      ...formData,
      // Pass ficClientId only when set (zod schema is .optional())
      ...(selectedFicClientId !== null
        ? { ficClientId: selectedFicClientId }
        : {}),
    });
  };

  function importFromFicClient(client: FicClient) {
    // Compose address_extra into address line if present (FiC sometimes
    // splits via/civico across street + extra). Tutti i campi rimangono
    // editabili dopo l'import.
    setSelectedFicClientId(client.id);
    setFormData((prev) => ({
      ...prev,
      name: client.name ?? prev.name,
      address: client.address_street ?? prev.address,
      city: client.address_city ?? prev.city,
      province: (client.address_province ?? prev.province).toUpperCase().slice(0, 2),
      postalCode: client.address_postal_code ?? prev.postalCode,
      phone: client.phone ?? prev.phone,
      email: client.email ?? prev.email,
      contactPerson: client.contact_person ?? prev.contactPerson,
    }));
    setComboboxOpen(false);
  }

  function clearFicImport() {
    setSelectedFicClientId(null);
    // Lascia i campi pre-popolati intatti: l'utente potrebbe voler
    // mantenere i dati senza il binding al ficClientId.
  }

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Rivenditori</h1>
            <p className="text-muted-foreground">
              Anagrafica punti vendita SoKeto con stock e valore inventario corrente.
            </p>
          </div>
          <Dialog
            open={dialogOpen}
            onOpenChange={(o) => {
              setDialogOpen(o);
              if (!o) {
                setFormData(EMPTY_FORM);
                setSelectedFicClientId(null);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="lg">
                <Plus className="h-5 w-5 mr-2" />
                Nuovo Rivenditore
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <DialogHeader>
                  <DialogTitle>Nuovo Rivenditore</DialogTitle>
                  <DialogDescription>
                    Importa da Fatture in Cloud oppure crea da zero
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  {/* M3.0.6: import da cliente FiC */}
                  <Card className="border-dashed border-border bg-muted/30">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Plug className="h-4 w-4 text-primary" />
                        Crea da cliente Fatture in Cloud
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Seleziona un cliente già in anagrafica FiC: nome, indirizzo,
                        contatti vengono pre-popolati. La P.IVA è solo nel record FiC,
                        non duplicata qui. Tipo Attività rimane manuale.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {!ficStatus?.connected ? (
                        <p className="text-xs text-muted-foreground">
                          Fatture in Cloud non connesso.{" "}
                          <button
                            type="button"
                            className="underline hover:text-foreground"
                            onClick={() => setLocation("/settings/integrations")}
                          >
                            Connetti l'integrazione
                          </button>{" "}
                          per importare clienti.
                        </p>
                      ) : ficClients.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Nessun cliente in cache.{" "}
                          <button
                            type="button"
                            className="underline hover:text-foreground"
                            onClick={() => setLocation("/settings/integrations")}
                          >
                            Vai a Integrazioni
                          </button>{" "}
                          e clicca "Aggiorna lista clienti FiC".
                        </p>
                      ) : selectedFicClient ? (
                        <div className="flex items-center justify-between rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
                          <div className="text-sm">
                            <span className="font-medium text-foreground">
                              {selectedFicClient.name}
                            </span>
                            {selectedFicClient.vat_number && (
                              <span className="text-muted-foreground ml-2 text-xs font-mono">
                                P.IVA {selectedFicClient.vat_number}
                              </span>
                            )}
                            <div className="text-xs text-muted-foreground mt-0.5">
                              FiC ID: {selectedFicClient.id} — campi pre-popolati sotto
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={clearFicImport}
                            title="Rimuovi associazione FiC (mantiene i dati nei campi)"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <Popover open={comboboxOpen} onOpenChange={setComboboxOpen}>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                role="combobox"
                                aria-expanded={comboboxOpen}
                                className="w-full justify-between"
                              >
                                <span className="text-muted-foreground">
                                  Seleziona cliente FiC…
                                </span>
                                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                              <Command>
                                <CommandInput placeholder="Cerca per nome o P.IVA…" />
                                <CommandList>
                                  <CommandEmpty>Nessun cliente trovato</CommandEmpty>
                                  <CommandGroup>
                                    {ficClients.map((c) => (
                                      <CommandItem
                                        key={c.id}
                                        // value combina nome + P.IVA per matching cmdk
                                        value={`${c.name} ${c.vat_number ?? ""} ${c.tax_code ?? ""}`}
                                        onSelect={() => importFromFicClient(c)}
                                      >
                                        <Check
                                          className={`mr-2 h-4 w-4 ${
                                            selectedFicClientId === c.id
                                              ? "opacity-100"
                                              : "opacity-0"
                                          }`}
                                        />
                                        <div className="flex flex-col flex-1 min-w-0">
                                          <span className="truncate">{c.name}</span>
                                          {(c.vat_number ||
                                            c.address_city ||
                                            c.address_province) && (
                                            <span className="text-xs text-muted-foreground truncate">
                                              {c.vat_number
                                                ? `P.IVA ${c.vat_number}`
                                                : ""}
                                              {c.vat_number && c.address_city
                                                ? " · "
                                                : ""}
                                              {c.address_city ?? ""}
                                              {c.address_province
                                                ? ` (${c.address_province})`
                                                : ""}
                                            </span>
                                          )}
                                        </div>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          <p className="text-xs text-muted-foreground">
                            Ricerca tra {ficClients.length} clienti scaricati da FiC.
                          </p>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Divider */}
                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-background px-2 text-muted-foreground uppercase tracking-wider">
                        {selectedFicClient ? "Modifica i dati pre-popolati" : "Oppure crea da zero"}
                      </span>
                    </div>
                  </div>

                  {/* Form anagrafica */}
                  <div className="grid gap-2">
                    <Label htmlFor="name">Nome *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="businessType">Tipo Attività</Label>
                    <Input
                      id="businessType"
                      placeholder="es. Ristorante, Farmacia, Negozio"
                      value={formData.businessType}
                      onChange={(e) =>
                        setFormData({ ...formData, businessType: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="address">Indirizzo</Label>
                    <Input
                      id="address"
                      value={formData.address}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="city">Città</Label>
                      <Input
                        id="city"
                        value={formData.city}
                        onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="province">Provincia</Label>
                      <Input
                        id="province"
                        maxLength={2}
                        placeholder="es. MI"
                        value={formData.province}
                        onChange={(e) =>
                          setFormData({ ...formData, province: e.target.value.toUpperCase() })
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="postalCode">CAP</Label>
                      <Input
                        id="postalCode"
                        value={formData.postalCode}
                        onChange={(e) =>
                          setFormData({ ...formData, postalCode: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="phone">Telefono</Label>
                      <Input
                        id="phone"
                        type="tel"
                        value={formData.phone}
                        onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="contactPerson">Persona di Contatto</Label>
                    <Input
                      id="contactPerson"
                      value={formData.contactPerson}
                      onChange={(e) =>
                        setFormData({ ...formData, contactPerson: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="notes">Note</Label>
                    <Textarea
                      id="notes"
                      value={formData.notes}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Annulla
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Salva
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : retailers && retailers.length > 0 ? (
          <Card className="border-border bg-card">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>Tipo attività</TableHead>
                      <TableHead>Città</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead className="text-right">Lotti attivi</TableHead>
                      <TableHead className="text-right">Stock totale</TableHead>
                      <TableHead className="text-right">Valore inventario</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {retailers.map((r) => (
                      <TableRow
                        key={r.id}
                        className="cursor-pointer hover:bg-accent/50"
                        onClick={() => setLocation(`/retailers/${r.id}`)}
                      >
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <Store className="h-4 w-4 text-primary shrink-0" />
                            {r.name}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.businessType ?? "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.city ?? "-"}
                          {r.province && (
                            <span className="text-xs ml-1">({r.province})</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.email ? (
                            <a
                              href={`mailto:${r.email}`}
                              className="hover:text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {r.email}
                            </a>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.activeBatchCount}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {r.totalStock}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          €{r.inventoryValue}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Store className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Nessun rivenditore registrato
              </h3>
              <p className="text-muted-foreground mb-6 text-center max-w-md">
                Inizia aggiungendo il primo punto vendita per gestire l'inventario.
              </p>
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="h-5 w-5 mr-2" />
                Aggiungi Rivenditore
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
