import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ordersRouter } from "./orders-router";
import type { TrpcContext } from "./_core/context";

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const ORDER_ID = "22222222-2222-2222-2222-222222222222";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";
const EXCEPTION_TYPES = ["reallocated", "no_stock_movement", "partial_no_stock_movement"] as const;

function context(role: "operator" | "viewer"): TrpcContext {
  return {
    req: { headers: { "x-active-company-id": COMPANY_ID } } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id: USER_ID, role } as TrpcContext["user"],
  };
}

// Parsing the actual procedure schema avoids invoking company resolution or fulfillment.
const exceptionInput = ordersRouter.confirmOrderDeliveryWithExceptions._def.inputs[0] as z.ZodType;

function payload(exceptionType: typeof EXCEPTION_TYPES[number], reason = "Giacenza fisica verificata") {
  return {
    orderId: ORDER_ID,
    exceptions: [{ orderItemId: ITEM_ID, exceptionType, reason }],
  };
}

describe("consegna con eccezioni — RBAC", () => {
  describe.each(EXCEPTION_TYPES)("opzione %s", (exceptionType) => {
    it.each(["operator", "viewer"] as const)("rifiuta %s anche tramite chiamata diretta", async (role) => {
      const caller = ordersRouter.createCaller(context(role));
      const action = caller.confirmOrderDeliveryWithExceptions(payload(exceptionType, "Tentativo non autorizzato"));
      await expect(action).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
    });
  });
});

describe("consegna con eccezioni — validazione input", () => {
  it.each(EXCEPTION_TYPES)("accetta %s con motivo e mantiene il trim", (exceptionType) => {
    expect(exceptionInput.parse(payload(exceptionType, "  Giacenza fisica verificata  ")))
      .toEqual(payload(exceptionType));
  });

  describe.each(EXCEPTION_TYPES)("opzione %s", (exceptionType) => {
    it.each(["", "   ", "\n\t", "x".repeat(2_001)])("rifiuta un motivo vuoto o troppo lungo (caso %#)", (reason) => {
      expect(exceptionInput.safeParse(payload(exceptionType, reason)).success).toBe(false);
    });

    it("rifiuta il motivo mancante", () => {
      expect(exceptionInput.safeParse({
        orderId: ORDER_ID,
        exceptions: [{ orderItemId: ITEM_ID, exceptionType }],
      }).success).toBe(false);
    });
  });

  it("rifiuta consegne senza scelte e tipi non previsti", () => {
    expect(exceptionInput.safeParse({ orderId: ORDER_ID, exceptions: [] }).success).toBe(false);
    expect(exceptionInput.safeParse({
      orderId: ORDER_ID,
      exceptions: [{ orderItemId: ITEM_ID, exceptionType: "partial", reason: "Verifica" }],
    }).success).toBe(false);
  });
});
