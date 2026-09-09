import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../client/src/pages/InvitedRetailerOrder.tsx", import.meta.url)), "utf8");

describe("riepilogo e nomi prodotto nel modulo prospect", () => {
  it("mostra il riepilogo prima del catalogo solo con un risultato calcolato", () => {
    expect(source).toContain('<section className="flex flex-col">');
    expect(source).toContain('{result && <section className="order-1 mt-7">');
    expect(source).toContain('className="order-2 mt-5 overflow-hidden');
  });

  it("nasconde il sottotitolo tecnico in catalogo, tabella e schede mobile", () => {
    expect(source).toContain('[&>div>div:first-child>p:last-child]:hidden');
    expect(source).toContain('[&_tbody_td:first-child>span:last-child]:hidden');
    expect(source).toContain('[&_article>div:first-child>div>p:last-child]:hidden');
  });

  it("mantiene la rinomina del modulo in configura", () => {
    expect(source).toContain("Configura il tuo ordine SoKeto");
    expect(source).not.toContain("Completa il tuo ordine SoKeto");
  });
});

