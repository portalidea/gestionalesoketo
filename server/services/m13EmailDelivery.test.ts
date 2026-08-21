import { describe, expect, it } from "vitest";
import { isM13RealDeliveryEnabled } from "./m13EmailDelivery";

describe("isM13RealDeliveryEnabled", () => {
  it("è disabilitato per default", () => {
    expect(isM13RealDeliveryEnabled({})).toBe(false);
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "false" })).toBe(false);
  });

  it("richiede il valore esplicito true", () => {
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "true" })).toBe(true);
    expect(isM13RealDeliveryEnabled({ M13_EMAIL_DELIVERY_ENABLED: "TRUE" })).toBe(false);
  });
});
