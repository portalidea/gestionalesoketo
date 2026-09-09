import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("prospect composition session presentation", () => {
  it("S10: il carrello adotta debounce di cinque secondi e ignora gli errori di persistenza", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/InvitedRetailerOrder.tsx"), "utf8");
    expect(source).toContain("}, 5_000)");
    expect(source).toContain(".catch(() => undefined)");
    expect(source).toContain("Le composizioni del carrello vengono registrate per finalità di assistenza commerciale.");
    expect(source).toContain("compositionSessionId: compositionSessionId ?? undefined");
  });
});
