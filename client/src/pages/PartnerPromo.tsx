/**
 * Portale partner — "Promo e Card": borsellino del Programma Partner SoKeto.
 */
import PartnerLayout from "@/components/PartnerLayout";
import { PartnerProgramPanel } from "@/components/PartnerProgramPanel";

export default function PartnerPromo() {
  return (
    <PartnerLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Promo e Card</h1>
          <p className="text-muted-foreground">
            Sconti fatti con l'app SoKeto, buoni SoKeto Card e credito che ti riconosciamo sul prossimo ordine.
          </p>
        </div>
        <PartnerProgramPanel mode={{ kind: "mine" }} />
      </div>
    </PartnerLayout>
  );
}
