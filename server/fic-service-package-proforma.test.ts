import { describe, expect, it } from "vitest";
import { buildFicProformaPayload } from "./fic-integration";

describe("proforma FiC per pacchetto prospect", () => {
  it("mantiene merce al 10% e servizio al 22% come righe e riepiloghi IVA distinti", () => {
    const payload = buildFicProformaPayload({
      ficClientId: 123,
      date: "2026-10-31",
      notesInternal: "Fixture isolata: nessuna chiamata FiC.",
      orderNumber: "TEST-SERVICE-890",
      items: [
        { kind: "merchandise", code: "PROD-10", name: "Prodotto Premium", description: "Merce", qty: 1, unitPriceFinal: "690.00", vatRate: "10.00" },
        { kind: "service", name: "Pubblicità localizzata", description: "Pubblicità localizzata", qty: 1, unitPriceFinal: "200.00", vatRate: "22.00" },
      ],
    }, [{ id: 10, value: 10 }, { id: 22, value: 22 }], [{ id: 1, name: "Bonifico", is_default: true }], { id: 123, name: "Cliente test" });

    expect(payload.data.items_list).toEqual([
      expect.objectContaining({ code: "PROD-10", name: "Prodotto Premium", qty: 1, net_price: 690, vat: { id: 10 } }),
      expect.objectContaining({ name: "Pubblicità localizzata", description: "Servizio non inventariato", qty: 1, net_price: 200, vat: { id: 22 } }),
    ]);
    expect(payload.data.items_list[1]).not.toHaveProperty("code");
    expect(payload.data.payments_list[0]?.amount).toBe(1003);
  });
});
