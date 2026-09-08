import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../client/src/pages/InvitedRetailerOrder.tsx", import.meta.url)), "utf8");

describe("InvitedRetailerOrder header", () => {
  it("mostra il logo SoKeto tramite l’asset persistente e con dimensioni responsive", () => {
    expect(source).toContain('src="/manus-storage/soketo-logo-orizzontale-trasparente_5af829a6.png"');
    expect(source).toContain('alt="Logo SoKeto"');
    expect(source).toContain("sm:h-14");
  });
});
