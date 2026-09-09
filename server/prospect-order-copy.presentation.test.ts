import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicPage = readFileSync(fileURLToPath(new URL("../client/src/pages/InvitedRetailerOrder.tsx", import.meta.url)), "utf8");
const notification = readFileSync(fileURLToPath(new URL("./services/prospectNotificationService.ts", import.meta.url)), "utf8");

describe("copy modulo ordine prospect", () => {
  it("usa la formulazione configura per pagina, browser, email e istruzioni di consegna", () => {
    expect(publicPage).toContain("Configura il tuo ordine SoKeto");
    expect(publicPage).toContain('document.title = "Configura il tuo ordine SoKeto"');
    expect(publicPage).toContain("inserisci quelli mancanti");
    expect(notification).toContain("Configura il tuo ordine SoKeto");
    expect(publicPage).not.toContain("Completa il tuo ordine SoKeto");
    expect(notification).not.toContain("Completa il tuo ordine SoKeto");
  });
});
