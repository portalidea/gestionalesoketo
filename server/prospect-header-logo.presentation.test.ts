import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../client/src/pages/InvitedRetailerOrder.tsx", import.meta.url)), "utf8");

describe("InvitedRetailerOrder header", () => {
  it("mostra il logo SoKeto tramite il CDN verificato e con dimensioni responsive", () => {
    expect(source).toContain('src="https://files.manuscdn.com/user_upload_by_module/session_file/310519663080651282/NuGrzBuQvxAhrWjh.png"');
    expect(source).toContain('alt="Logo SoKeto"');
    expect(source).toContain("sm:h-14");
  });
});
