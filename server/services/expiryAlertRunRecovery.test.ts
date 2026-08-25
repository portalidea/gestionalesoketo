import { describe, expect, it } from "vitest";
import {
  STALE_EXPIRY_ALERT_RUN_TIMEOUT_MS,
  buildStaleExpiryAlertRunError,
  getStaleExpiryAlertRunCutoff,
} from "./expiryAlertRunRecovery";

describe("expiryAlertRunRecovery", () => {
  it("considera recuperabile un run solo oltre la soglia fissa di due ore", () => {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const cutoff = getStaleExpiryAlertRunCutoff(now);

    expect(STALE_EXPIRY_ALERT_RUN_TIMEOUT_MS).toBe(7_200_000);
    expect(cutoff.toISOString()).toBe("2026-08-21T08:00:00.000Z");
  });

  it("identifica nel messaggio l'unica company e finestra recuperate", () => {
    const message = buildStaleExpiryAlertRunError({
      companyId: "00000000-0000-0000-0000-000000000001",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });

    expect(message).toContain("oltre 2 ore");
    expect(message).toContain("00000000-0000-0000-0000-000000000001");
    expect(message).toContain("2026-08-01–2026-08-31");
  });
});
