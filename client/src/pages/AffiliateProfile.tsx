/**
 * M7-B — AffiliateProfile
 * Profilo affiliato: dati read-only + modifica phone/IBAN.
 */
import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import AffiliateLayout from "@/components/AffiliateLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Save, Copy, Check } from "lucide-react";
import { toast } from "sonner";

export default function AffiliateProfile() {
  const { data: profile, isLoading } = trpc.affiliatePortal.profileGet.useQuery();
  const updateMutation = trpc.affiliatePortal.profileUpdateContact.useMutation();
  const utils = trpc.useUtils();

  const [phone, setPhone] = useState("");
  const [iban, setIban] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (profile) {
      setPhone(profile.phone || "");
      setIban(profile.iban || "");
    }
  }, [profile]);

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        phone: phone || undefined,
        iban: iban || undefined,
      });
      toast.success("Dati di contatto aggiornati");
      utils.affiliatePortal.profileGet.invalidate();
    } catch (err: any) {
      toast.error(err?.message || "Errore durante il salvataggio");
    }
  };

  const copyReferralCode = () => {
    if (profile?.referralCode) {
      navigator.clipboard.writeText(profile.referralCode);
      setCopied(true);
      toast.success("Codice referral copiato!");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const hasChanges =
    profile && (phone !== (profile.phone || "") || iban !== (profile.iban || ""));

  if (isLoading) {
    return (
      <AffiliateLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Caricamento profilo...
        </div>
      </AffiliateLayout>
    );
  }

  if (!profile) {
    return (
      <AffiliateLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Profilo non trovato.
        </div>
      </AffiliateLayout>
    );
  }

  return (
    <AffiliateLayout>
      <div className="space-y-6 max-w-2xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">Profilo</h1>
          <p className="text-muted-foreground">I tuoi dati e le condizioni del programma</p>
        </div>

        {/* Referral Code Card */}
        <Card className="border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Il tuo codice referral</p>
                <p className="text-2xl font-bold text-green-700 dark:text-green-400 font-mono mt-1">
                  {profile.referralCode}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={copyReferralCode}>
                {copied ? (
                  <Check className="h-4 w-4 mr-1" />
                ) : (
                  <Copy className="h-4 w-4 mr-1" />
                )}
                {copied ? "Copiato" : "Copia"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Read-only Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Informazioni programma</CardTitle>
            <CardDescription>
              Questi dati sono gestiti dall'amministratore SoKeto.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground text-xs">Nome</Label>
                <p className="font-medium">{profile.name}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Email</Label>
                <p className="font-medium">{profile.email}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Codice Fiscale</Label>
                <p className="font-medium font-mono">{profile.taxCode || "-"}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Partita IVA</Label>
                <p className="font-medium font-mono">{profile.vatNumber || "-"}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Commissione primo ordine</Label>
                <p className="font-medium">{profile.firstOrderRate}%</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Commissione ordini successivi</Label>
                <p className="font-medium">{profile.recurringRate}%</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Stato</Label>
                <Badge variant={profile.status === "active" ? "default" : "secondary"}>
                  {profile.status === "active" ? "Attivo" : "Inattivo"}
                </Badge>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Membro dal</Label>
                <p className="font-medium">
                  {new Date(profile.createdAt).toLocaleDateString("it-IT", {
                    day: "2-digit",
                    month: "long",
                    year: "numeric",
                  })}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Editable Contact Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dati di contatto</CardTitle>
            <CardDescription>
              Puoi aggiornare il telefono e l'IBAN per i pagamenti.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Telefono</Label>
              <Input
                id="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+39 333 1234567"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="iban">IBAN</Label>
              <Input
                id="iban"
                value={iban}
                onChange={(e) => setIban(e.target.value.toUpperCase())}
                placeholder="IT60X0542811101000000123456"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Formato europeo. Esempio: IT60X0542811101000000123456
              </p>
            </div>

            <Separator />

            <div className="flex justify-end">
              <Button
                onClick={handleSave}
                disabled={!hasChanges || updateMutation.isPending}
              >
                <Save className="mr-2 h-4 w-4" />
                {updateMutation.isPending ? "Salvataggio..." : "Salva modifiche"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AffiliateLayout>
  );
}
