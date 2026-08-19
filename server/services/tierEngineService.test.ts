import { describe, expect, it } from "vitest";
import { isMonthlyTierEvaluationDate } from "./tierEngineService";

describe("isMonthlyTierEvaluationDate", () => {
  it("consente l'esecuzione solo il primo giorno del mese in UTC", () => {
    expect(isMonthlyTierEvaluationDate(new Date("2026-09-01T05:00:00.000Z"))).toBe(true);
    expect(isMonthlyTierEvaluationDate(new Date("2026-09-02T05:00:00.000Z"))).toBe(false);
  });
});
