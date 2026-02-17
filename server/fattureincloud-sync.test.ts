import { describe, expect, it, vi, beforeEach } from "vitest";
import { getOAuthConfig, isTokenExpired } from "./fattureincloud-oauth";

describe("Fatture in Cloud OAuth", () => {
  beforeEach(() => {
    // Reset environment variables
    delete process.env.FATTUREINCLOUD_CLIENT_ID;
    delete process.env.FATTUREINCLOUD_CLIENT_SECRET;
    delete process.env.FATTUREINCLOUD_REDIRECT_URI;
  });

  it("should return null when OAuth config is missing", () => {
    const config = getOAuthConfig();
    expect(config).toBeNull();
  });

  it("should return config when environment variables are set", () => {
    process.env.FATTUREINCLOUD_CLIENT_ID = "test-client-id";
    process.env.FATTUREINCLOUD_CLIENT_SECRET = "test-client-secret";
    process.env.FATTUREINCLOUD_REDIRECT_URI = "https://example.com/callback";

    const config = getOAuthConfig();
    
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-client-id");
    expect(config?.clientSecret).toBe("test-client-secret");
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("should detect expired token", () => {
    const expiredDate = new Date();
    expiredDate.setMinutes(expiredDate.getMinutes() - 10); // 10 minuti fa

    expect(isTokenExpired(expiredDate)).toBe(true);
  });

  it("should detect token expiring soon (within buffer)", () => {
    const soonExpiring = new Date();
    soonExpiring.setMinutes(soonExpiring.getMinutes() + 3); // 3 minuti (dentro buffer di 5 minuti)

    expect(isTokenExpired(soonExpiring)).toBe(true);
  });

  it("should detect valid token", () => {
    const validDate = new Date();
    validDate.setMinutes(validDate.getMinutes() + 30); // 30 minuti

    expect(isTokenExpired(validDate)).toBe(false);
  });
});

describe("Fatture in Cloud API Mapping", () => {
  it("should map FIC product to internal format", async () => {
    const { mapFICProductToInternal } = await import("./fattureincloud-api");

    const ficProduct = {
      id: 123,
      code: "TEST-001",
      name: "Prodotto Test",
      description: "Descrizione test",
      category: "Pane",
      net_price: 5.99,
      measure_unit: "pz",
      stock: {
        current: 50,
      },
    };

    const mapped = mapFICProductToInternal(ficProduct);

    expect(mapped.sku).toBe("TEST-001");
    expect(mapped.name).toBe("Prodotto Test");
    expect(mapped.description).toBe("Descrizione test");
    expect(mapped.category).toBe("Pane");
    expect(mapped.unitPrice).toBe("5.99");
    expect(mapped.unit).toBe("pz");
    expect(mapped.fattureInCloudId).toBe("123");
  });

  it("should use fallback SKU when code is missing", async () => {
    const { mapFICProductToInternal } = await import("./fattureincloud-api");

    const ficProduct = {
      id: 456,
      code: "",
      name: "Prodotto Senza Codice",
    };

    const mapped = mapFICProductToInternal(ficProduct);

    expect(mapped.sku).toBe("FIC-456");
  });

  it("should extract stock movements from documents", async () => {
    const { extractStockMovementsFromDocuments } = await import("./fattureincloud-api");

    const documents = [
      {
        id: 1,
        type: "invoice",
        numeration: "FAT-001",
        date: "2024-01-15",
        items: [
          {
            id: 1,
            product_id: 10,
            code: "PROD-001",
            name: "Prodotto 1",
            quantity: 5,
          },
        ],
      },
      {
        id: 2,
        type: "delivery_note_in",
        numeration: "DDT-002",
        date: "2024-01-16",
        items: [
          {
            id: 2,
            product_id: 11,
            code: "PROD-002",
            name: "Prodotto 2",
            quantity: 10,
          },
        ],
      },
    ];

    const movements = extractStockMovementsFromDocuments(documents, 1);

    expect(movements).toHaveLength(2);
    
    // Fattura = uscita
    expect(movements[0]?.type).toBe("OUT");
    expect(movements[0]?.productCode).toBe("PROD-001");
    expect(movements[0]?.quantity).toBe(5);
    expect(movements[0]?.documentNumber).toBe("FAT-001");

    // DDT in entrata = entrata
    expect(movements[1]?.type).toBe("IN");
    expect(movements[1]?.productCode).toBe("PROD-002");
    expect(movements[1]?.quantity).toBe(10);
    expect(movements[1]?.documentNumber).toBe("DDT-002");
  });
});
