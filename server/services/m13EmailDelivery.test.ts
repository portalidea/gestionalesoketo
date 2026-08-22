import { describe, expect, it } from "vitest";
import { isM13RealDeliveryEnabled, renderM13AlignmentEmail } from "./m13EmailDelivery";

describe("isM13RealDeliveryEnabled", () => {
  it("è disabilitato per default", () => {
    expect(isM13RealDeliveryEnabled({})).toBe(false);
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "false" })).toBe(false);
  });

  it("richiede il valore esplicito true", () => {
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "true" })).toBe(true);
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "TRUE" })).toBe(false);
  });

  it("rende HTML e testo alignment con quantità in confezioni e pezzi", () => {
    const rendered = renderM13AlignmentEmail({
      retailerName: "Rivenditore Test",
      responseUrl: "https://preview.example/scadenze/token-test",
      items: [{ productName: "Biscotto Keto", batchCode: "B-123", expiryDate: "2026-12-31", quantityPieces: 50, piecesPerUnit: 6 }],
    });
    expect(rendered.subject).toBe("Verifica giacenze SoKeto — ci serve il tuo riscontro");
    expect(rendered.html).toContain("#2D5A27");
    expect(rendered.html).toContain("#7AB648");
    expect(rendered.html).toContain("8 confezioni + 2 pz (50 pz)");
    expect(rendered.html).toContain("VERIFICA LE TUE GIACENZE");
    expect(rendered.text).toContain("8 confezioni + 2 pz (50 pz)");
    expect(rendered.text).toContain("https://preview.example/scadenze/token-test");
  });
});
