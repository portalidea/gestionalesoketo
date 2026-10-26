import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("prospect service package form presentation", () => {
  it("usa etichette chiare, nasconde il codice tecnico e mostra il riepilogo dinamico", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/ProspectPromotions.tsx"), "utf8");

    expect(source).toContain("Pacchetto assegnato al cliente");
    expect(source).toContain("Il cliente riceverà questo livello di prezzo, anche per gli ordini successivi.");
    expect(source).toContain("Servizio incluso");
    expect(source).toContain("Prezzo del servizio, IVA esclusa");
    expect(source).toContain("Valore minimo prodotti, IVA esclusa");
    expect(source).toContain("Il cliente non può confermare l’ordine sotto questa cifra. Sopra paga i prodotti in più.");
    expect(source).toContain("Prodotti omaggio a prezzo al pubblico");
    expect(source).toContain("Se paga entro il");
    expect(source).toContain("Riepilogo per il cliente");
    expect(source).toContain("Il cliente paga:");
    expect(source).toContain("Il codice tecnico del servizio è creato automaticamente");
    expect(source).not.toContain("Codice servizio *</Label>");
  });
});
