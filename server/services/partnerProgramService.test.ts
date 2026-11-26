import { describe, expect, it } from "vitest";
import {
  addMonths,
  computeStatementAmounts,
  creditValidUntil,
  grossToNet,
  netToGross,
  partnerExportSchema,
  planWalletApplication,
  romeMidnightUtc,
  romeMonthStart,
  romeToday,
} from "./partnerProgramService";

describe("partnerProgramService — importi", () => {
  it("scorpora l'IVA al 10%: 15 € lordi diventano 13,64 € e tornano 15 €", () => {
    expect(grossToNet("15.00", "10.00")).toBe("13.64");
    expect(netToGross("-13.64", "10.00")).toBe("-15.00");
    expect(netToGross("13.64", "10.00")).toBe("15.00");
  });

  it("calcola l'estratto con credito, contributo e rettifiche tardive", () => {
    expect(computeStatementAmounts({
      creditGross: "100.00",
      contributionGross: "25.00",
      lateCancelledCreditGross: "10.00",
      lateCancelledContributionGross: "5.00",
      creditVatRate: "10.00",
      contributionVatRate: "10.00",
    })).toEqual({
      creditGross: "100.00",
      contributionGross: "20.00",
      adjustmentGross: "-10.00",
      creditNet: "81.82",
      contributionNet: "18.18",
    });
  });

  it("non va mai sotto zero con rettifiche più grandi del credito", () => {
    const r = computeStatementAmounts({
      creditGross: "5.00",
      contributionGross: "0",
      lateCancelledCreditGross: "8.00",
      lateCancelledContributionGross: "3.00",
      creditVatRate: "10.00",
      contributionVatRate: "22.00",
    });
    expect(r.creditNet).toBe("0.00");
    expect(r.contributionNet).toBe("0.00");
    expect(r.adjustmentGross).toBe("-8.00");
  });
});

describe("partnerProgramService — piano borsellino", () => {
  const st = (id: string, periodMonth: string, creditNet: string, contributionNet: string, creditApplied = "0", contributionCharged = "0") => ({
    id, periodMonth, creditNet, contributionNet, creditApplied, contributionCharged, creditVatRate: "10.00", contributionVatRate: "10.00",
  });

  it("scala il credito fino all'imponibile merce e addebita tutto il contributo", () => {
    const plan = planWalletApplication([st("a", "2026-11-01", "50.00", "4.00")], "30.00");
    expect(plan).toEqual([expect.objectContaining({ statementId: "a", creditNet: "30.00", contributionNet: "4.00" })]);
  });

  it("usa prima l'estratto più vecchio e tiene conto dell'utilizzo precedente", () => {
    const plan = planWalletApplication([
      st("dic", "2026-12-01", "20.00", "0.00"),
      st("nov", "2026-11-01", "15.00", "2.00", "10.00", "2.00"),
    ], "100.00");
    expect(plan.map((p) => [p.statementId, p.creditNet, p.contributionNet])).toEqual([
      ["nov", "5.00", "0.00"],
      ["dic", "20.00", "0.00"],
    ]);
  });

  it("con ordine a imponibile zero addebita solo il contributo", () => {
    const plan = planWalletApplication([st("a", "2026-11-01", "10.00", "1.50")], "0");
    expect(plan).toEqual([expect.objectContaining({ creditNet: "0.00", contributionNet: "1.50" })]);
  });

  it("salta gli estratti già esauriti", () => {
    expect(planWalletApplication([st("a", "2026-11-01", "10.00", "1.00", "10.00", "1.00")], "50")).toEqual([]);
  });
});

describe("partnerProgramService — date (Europe/Rome)", () => {
  it("il credito di novembre vale fino al 31 dicembre", () => {
    expect(creditValidUntil("2026-11-01")).toBe("2026-12-31");
    expect(creditValidUntil("2026-12-01")).toBe("2027-01-31");
    expect(creditValidUntil("2027-01-01")).toBe("2027-02-28");
  });

  it("gestisce i mesi e il fuso orario di Roma", () => {
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2027-01-01", -1)).toBe("2026-12-01");
    // 30/11 23:30 UTC = 1/12 00:30 a Roma
    expect(romeMonthStart(new Date("2026-11-30T23:30:00Z"))).toBe("2026-12-01");
    expect(romeToday(new Date("2026-11-30T22:59:00Z"))).toBe("2026-11-30");
    expect(romeMidnightUtc("2026-12-01").toISOString()).toBe("2026-11-30T23:00:00.000Z");
    expect(romeMidnightUtc("2026-07-01").toISOString()).toBe("2026-06-30T22:00:00.000Z");
  });
});

describe("partnerProgramService — export FoodApps4All", () => {
  it("valida il payload e normalizza gli importi", () => {
    const parsed = partnerExportSchema.parse({
      ok: true,
      stores: [{ store_id: "12", name: "Point Forlì", city: "Forlì" }],
      events: [{
        source: "coupon", source_id: 4512, store_id: 12, occurred_at: "2026-11-21T17:42:10+01:00",
        label: "BLACK15", campaign_key: "black_friday",
        purchase_gross: "100", discount_gross: 15, credit_gross: "7.5", contribution_gross: "0.00", cancelled_at: null,
      }],
    });
    expect(parsed.events[0].credit_gross).toBe("7.50");
    expect(parsed.stores[0].store_id).toBe(12);
  });

  it("rifiuta importi negativi e sorgenti sconosciute", () => {
    const base = { source: "coupon", source_id: 1, store_id: 1, occurred_at: "2026-11-21T00:00:00Z", purchase_gross: 1, discount_gross: 1, credit_gross: 1, contribution_gross: 0 };
    expect(() => partnerExportSchema.parse({ ok: true, stores: [], events: [{ ...base, credit_gross: -1 }] })).toThrow();
    expect(() => partnerExportSchema.parse({ ok: true, stores: [], events: [{ ...base, source: "altro" }] })).toThrow();
  });
});
