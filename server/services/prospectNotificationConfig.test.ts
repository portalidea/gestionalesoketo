import { describe, expect, it } from "vitest";
import { getProspectNotificationRecipient } from "./prospectNotificationConfig";

describe("getProspectNotificationRecipient", () => {
  it("legge il destinatario prospect configurato senza esporlo", () => {
    expect(getProspectNotificationRecipient()).toMatch(/\S/);
  });

  it("rifiuta una configurazione assente", () => {
    expect(() => getProspectNotificationRecipient({})).toThrow("PROSPECT_NOTIFICATION_TO non è configurata");
  });
});
