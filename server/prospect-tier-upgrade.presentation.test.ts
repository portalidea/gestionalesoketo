import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("presentazione promozione prospect tier upgrade", () => {
  it("espone upgrade, amministrazione separata e rinuncia auditata senza attivare spedizione o omaggi", () => {
    const publicOrder = read("client/src/pages/InvitedRetailerOrder.tsx");
    const adminPromotions = read("client/src/pages/ProspectPromotions.tsx");
    const orderDetail = read("client/src/pages/OrderDetail.tsx");
    const promotionService = read("server/services/prospectPromotionService.ts");

    expect(publicOrder).toContain("Promozione primo ordine");
    expect(publicOrder).toContain("pricingTier");
    expect(adminPromotions).toContain("Promozioni prospect");
    expect(adminPromotions).toContain("upgrade di fascia");
    expect(orderDetail).toContain("Prezzi promozionali prospect congelati");
    expect(orderDetail).toContain("Rinuncia alle condizioni promo");
    expect(promotionService).toContain("tier_upgrade");
    expect(promotionService).not.toContain("benefitType: \"free_shipping\"");
    expect(promotionService).not.toContain("benefitType: \"gift_product\"");
  });
});
