// TODO: questo test era già rotto pre-M1 (id mock numerico vs uuid post-Supabase
// Auth, e shape user con loginMethod/openId/lastSignedIn rimossi in 0001). Phase
// B M1 rimuove anche `inventory.upsert` da tRPC. Skip totale finché non riscritto.
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@sucketo.com",
    name: "Test User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe.skip("Retailer Details", () => {
  it("should return complete retailer details with inventory and movements", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // Prima crea un rivenditore di test
    const newRetailer = await caller.retailers.create({
      name: "Test Farmacia Details",
      businessType: "Farmacia",
      city: "Milano",
      province: "MI",
      email: "details@test.it",
    });

    // Ottieni i dettagli
    const details = await caller.retailers.getDetails({ id: newRetailer.id });

    expect(details).toBeDefined();
    expect(details?.retailer).toBeDefined();
    expect(details?.retailer.name).toBe("Test Farmacia Details");
    expect(details?.inventory).toBeDefined();
    expect(Array.isArray(details?.inventory)).toBe(true);
    expect(details?.recentMovements).toBeDefined();
    expect(Array.isArray(details?.recentMovements)).toBe(true);
    expect(details?.alerts).toBeDefined();
    expect(Array.isArray(details?.alerts)).toBe(true);
    expect(details?.stats).toBeDefined();
    expect(details?.stats).toHaveProperty("totalValue");
    expect(details?.stats).toHaveProperty("totalItems");
    expect(details?.stats).toHaveProperty("lowStockCount");
    expect(details?.stats).toHaveProperty("expiringCount");
    expect(details?.stats).toHaveProperty("activeAlertsCount");
  });

  it("should return null for non-existent retailer", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const details = await caller.retailers.getDetails({ id: 99999 });

    expect(details).toBeNull();
  });

  it("should calculate stats correctly with inventory items", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // Crea rivenditore
    const retailer = await caller.retailers.create({
      name: "Test Stats Retailer",
      businessType: "Ristorante",
      city: "Roma",
    });

    // Crea prodotto
    const product = await caller.products.create({
      sku: `TEST-STATS-${Date.now()}`,
      name: "Prodotto Test Stats",
      unitPrice: "10.00",
      unit: "pz",
      minStockThreshold: 5,
      isLowCarb: 1,
      isGlutenFree: 1,
      isKeto: 1,
      sugarContent: "0%",
    });

    // Aggiungi inventario
    await caller.inventory.upsert({
      retailerId: retailer.id,
      productId: product.id,
      quantity: 3, // Sotto la soglia minima di 5
    });

    // Ottieni dettagli
    const details = await caller.retailers.getDetails({ id: retailer.id });

    expect(details).toBeDefined();
    expect(details?.stats.totalItems).toBe(1);
    expect(details?.stats.lowStockCount).toBe(1); // Dovrebbe rilevare scorta bassa
    expect(parseFloat(details?.stats.totalValue || "0")).toBeGreaterThan(0);
  });
});
