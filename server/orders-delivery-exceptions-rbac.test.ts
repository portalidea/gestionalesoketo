import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { ordersRouter } from "./orders-router";
import type { TrpcContext } from "./_core/context";

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const ORDER_ID = "22222222-2222-2222-2222-222222222222";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";

function context(role: "operator" | "viewer"): TrpcContext {
  return {
    req: { headers: { "x-active-company-id": COMPANY_ID } } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id: USER_ID, role } as TrpcContext["user"],
  };
}

describe("consegna con eccezioni — RBAC", () => {
  it.each(["operator", "viewer"] as const)("rifiuta %s anche tramite chiamata diretta", async (role) => {
    const caller = ordersRouter.createCaller(context(role));
    const action = caller.confirmOrderDeliveryWithExceptions({
      orderId: ORDER_ID,
      exceptions: [{
        orderItemId: ITEM_ID,
        exceptionType: "no_stock_movement",
        reason: "Tentativo non autorizzato",
      }],
    });
    await expect(action).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
  });
});
