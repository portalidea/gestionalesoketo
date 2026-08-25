import { describe, expect, it } from "vitest";
import { isM13RealDeliveryEnabled, renderM13PlainText } from "./m13EmailDelivery";

describe("isM13RealDeliveryEnabled", () => {
  it("è disabilitato per default", () => {
    expect(isM13RealDeliveryEnabled({})).toBe(false);
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "false" })).toBe(false);
  });

  it("richiede il valore esplicito true", () => {
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "true" })).toBe(true);
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "TRUE" })).toBe(false);
  });

  it("formatta il testo delle righe alert in confezioni e pezzi", () => {
    const rendered = renderM13PlainText({
      introText: "Test alert scadenze",
      items: [{ productName: "Biscotto Keto", batchCode: "B-123", expiryDate: "2026-12-31", quantityPieces: 50, piecesPerUnit: 6 }],
    });
    expect(rendered).toContain("Test alert scadenze");
    expect(rendered).toContain("8 confezioni + 2 pz (50 pz)");
    expect(rendered).toContain("lotto B-123");
  });
});
