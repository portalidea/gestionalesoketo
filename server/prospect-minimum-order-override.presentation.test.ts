import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("prospect minimum order override presentation", () => {
  it("mostra una deroga esplicita, richiede la motivazione e marca le conversioni già derogate", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/ProspectSimulations.tsx"), "utf8");
    expect(source).toContain("Approva comunque, in deroga al minimo d’ordine.");
    expect(source).toContain("Motivazione obbligatoria della deroga");
    expect(source).toContain("minimumOrderOverrideReason");
    expect(source).toContain("Conversione in deroga al minimo d’ordine.");
    expect(source).toContain("Deroga minimo");
  });
});
