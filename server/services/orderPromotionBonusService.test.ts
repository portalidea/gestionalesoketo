import { describe, expect, it } from "vitest";
import { _private } from "./orderPromotionBonusService";

describe("promotion bonus payment deadline", () => {
  it("confronta la data paidAt in Europe/Rome, non il momento della registrazione", () => {
    const paidAt = new Date("2026-10-31T22:30:00.000Z"); // 23:30 Europe/Rome
    expect(_private.romeDate(paidAt)).toBe("2026-10-31");
    expect(_private.isWithinDeadline(paidAt, "2026-10-31")).toBe(true);
  });

  it("non concede il bonus se paidAt cade dopo la deadline in Europe/Rome", () => {
    const paidAt = new Date("2026-10-31T23:30:00.000Z"); // 00:30 Europe/Rome del 1 novembre
    expect(_private.romeDate(paidAt)).toBe("2026-11-01");
    expect(_private.isWithinDeadline(paidAt, "2026-10-31")).toBe(false);
  });

  it("risolve il package post-esaurimento dai codici prospect indipendentemente dal maiuscolo/minuscolo", () => {
    expect(_private.prospectTierPackageName("premium")).toBe("Premium");
    expect(_private.prospectTierPackageName("ELITE")).toBe("Elite");
    expect(() => _private.prospectTierPackageName("Special")).toThrow("non valido");
  });
});
