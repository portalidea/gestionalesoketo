import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  Eye,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Shield,
  TrendingDown,
  TrendingUp,
  Unlock,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function formatCurrency(val: number | string | null | undefined): string {
  const n = typeof val === "string" ? parseFloat(val) : val ?? 0;
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

export default function TierRules() {
  const { user: me } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();

  const { data: config, isLoading: configLoading } = trpc.tierRules.getConfig.useQuery();
  const { data: retailerStatus, isLoading: statusLoading } = trpc.tierRules.getRetailerStatus.useQuery();
  const { data: atRiskList } = trpc.tierRules.getAtRiskRetailers.useQuery();
  const { data: history } = trpc.tierRules.getTierHistory.useQuery({});
  const { data: simulation } = trpc.tierRules.getSimulationLog.useQuery({});
  const { data: packages } = trpc.pricingPackages.list.useQuery();

  const updateConfig = trpc.tierRules.updateConfig.useMutation({
    onSuccess: () => {
      utils.tierRules.getConfig.invalidate();
      toast.success("Configurazione aggiornata");
    },
  });

  const setMode = trpc.tierRules.setMode.useMutation({
    onSuccess: (data) => {
      utils.tierRules.getConfig.invalidate();
      toast.success(`Modalità cambiata a: ${data.mode === "active" ? "ATTIVO" : "OSSERVAZIONE"}`);
    },
  });

  const setFreeze = trpc.tierRules.setFreeze.useMutation({
    onSuccess: () => {
      utils.tierRules.getRetailerStatus.invalidate();
      toast.success("Stato freeze aggiornato");
    },
  });

  const manualChange = trpc.tierRules.manualTierChange.useMutation({
    onSuccess: () => {
      utils.tierRules.getRetailerStatus.invalidate();
      utils.tierRules.getTierHistory.invalidate();
      toast.success("Tier cambiato manualmente");
    },
  });

  const runEvaluation = trpc.tierRules.runEvaluation.useMutation({
    onSuccess: (data) => {
      utils.tierRules.getRetailerStatus.invalidate();
      utils.tierRules.getSimulationLog.invalidate();
      utils.tierRules.getAtRiskRetailers.invalidate();
      utils.tierRules.getTierHistory.invalidate();
      if (data.skipped) {
        toast.info("Valutazione già eseguita oggi");
      } else {
        toast.success(`Valutazione completata (${data.mode}): ${data.results?.length ?? 0} rivenditori valutati`);
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const [editRule, setEditRule] = useState<{
    id: string;
    tierName: string;
    monthlyMaintenanceThreshold: string;
    promotionThreshold: string;
    consecutiveMonthsForDowngrade: string;
    isActive: boolean;
  } | null>(null);

  const [modeConfirmOpen, setModeConfirmOpen] = useState(false);
  const [manualChangeDialog, setManualChangeDialog] = useState<{
    retailerId: string;
    retailerName: string;
    currentTier: string;
  } | null>(null);
  const [manualNewPkg, setManualNewPkg] = useState("");
  const [manualReason, setManualReason] = useState("");

  if (!me) return null;

  const mode = config?.mode ?? "observation";
  const isObservation = mode === "observation";

  return (
    <DashboardLayout>
      <div className="container py-6 space-y-6">
        {/* Header with mode indicator */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Motore Tier Automatico</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Gestione automatica declassamento/promozione tier rivenditori
            </p>
          </div>
          <div className="flex items-center gap-4">
            {/* Mode indicator */}
            <div
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 ${
                isObservation
                  ? "border-amber-400 bg-amber-50 text-amber-800"
                  : "border-green-400 bg-green-50 text-green-800"
              }`}
            >
              {isObservation ? <Eye className="h-5 w-5" /> : <Zap className="h-5 w-5" />}
              <span className="font-semibold text-sm">
                {isObservation ? "OSSERVAZIONE" : "ATTIVO"}
              </span>
            </div>
            <Button
              variant={isObservation ? "default" : "outline"}
              onClick={() => setModeConfirmOpen(true)}
              size="sm"
            >
              {isObservation ? "Attiva Motore" : "Passa a Osservazione"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => runEvaluation.mutate()}
              disabled={runEvaluation.isPending}
            >
              {runEvaluation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              Esegui Valutazione
            </Button>
          </div>
        </div>

        {/* Mode change confirmation */}
        <AlertDialog open={modeConfirmOpen} onOpenChange={setModeConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isObservation
                  ? "Attivare il motore tier?"
                  : "Passare a modalità osservazione?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isObservation
                  ? "Stai per attivare i cambi tier REALI sui rivenditori. Il motore applicherà declassamenti e promozioni automatiche. Confermi?"
                  : "Il motore tornerà in modalità osservazione. I tier dei rivenditori non verranno più modificati automaticamente."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setMode.mutate({ mode: isObservation ? "active" : "observation" });
                  setModeConfirmOpen(false);
                }}
                className={isObservation ? "bg-green-600 hover:bg-green-700" : ""}
              >
                {isObservation ? "Sì, attiva" : "Sì, osservazione"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Tabs defaultValue="config" className="w-full">
          <TabsList>
            <TabsTrigger value="config">Configurazione Soglie</TabsTrigger>
            <TabsTrigger value="retailers">Stato Rivenditori</TabsTrigger>
            <TabsTrigger value="atrisk">
              A Rischio
              {atRiskList && atRiskList.length > 0 && (
                <Badge variant="destructive" className="ml-2 text-xs">
                  {atRiskList.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="simulation">Simulazione</TabsTrigger>
            <TabsTrigger value="history">Storico</TabsTrigger>
          </TabsList>

          {/* ============= CONFIG TAB ============= */}
          <TabsContent value="config" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Soglie per Tier</CardTitle>
              </CardHeader>
              <CardContent>
                {configLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tier</TableHead>
                        <TableHead>Soglia Mantenimento (€/mese)</TableHead>
                        <TableHead>Soglia Promozione (€/mese)</TableHead>
                        <TableHead>Mesi Consecutivi</TableHead>
                        <TableHead>Attivo</TableHead>
                        <TableHead className="w-20"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {config?.rules.map((rule) => (
                        <TableRow key={rule.id}>
                          <TableCell className="font-medium">{rule.tierName}</TableCell>
                          <TableCell>{formatCurrency(rule.monthlyMaintenanceThreshold)}</TableCell>
                          <TableCell>
                            {rule.promotionThreshold
                              ? formatCurrency(rule.promotionThreshold)
                              : "—"}
                          </TableCell>
                          <TableCell>{rule.consecutiveMonthsForDowngrade}</TableCell>
                          <TableCell>
                            <Badge variant={rule.isActive ? "default" : "secondary"}>
                              {rule.isActive ? "Sì" : "No"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setEditRule({
                                  id: rule.id,
                                  tierName: rule.tierName,
                                  monthlyMaintenanceThreshold: rule.monthlyMaintenanceThreshold,
                                  promotionThreshold: rule.promotionThreshold ?? "",
                                  consecutiveMonthsForDowngrade: String(rule.consecutiveMonthsForDowngrade),
                                  isActive: rule.isActive,
                                })
                              }
                            >
                              Modifica
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============= RETAILERS TAB ============= */}
          <TabsContent value="retailers" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Stato Rivenditori</CardTitle>
              </CardHeader>
              <CardContent>
                {statusLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rivenditore</TableHead>
                        <TableHead>Tier</TableHead>
                        <TableHead>Fatturato Mese</TableHead>
                        <TableHead>Mesi Sotto Soglia</TableHead>
                        <TableHead>Stato</TableHead>
                        <TableHead>Freeze</TableHead>
                        <TableHead className="w-32"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {retailerStatus
                        ?.filter((r) => r.pricingModel === "tier_discount")
                        .map((r) => (
                          <TableRow key={r.id}>
                            <TableCell className="font-medium">{r.name}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{r.tierName ?? "N/A"}</Badge>
                            </TableCell>
                            <TableCell>{formatCurrency(r.currentMonthRevenue)}</TableCell>
                            <TableCell>
                              <span
                                className={
                                  r.consecutiveMonthsBelow >= 2
                                    ? "text-red-600 font-semibold"
                                    : ""
                                }
                              >
                                {r.consecutiveMonthsBelow}
                              </span>
                            </TableCell>
                            <TableCell>
                              {r.atRisk && (
                                <Badge variant="destructive" className="gap-1">
                                  <AlertTriangle className="h-3 w-3" />A Rischio
                                </Badge>
                              )}
                              {r.tierFrozen && (
                                <Badge variant="secondary" className="gap-1">
                                  <Lock className="h-3 w-3" />
                                  Frozen
                                </Badge>
                              )}
                              {!r.atRisk && !r.tierFrozen && (
                                <span className="text-muted-foreground text-sm">OK</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Switch
                                checked={r.tierFrozen}
                                onCheckedChange={(checked) =>
                                  setFreeze.mutate({ retailerId: r.id, frozen: checked })
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setManualChangeDialog({
                                    retailerId: r.id,
                                    retailerName: r.name,
                                    currentTier: r.tierName ?? "N/A",
                                  });
                                  setManualNewPkg("");
                                  setManualReason("");
                                }}
                              >
                                Cambio Manuale
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============= AT RISK TAB ============= */}
          <TabsContent value="atrisk" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  Rivenditori a Rischio Declassamento
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!atRiskList || atRiskList.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    Nessun rivenditore a rischio al momento.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rivenditore</TableHead>
                        <TableHead>Tier Attuale</TableHead>
                        <TableHead>Mesi Consecutivi Sotto Soglia</TableHead>
                        <TableHead>Ultima Valutazione</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {atRiskList.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{r.tierName}</Badge>
                          </TableCell>
                          <TableCell className="text-red-600 font-semibold">
                            {r.consecutiveMonthsBelow}
                          </TableCell>
                          <TableCell>{r.lastTierEvaluation ?? "Mai"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============= SIMULATION TAB ============= */}
          <TabsContent value="simulation" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Eye className="h-5 w-5 text-amber-500" />
                  Ultimo Run Simulazione
                  {simulation?.runDate && (
                    <Badge variant="outline" className="ml-2">
                      {simulation.runDate}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!simulation?.entries || simulation.entries.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    Nessuna simulazione disponibile. Esegui una valutazione in modalità osservazione.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rivenditore</TableHead>
                        <TableHead>Tier Attuale</TableHead>
                        <TableHead>Azione Prevista</TableHead>
                        <TableHead>Nuovo Tier</TableHead>
                        <TableHead>Fatturato</TableHead>
                        <TableHead>Mesi Sotto</TableHead>
                        <TableHead>Motivo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {simulation.entries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="font-medium">{entry.retailerName}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{entry.currentTier}</Badge>
                          </TableCell>
                          <TableCell>
                            <SimulationActionBadge action={entry.action} />
                          </TableCell>
                          <TableCell>
                            {entry.wouldChangeTo ? (
                              <Badge variant="secondary">{entry.wouldChangeTo}</Badge>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell>{formatCurrency(entry.monthlyRevenueSnapshot)}</TableCell>
                          <TableCell>{entry.consecutiveMonthsBelow ?? 0}</TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                            {entry.reason}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============= HISTORY TAB ============= */}
          <TabsContent value="history" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Storico Cambi Tier</CardTitle>
              </CardHeader>
              <CardContent>
                {!history || history.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    Nessun cambio tier registrato.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Data</TableHead>
                        <TableHead>Rivenditore</TableHead>
                        <TableHead>Da</TableHead>
                        <TableHead>A</TableHead>
                        <TableHead>Motivo</TableHead>
                        <TableHead>Fatturato</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((h) => (
                        <TableRow key={h.id}>
                          <TableCell className="text-sm">
                            {h.createdAt
                              ? new Date(h.createdAt).toLocaleDateString("it-IT")
                              : "—"}
                          </TableCell>
                          <TableCell className="font-medium">{h.retailerName}</TableCell>
                          <TableCell>
                            {h.fromTier ? <Badge variant="outline">{h.fromTier}</Badge> : "—"}
                          </TableCell>
                          <TableCell>
                            {h.toTier ? <Badge variant="secondary">{h.toTier}</Badge> : "—"}
                          </TableCell>
                          <TableCell>
                            <ReasonBadge reason={h.reason} />
                          </TableCell>
                          <TableCell>
                            {h.monthlyRevenueSnapshot
                              ? formatCurrency(h.monthlyRevenueSnapshot)
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* ============= EDIT RULE DIALOG ============= */}
        <Dialog open={!!editRule} onOpenChange={() => setEditRule(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Modifica Soglie — {editRule?.tierName}</DialogTitle>
              <DialogDescription>
                Configura le soglie di mantenimento e promozione per questo tier.
              </DialogDescription>
            </DialogHeader>
            {editRule && (
              <div className="space-y-4">
                <div>
                  <Label>Soglia Mantenimento (€/mese)</Label>
                  <Input
                    type="number"
                    value={editRule.monthlyMaintenanceThreshold}
                    onChange={(e) =>
                      setEditRule({ ...editRule, monthlyMaintenanceThreshold: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label>Soglia Promozione (€/mese)</Label>
                  <Input
                    type="number"
                    value={editRule.promotionThreshold}
                    onChange={(e) =>
                      setEditRule({ ...editRule, promotionThreshold: e.target.value })
                    }
                    placeholder="Vuoto = usa soglia mantenimento"
                  />
                </div>
                <div>
                  <Label>Mesi Consecutivi per Declassamento</Label>
                  <Input
                    type="number"
                    min="1"
                    max="12"
                    value={editRule.consecutiveMonthsForDowngrade}
                    onChange={(e) =>
                      setEditRule({ ...editRule, consecutiveMonthsForDowngrade: e.target.value })
                    }
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={editRule.isActive}
                    onCheckedChange={(checked) => setEditRule({ ...editRule, isActive: checked })}
                  />
                  <Label>Regola attiva</Label>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditRule(null)}>
                Annulla
              </Button>
              <Button
                onClick={() => {
                  if (!editRule) return;
                  updateConfig.mutate({
                    tierId: editRule.id,
                    monthlyMaintenanceThreshold: parseFloat(editRule.monthlyMaintenanceThreshold) || 0,
                    promotionThreshold: editRule.promotionThreshold
                      ? parseFloat(editRule.promotionThreshold)
                      : null,
                    consecutiveMonthsForDowngrade: parseInt(editRule.consecutiveMonthsForDowngrade) || 3,
                    isActive: editRule.isActive,
                  });
                  setEditRule(null);
                }}
                disabled={updateConfig.isPending}
              >
                Salva
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ============= MANUAL TIER CHANGE DIALOG ============= */}
        <Dialog open={!!manualChangeDialog} onOpenChange={() => setManualChangeDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cambio Tier Manuale</DialogTitle>
              <DialogDescription>
                Cambia il tier di {manualChangeDialog?.retailerName} (attuale:{" "}
                {manualChangeDialog?.currentTier})
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Nuovo Tier</Label>
                <Select value={manualNewPkg} onValueChange={setManualNewPkg}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleziona tier..." />
                  </SelectTrigger>
                  <SelectContent>
                    {packages?.map((pkg) => (
                      <SelectItem key={pkg.id} value={pkg.id}>
                        {pkg.name} ({pkg.discountPercent}%)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Motivo (opzionale)</Label>
                <Input
                  value={manualReason}
                  onChange={(e) => setManualReason(e.target.value)}
                  placeholder="Es: accordo commerciale speciale"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setManualChangeDialog(null)}>
                Annulla
              </Button>
              <Button
                onClick={() => {
                  if (!manualChangeDialog || !manualNewPkg) return;
                  manualChange.mutate({
                    retailerId: manualChangeDialog.retailerId,
                    newTierPackageId: manualNewPkg,
                    reason: manualReason || undefined,
                  });
                  setManualChangeDialog(null);
                }}
                disabled={!manualNewPkg || manualChange.isPending}
              >
                Conferma Cambio
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}

function SimulationActionBadge({ action }: { action: string | null }) {
  switch (action) {
    case "would_downgrade":
      return (
        <Badge variant="destructive" className="gap-1">
          <TrendingDown className="h-3 w-3" />
          Declasserebbe
        </Badge>
      );
    case "would_promote":
      return (
        <Badge className="gap-1 bg-green-600">
          <TrendingUp className="h-3 w-3" />
          Promuoverebbe
        </Badge>
      );
    case "would_flag_risk":
      return (
        <Badge variant="secondary" className="gap-1 text-amber-700 border-amber-300 bg-amber-50">
          <AlertTriangle className="h-3 w-3" />A Rischio
        </Badge>
      );
    case "no_change":
      return <span className="text-muted-foreground text-sm">Nessun cambio</span>;
    default:
      return <span className="text-muted-foreground text-sm">{action ?? "—"}</span>;
  }
}

function ReasonBadge({ reason }: { reason: string | null }) {
  switch (reason) {
    case "auto_downgrade":
      return <Badge variant="destructive">Auto Declassamento</Badge>;
    case "auto_promotion":
      return <Badge className="bg-green-600">Auto Promozione</Badge>;
    case "manual":
      return <Badge variant="secondary">Manuale</Badge>;
    case "freeze":
      return (
        <Badge variant="outline" className="gap-1">
          <Lock className="h-3 w-3" />
          Freeze
        </Badge>
      );
    case "unfreeze":
      return (
        <Badge variant="outline" className="gap-1">
          <Unlock className="h-3 w-3" />
          Unfreeze
        </Badge>
      );
    default:
      return <span className="text-sm text-muted-foreground">{reason ?? "—"}</span>;
  }
}
