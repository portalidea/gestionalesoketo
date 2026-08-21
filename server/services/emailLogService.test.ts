import { describe, expect, it } from "vitest";
import { buildM13IdempotencyKey } from "./emailLogService";

describe("buildM13IdempotencyKey", () => {
  const companyId = "00000000-0000-0000-0000-000000000001";
  const retailerId = "00000000-0000-0000-0000-000000000002";

  it("usa la finestra period_start per alert", () => {
    expect(buildM13IdempotencyKey({ mode: "alert", companyId, periodStart: "2026-09-01", retailerId }))
      .toBe(`m13:alert:${companyId}:2026-09-01:${retailerId}`);
  });

  it("usa run_date per alignment", () => {
    expect(buildM13IdempotencyKey({ mode: "alignment", companyId, runDate: "2026-09-01", retailerId }))
      .toBe(`m13:alignment:${companyId}:2026-09-01:${retailerId}`);
  });

  it("non include un retailer nella chiave internal", () => {
    expect(buildM13IdempotencyKey({ mode: "internal", companyId, periodStart: "2026-09-01" }))
      .toBe(`m13:internal:${companyId}:2026-09-01`);
  });

  it("rifiuta una chiave non deterministica priva della finestra richiesta", () => {
    expect(() => buildM13IdempotencyKey({ mode: "alert", companyId, retailerId })).toThrow("periodStart");
    expect(() => buildM13IdempotencyKey({ mode: "alignment", companyId, retailerId })).toThrow("runDate");
  });
});
