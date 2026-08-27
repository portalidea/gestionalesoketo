/**
 * M8.1 — Shopify Admin API Client (REST)
 * Uses native fetch, no heavy SDKs.
 * Implements retry with exponential backoff on 429/500/502/503.
 * Hardened: safeParse, try/catch on .json(), structured error logging.
 */
import { z } from "zod";

const SHOPIFY_API_VERSION = "2024-10";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ─── Zod schemas ─────────────────────────────────────────────────────────────

export const ShopifyLineItemSchema = z.object({
  id: z.number(),
  sku: z.string().nullable().optional(),
  name: z.string(),
  quantity: z.number(),
  price: z.string(),
  product_id: z.number().nullable().optional(),
  variant_id: z.number().nullable().optional(),
});

export const ShopifyOrderSchema = z.object({
  id: z.number(),
  order_number: z.number(),
  name: z.string().optional(), // e.g. "#1001"
  email: z.string().nullable().optional(),
  customer: z
    .object({
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  created_at: z.string(),
  total_price: z.string(),
  currency: z.string(),
  financial_status: z.string(),
  fulfillment_status: z.string().nullable().optional(),
  shipping_address: z
    .object({
      country_code: z.string().optional(),
    })
    .nullable()
    .optional(),
  line_items: z.array(ShopifyLineItemSchema),
});

export type ShopifyOrder = z.infer<typeof ShopifyOrderSchema>;
export type ShopifyLineItem = z.infer<typeof ShopifyLineItemSchema>;

export const ShopifyVariantSchema = z.object({
  id: z.number(),
  product_id: z.number(),
  title: z.string(),
  sku: z.string().nullable().optional(),
  price: z.string(),
  inventory_item_id: z.number().nullable().optional(),
  inventory_quantity: z.number().nullable().optional(),
});

export const ShopifyProductSchema = z.object({
  id: z.number(),
  title: z.string(),
  variants: z.array(ShopifyVariantSchema),
});

export type ShopifyVariant = z.infer<typeof ShopifyVariantSchema>;
export type ShopifyProduct = z.infer<typeof ShopifyProductSchema>;

export interface ShopifyProductsFetchResult {
  products: ShopifyProduct[];
  pagesFetched: number;
  productsFetched: number;
  variantsFetched: number;
  invalidProducts: number;
  pageProductCounts: number[];
  possiblyTruncated: boolean;
  paginationError?: string;
}

/**
 * Estrae l'URL della pagina successiva dalla sintassi Link REST di Shopify.
 * Shopify può serializzare rel=next oppure rel="next"; l'URL deve essere
 * riutilizzato invariato perché page_info è un cursore opaco.
 */
export function parseShopifyNextPageUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  const nextMatch = linkHeader.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
  return nextMatch?.[1];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class ShopifyClient {
  private baseUrl: string;
  private accessToken: string;

  constructor(storeIdentifier: string, accessToken: string) {
    // storeIdentifier should be the myshopify.com domain e.g. "store-name.myshopify.com"
    const domain = storeIdentifier.includes(".")
      ? storeIdentifier
      : `${storeIdentifier}.myshopify.com`;
    this.baseUrl = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}`;
    this.accessToken = accessToken;
  }

  // ─── Public methods ──────────────────────────────────────────────────────

  /**
   * Test connection by fetching shop info.
   */
  async testConnection(): Promise<{ shopName: string; email: string }> {
    const data = await this.request<{ shop: { name: string; email: string } }>(
      "/shop.json",
    );
    console.log(`[shopifyClient.testConnection] OK: ${data.shop.name}`);
    return { shopName: data.shop.name, email: data.shop.email };
  }

  /**
   * Fetch orders with pagination (cursor-based via page_info).
   */
  async fetchOrders(params: {
    sinceId?: string;
    createdAtMin?: string;
    status?: "open" | "closed" | "cancelled" | "any";
    financialStatus?: "paid" | "pending" | "refunded" | "any";
    limit?: number;
  }): Promise<{ orders: ShopifyOrder[]; nextPageInfo?: string }> {
    const searchParams = new URLSearchParams();
    searchParams.set("limit", String(params.limit ?? 50));
    if (params.status) searchParams.set("status", params.status);
    if (params.financialStatus)
      searchParams.set("financial_status", params.financialStatus);
    if (params.createdAtMin)
      searchParams.set("created_at_min", params.createdAtMin);
    if (params.sinceId) searchParams.set("since_id", params.sinceId);

    const url = `/orders.json?${searchParams.toString()}`;
    console.log(`[shopifyClient.fetchOrders] GET ${url}`);

    const { data, linkHeader } = await this.requestWithHeaders<{
      orders: unknown[];
    }>(url);

    const orders: ShopifyOrder[] = [];
    for (const o of data.orders) {
      const parsed = ShopifyOrderSchema.safeParse(o);
      if (parsed.success) {
        orders.push(parsed.data);
      } else {
        console.warn(
          `[shopifyClient.fetchOrders] safeParse failed for order, skipping. Error: ${parsed.error.message}. Payload sample: ${JSON.stringify(o).slice(0, 500)}`,
        );
      }
    }

    const nextPageInfo = this.parseNextPageInfo(linkHeader);

    console.log(
      `[shopifyClient.fetchOrders] fetched ${orders.length} orders (${data.orders.length} raw), nextPage=${!!nextPageInfo}`,
    );
    return { orders, nextPageInfo };
  }

  /**
   * Fetch orders by page_info cursor (for pagination continuation).
   */
  async fetchOrdersByPageInfo(
    pageInfo: string,
    limit = 50,
  ): Promise<{ orders: ShopifyOrder[]; nextPageInfo?: string }> {
    const url = `/orders.json?page_info=${pageInfo}&limit=${limit}`;
    console.log(`[shopifyClient.fetchOrdersByPageInfo] GET ${url}`);

    const { data, linkHeader } = await this.requestWithHeaders<{
      orders: unknown[];
    }>(url);

    const orders: ShopifyOrder[] = [];
    for (const o of data.orders) {
      const parsed = ShopifyOrderSchema.safeParse(o);
      if (parsed.success) {
        orders.push(parsed.data);
      } else {
        console.warn(
          `[shopifyClient.fetchOrdersByPageInfo] safeParse failed, skipping. Error: ${parsed.error.message}. Payload sample: ${JSON.stringify(o).slice(0, 500)}`,
        );
      }
    }

    const nextPageInfo = this.parseNextPageInfo(linkHeader);
    return { orders, nextPageInfo };
  }

  /**
   * Fetch a single order by ID.
   */
  async fetchOrderById(orderId: string | number): Promise<ShopifyOrder> {
    const data = await this.request<{ order: unknown }>(
      `/orders/${orderId}.json`,
    );
    return ShopifyOrderSchema.parse(data.order);
  }

  /**
   * Update inventory level for a specific inventory item at a location.
   */
  async updateInventoryLevel(
    inventoryItemId: number,
    locationId: number,
    available: number,
  ): Promise<void> {
    console.log(
      `[shopifyClient.updateInventoryLevel] item=${inventoryItemId} location=${locationId} available=${available}`,
    );
    await this.request("/inventory_levels/set.json", {
      method: "POST",
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available,
      }),
    });
  }

  /**
   * Fetch all products with their variants (paginated, max 250 per page).
   * Uses safeParse for graceful error handling on malformed products.
   */
  async fetchAllProducts(): Promise<ShopifyProductsFetchResult> {
    const allProducts: ShopifyProduct[] = [];
    let url: string | null = "/products.json?limit=250&fields=id,title,variants";
    let pageCount = 0;
    let rawProductsFetched = 0;
    let variantsFetched = 0;
    let invalidProducts = 0;
    const pageProductCounts: number[] = [];
    let possiblyTruncated = false;
    let paginationError: string | undefined;

    while (url) {
      pageCount++;
      console.log(`[shopifyClient.fetchAllProducts] page=${pageCount} request=${url}`);

      const { data, linkHeader } = await this.requestWithHeaders<{
        products: unknown[];
      }>(url);

      const rawPageProducts = data.products.length;
      rawProductsFetched += rawPageProducts;
      pageProductCounts.push(rawPageProducts);
      let validPageProducts = 0;
      let pageVariants = 0;
      for (const p of data.products) {
        const parsed = ShopifyProductSchema.safeParse(p);
        if (parsed.success) {
          allProducts.push(parsed.data);
          validPageProducts++;
          pageVariants += parsed.data.variants.length;
        } else {
          invalidProducts++;
          console.warn(
            `[shopifyClient.fetchAllProducts] safeParse failed for product, skipping. Error: ${parsed.error.message}. Payload sample: ${JSON.stringify(p).slice(0, 500)}`,
          );
        }
      }
      variantsFetched += pageVariants;

      const nextPageUrl = parseShopifyNextPageUrl(linkHeader);
      if (!nextPageUrl && rawPageProducts === 250) {
        possiblyTruncated = true;
        paginationError = `Pagina ${pageCount} piena (250 prodotti) senza Link rel=next: catalogo potenzialmente incompleto.`;
        console.error(`[shopifyClient.fetchAllProducts] ${paginationError}`);
      }
      console.log(
        `[shopifyClient.fetchAllProducts] page=${pageCount} rawProducts=${rawPageProducts} validProducts=${validPageProducts} variants=${pageVariants} linkHeader=${linkHeader ? "present" : "absent"} nextPage=${nextPageUrl ? "detected" : "absent"}`,
      );
      url = nextPageUrl ?? null;

      // Pause 200ms between pages to avoid rate limit
      if (url) {
        await this.sleep(200);
      }
    }

    console.log(`[shopifyClient.fetchAllProducts] complete pages=${pageCount} rawProducts=${rawProductsFetched} validProducts=${allProducts.length} variants=${variantsFetched} invalidProducts=${invalidProducts} possiblyTruncated=${possiblyTruncated}`);
    return {
      products: allProducts,
      pagesFetched: pageCount,
      productsFetched: rawProductsFetched,
      variantsFetched,
      invalidProducts,
      pageProductCounts,
      possiblyTruncated,
      paginationError,
    };
  }

  /**
   * Fetch inventory locations for the store.
   */
  async fetchLocations(): Promise<
    Array<{ id: number; name: string; active: boolean }>
  > {
    const data = await this.request<{
      locations: Array<{ id: number; name: string; active: boolean }>;
    }>("/locations.json");
    return data.locations;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    options?: RequestInit,
  ): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(path, options);
    return data;
  }

  private async requestWithHeaders<T>(
    path: string,
    options?: RequestInit,
  ): Promise<{ data: T; linkHeader: string | null }> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            "X-Shopify-Access-Token": this.accessToken,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(options?.headers || {}),
          },
        });

        // Rate limit handling
        if (response.status === 429) {
          const retryAfter = parseFloat(
            response.headers.get("Retry-After") || "2",
          );
          const delay = retryAfter * 1000;
          console.warn(
            `[shopifyClient] 429 rate limited, waiting ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
          );
          await this.sleep(delay);
          continue;
        }

        // Retryable server errors
        if ([500, 502, 503].includes(response.status)) {
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            console.warn(
              `[shopifyClient] ${response.status} server error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
            );
            await this.sleep(delay);
            continue;
          }
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(
            `Shopify API error ${response.status}: ${errorBody.slice(0, 500)}`,
          );
        }

        // Wrap .json() in try/catch to handle malformed responses
        let data: T;
        try {
          data = (await response.json()) as T;
        } catch (jsonError: any) {
          const rawText = await response.text().catch(() => "[unreadable]");
          console.error(
            `[shopifyClient] JSON parse error on ${path}. Status: ${response.status}. Body sample: ${rawText.slice(0, 500)}. Error: ${jsonError.message}`,
          );
          throw new Error(
            `Shopify response JSON parse failed for ${path}: ${jsonError.message}`,
          );
        }

        const linkHeader = response.headers.get("Link");
        return { data, linkHeader };
      } catch (error) {
        if (attempt < MAX_RETRIES && this.isRetryableError(error)) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `[shopifyClient] Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.sleep(delay);
          continue;
        }
        throw error;
      }
    }

    throw new Error("[shopifyClient] Max retries exceeded");
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof TypeError) return true; // network errors
    if (error instanceof Error && error.message.includes("fetch")) return true;
    if (error instanceof Error && error.message.includes("ECONNRESET")) return true;
    if (error instanceof Error && error.message.includes("NS_ERROR_NET_RESET")) return true;
    if (error instanceof Error && error.message.includes("socket hang up")) return true;
    return false;
  }

  /** Compatibilità con la paginazione ordini, che espone solo page_info. */
  private parseNextPageInfo(linkHeader: string | null): string | undefined {
    const nextPageUrl = parseShopifyNextPageUrl(linkHeader);
    if (!nextPageUrl) return undefined;
    try {
      return new URL(nextPageUrl).searchParams.get("page_info") ?? undefined;
    } catch {
      return undefined;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
