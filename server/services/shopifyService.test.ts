import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVariantSyncOutcome } from "./channelVariantService";
import { ShopifyClient } from "./shopifyService";

function product(id: number) {
  return {
    id,
    title: `Prodotto ${id}`,
    variants: [{ id: id * 10, product_id: id, title: "Default", sku: `SKU-${id}`, price: "10.00" }],
  };
}

function response(products: unknown[], link: string | null) {
  return new Response(JSON.stringify({ products }), { status: 200, headers: link ? { Link: link } : {} });
}

afterEach(() => vi.unstubAllGlobals());

describe("ShopifyClient.fetchAllProducts pagination", () => {
  it('continua con rel="next" tra virgolette', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([product(1)], '<https://test.myshopify.com/admin/api/2024-10/products.json?page_info=quotedCursor&limit=250>; rel="next"'))
      .mockResolvedValueOnce(response([product(2)], null));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ShopifyClient("test.myshopify.com", "token").fetchAllProducts();
    expect(result.pagesFetched).toBe(2);
    expect(result.productsFetched).toBe(2);
    expect(result.variantsFetched).toBe(2);
    expect(result.possiblyTruncated).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toContain("page_info=quotedCursor");
  });

  it("continua con rel=next senza virgolette", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([product(1)], '<https://test.myshopify.com/admin/api/2024-10/products.json?page_info=plainCursor&limit=250>; rel=next'))
      .mockResolvedValueOnce(response([product(2)], null));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ShopifyClient("test.myshopify.com", "token").fetchAllProducts();
    expect(result.pagesFetched).toBe(2);
    expect(result.productsFetched).toBe(2);
    expect(result.variantsFetched).toBe(2);
    expect(result.possiblyTruncated).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toContain("page_info=plainCursor");
  });

  it("una pagina piena senza header produce un esito partial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(Array.from({ length: 250 }, (_, index) => product(index + 1)), null)));
    const catalog = await new ShopifyClient("test.myshopify.com", "token").fetchAllProducts();
    const outcome = resolveVariantSyncOutcome([], catalog.paginationError);
    expect(catalog.pagesFetched).toBe(1);
    expect(catalog.productsFetched).toBe(250);
    expect(catalog.possiblyTruncated).toBe(true);
    expect(outcome.status).toBe("partial");
    expect(outcome.errors[0]).toMatch(/pagina 1 piena/i);
  });

  it("una pagina parziale senza header produce un esito completed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([product(1), product(2)], null)));
    const catalog = await new ShopifyClient("test.myshopify.com", "token").fetchAllProducts();
    const outcome = resolveVariantSyncOutcome([], catalog.paginationError);
    expect(catalog.pagesFetched).toBe(1);
    expect(catalog.productsFetched).toBe(2);
    expect(catalog.possiblyTruncated).toBe(false);
    expect(outcome.status).toBe("completed");
    expect(outcome.errors).toEqual([]);
  });
});
