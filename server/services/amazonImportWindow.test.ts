import { describe, expect, it } from "vitest";
import { amazonCutoffMidnightUtc, buildAmazonImportWindow } from "./amazonImportWindow";

describe("finestre Amazon con cutoff acquisto Europe/Rome", () => {
  it.each([
    ["2026-09-01", "2026-08-31T22:00:00.000Z"],
    ["2026-03-29", "2026-03-28T23:00:00.000Z"],
    ["2026-03-30", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "2026-10-24T22:00:00.000Z"],
    ["2026-10-26", "2026-10-25T23:00:00.000Z"],
  ])("mezzanotte %s non perde le prime ore della data acquisto", (day, utc) => {
    expect(amazonCutoffMidnightUtc(day).toISOString()).toBe(utc);
  });
  it("il primo recupero parte dal cutoff ed è limitato a 30 giorni", () => {
    const window = buildAmazonImportWindow("2026-09-01", null, new Date("2026-11-05T20:00:00Z"));
    expect(window.start.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-09-30T22:00:00.000Z");
  });
  it("riparte dal checkpoint con sovrapposizione senza perdere il fermo", () => {
    const window = buildAmazonImportWindow("2026-09-01", new Date("2026-09-30T22:00:00Z"), new Date("2026-11-05T20:00:00Z"));
    expect(window.start.toISOString()).toBe("2026-09-28T22:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-10-28T22:00:00.000Z");
  });
  it("non estende una finestra oltre il momento presente", () => {
    const now = new Date("2026-11-05T20:00:00Z");
    expect(buildAmazonImportWindow("2026-09-01", new Date("2026-11-04T20:00:00Z"), now).end).toEqual(now);
  });
  it.each(["2026-02-30", "01/09/2026", "2026-13-01"])("rifiuta il cutoff non valido %s", value => {
    expect(() => amazonCutoffMidnightUtc(value)).toThrow();
  });
  it("non crea una richiesta per un cutoff futuro", () => {
    expect(() => buildAmazonImportWindow("2027-09-01", null, new Date("2026-11-05T20:00:00Z"))).toThrow();
  });
});
