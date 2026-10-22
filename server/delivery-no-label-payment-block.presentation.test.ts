import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("consegna senza blocchi etichette e pagamento — presentazione", () => {
  it("rende visibili il saldo etichette negativo e il badge Da incassare", () => {
    const labels = readFileSync(resolve(process.cwd(), "client/src/pages/Labels.tsx"), "utf8");
    const orderDetail = readFileSync(resolve(process.cwd(), "client/src/pages/OrderDetail.tsx"), "utf8");
    const orders = readFileSync(resolve(process.cwd(), "client/src/pages/Orders.tsx"), "utf8");

    expect(labels).toContain('status: "normal" | "low" | "critical" | "negative"');
    expect(labels).toContain('case "negative"');
    expect(labels).toContain("Etichette sotto zero per ${product.name}: aggiornare la giacenza");

    expect(orderDetail).toContain("const canConfirmDelivery = !order.eventType");
    expect(orderDetail).toContain("&& !isDelivered;");
    expect(orderDetail).toContain('label: "Da incassare"');
    expect(orderDetail).toContain("Etichette sotto zero per ${warning.productName}: aggiornare la giacenza");

    expect(orders).toContain('order.status === "delivered" && (order as any).paymentStatus === "unpaid"');
    expect(orders).toContain('{ label: "Da incassare", variant: "outline" as const }');
  });
});
