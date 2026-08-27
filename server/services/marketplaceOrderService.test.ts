import { describe, expect, it } from "vitest";
import {
  isPersistedMarketplaceOrderBeforeImportCutoff,
  isShopifyOrderBeforeImportCutoff,
} from "./marketplaceOrderService";

describe("Shopify import cutoff", () => {
  const cutoff = "2026-09-01";

  it("blocca un created_at Shopify con data commerciale anteriore al cutoff", () => {
    expect(isShopifyOrderBeforeImportCutoff("2026-08-31T23:59:59+02:00", cutoff)).toBe(true);
  });

  it("accetta il primo ordine del cutoff e quelli successivi", () => {
    expect(isShopifyOrderBeforeImportCutoff("2026-09-01T00:00:00+02:00", cutoff)).toBe(false);
    expect(isShopifyOrderBeforeImportCutoff("2026-09-02T09:15:00+02:00", cutoff)).toBe(false);
  });

  it("protegge anche un ordine marketplace già persistito prima del cutoff", () => {
    expect(isPersistedMarketplaceOrderBeforeImportCutoff(new Date("2026-08-31T10:00:00.000Z"), cutoff)).toBe(true);
    expect(isPersistedMarketplaceOrderBeforeImportCutoff(new Date("2026-09-01T10:00:00.000Z"), cutoff)).toBe(false);
  });
});
