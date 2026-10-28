import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(resolve(process.cwd(), "client/src/pages/OrderDetail.tsx"), "utf8");
const report = readFileSync(resolve(process.cwd(), "client/src/pages/reports/FulfillmentExceptionsReport.tsx"), "utf8");

describe("presentazione eccezioni evasione", () => {
  it("mostra lotto, doppia giacenza, opzioni e motivo nel dialog", () => {
    expect(page).toContain("Lotto originale");
    expect(page).toContain("Giacenza lotto");
    expect(page).toContain("Giacenza prodotto");
    expect(page).toContain("A — Rialloca e scarica");
    expect(page).toContain("B — Evasa senza scarico");
    expect(page).toContain("Motivo obbligatorio");
  });

  it("nasconde operativamente le opzioni agli utenti non admin e usa l’endpoint dedicato", () => {
    expect(page).toContain('const isAdmin = user?.role === "admin"');
    expect(page).toContain("disabled={!isAdmin || !item.reallocated.available}");
    expect(page).toContain("disabled={!isAdmin || !item.noStockMovement.available}");
    expect(page).toContain("confirmOrderDeliveryWithExceptions.mutate");
  });

  it("espone il report interno filtrabile per tipo e periodo", () => {
    expect(report).toContain("Righe evase con eccezione");
    expect(report).toContain("Riallocata e scaricata");
    expect(report).toContain("Evasa senza scarico");
    expect(report).toContain("replacementAllocations");
  });
});
