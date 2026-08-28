import { describe, expect, it } from "vitest";
import { buildProspectOrderNotification } from "./prospectNotificationService";

describe("buildProspectOrderNotification", () => {
  it("usa esclusivamente la terminologia ordine nella notifica esterna", () => {
    const message = buildProspectOrderNotification({
      simulationId: "test-order-id",
      legalName: "Rivenditore Test Srl",
      contactName: "Anna Test",
      email: "anna@example.test",
      phone: "3330000000",
      businessType: "Negozio",
      city: "Milano",
      vatNumber: "12345678901",
      listSubtotalNet: "790.00",
      reachedTierName: "Premium",
      itemCount: 3,
    });

    expect(message.subject).toBe("Nuovo ordine prospect — Rivenditore Test Srl");
    expect(message.html).toContain("<h1 style=\"margin:0 0 18px;font-size:22px\">Nuovo ordine</h1>");
    expect(message.html).toContain("È stato salvato un nuovo ordine.");
    expect(message.html).toContain("Fascia sconto");
    expect(message.html).not.toMatch(/simulazione|simulatore|nuova richiesta|fascia simulata/i);
  });
});
