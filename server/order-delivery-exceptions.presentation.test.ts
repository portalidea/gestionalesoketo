import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(resolve(process.cwd(), "client/src/pages/OrderDetail.tsx"), "utf8");
const report = readFileSync(resolve(process.cwd(), "client/src/pages/reports/FulfillmentExceptionsReport.tsx"), "utf8");
const reportsRouter = readFileSync(resolve(process.cwd(), "server/reports-router.ts"), "utf8");

describe("presentazione eccezioni evasione", () => {
  it("mostra lotto, doppia giacenza, tre opzioni e motivo nel dialog", () => {
    expect(page).toContain("Lotto originale");
    expect(page).toContain("Giacenza lotto");
    expect(page).toContain("Giacenza prodotto");
    expect(page).toContain("A — Rialloca e scarica");
    expect(page).toContain("B — Evasa senza scarico");
    expect(page).toContain("C — Scarica il disponibile, resto senza scarico");
    expect(page).toContain("item.partialNoStockMovement.stockMovementQuantityPieces");
    expect(page).toContain("item.partialNoStockMovement.noStockMovementQuantityPieces");
    expect(page).toContain("Motivo obbligatorio");
  });

  it("spiega che B richiede prodotto a zero e C accetta il lotto originale a zero", () => {
    expect(page).toContain("richiede giacenza del prodotto a zero nel centrale");
    expect(page).toContain("giacenza del prodotto positiva ma insufficiente nel centrale; il lotto originale può essere a zero");
    expect(page).not.toContain("richiede lotto originario con giacenza positiva");
  });

  it("nasconde operativamente le opzioni agli utenti non admin e usa l’endpoint dedicato", () => {
    expect(page).toContain('const isAdmin = user?.role === "admin"');
    expect(page).toContain("disabled={!isAdmin || !item.reallocated.available}");
    expect(page).toContain("disabled={!isAdmin || !item.noStockMovement.available}");
    expect(page).toContain("disabled={!isAdmin || !item.partialNoStockMovement.available}");
    expect(page).toContain("confirmOrderDeliveryWithExceptions.mutate");
    expect(page).toContain("(isAdmin && areDeliveryExceptionsComplete)");
  });

  it("richiede una scelta applicabile e un motivo per tutte le righe, anche per C", () => {
    expect(page).toContain('reason: deliveryExceptionSelections[item.orderItemId]?.reason?.trim() ?? ""');
    expect(page).toContain("exceptionPayload.every((selection, index) => {");
    expect(page).toContain('selection.exceptionType === "partial_no_stock_movement"');
    expect(page).toContain("return selectedOptionAvailable && selection.reason.length > 0;");
    expect(page).toContain("disabled={!isAdmin || !selected.exceptionType}");
    expect(page).toMatch(/const noOptionAvailable = !item\.reallocated\.available\s*&& !item\.noStockMovement\.available\s*&& !item\.partialNoStockMovement\.available;/);
    expect(page).toContain("{noOptionAvailable && (");
  });

  it("mostra l’avviso travaso sopra le opzioni senza impedire la scelta C", () => {
    const warning = page.indexOf("{item.counterpartyAvailability.canTransferForReallocation && (");
    const optionA = page.indexOf("A — Rialloca e scarica");
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(optionA);
    expect(page).toContain("Disponibili {item.counterpartyAvailability.quantityPieces} pz su {item.counterpartyAvailability.companyName}: puoi fare un travaso e usare l’opzione A");
    expect(page).toContain("disabled={!isAdmin || !item.partialNoStockMovement.available}");
    expect(page).not.toMatch(/disabled=\{[^}]*counterpartyAvailability/);
  });

  it("espone il report interno filtrabile per tre tipi e periodo, con quantità effettive", () => {
    expect(report).toContain("Righe evase con eccezione");
    expect(report).toContain("Riallocata e scaricata");
    expect(report).toContain("Evasa senza scarico");
    expect(report).toContain('<SelectItem value="partial_no_stock_movement">Scarico parziale, resto senza scarico</SelectItem>');
    expect(report).toContain("Pezzi scaricati");
    expect(report).toContain("Pezzi senza scarico");
    expect(report).toContain("item.stockMovementQuantityPieces");
    expect(report).toContain("item.noStockMovementQuantityPieces");
    expect(report).toContain("replacementAllocations");
    expect(report).toMatch(/item\.exceptionType === "partial_no_stock_movement"\s*\? `\$\{allocation\.quantityPieces \?\? 0\} pz scaricati`/);
    expect(report).toContain("colSpan={10}");
  });

  it("mantiene il fallback delle quantità per lo storico A/B nel report company-scoped", () => {
    expect(reportsRouter).toContain('exceptionType: z.enum(["reallocated", "no_stock_movement", "partial_no_stock_movement"]).optional()');
    expect(reportsRouter).toMatch(/COALESCE\(e\."stockMovementQuantityPieces",\s*CASE WHEN e\."exceptionType" = 'reallocated' THEN e\."quantityPieces" ELSE 0 END\s*\) AS "stockMovementQuantityPieces"/);
    expect(reportsRouter).toMatch(/COALESCE\(e\."noStockMovementQuantityPieces",\s*CASE WHEN e\."exceptionType" = 'no_stock_movement' THEN e\."quantityPieces" ELSE 0 END\s*\) AS "noStockMovementQuantityPieces"/);
    expect(reportsRouter).toContain('WHERE e."companyId" = ${ctx.activeCompanyId}::uuid');
  });
});
