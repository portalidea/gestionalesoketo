import { legacyApiCalls } from "../../drizzle/schema";
import { getDb } from "../db";

export type LegacyApiCallContext = {
  userId: string;
  retailerId: string;
};

/**
 * Registra una chiamata a un namespace tRPC deprecato.
 *
 * Il logger è volutamente best-effort: una tabella non disponibile, un vincolo
 * inatteso o un errore di rete non devono mai alterare l'esito della procedura
 * legacy chiamante.
 */
export function recordLegacyApiCall(
  procedure: string,
  context: LegacyApiCallContext,
): void {
  console.warn(
    "[LEGACY_CALL]",
    procedure,
    "userId=",
    context.userId,
    "retailerId=",
    context.retailerId,
    "timestamp=",
    new Date().toISOString(),
  );

  void (async () => {
    try {
      const database = await getDb();
      if (!database) {
        throw new Error("Database non disponibile per audit legacy");
      }
      await database.insert(legacyApiCalls).values({
        procedure,
        userId: context.userId,
        retailerId: context.retailerId,
      });
    } catch (error) {
      console.error("[LEGACY_CALL_AUDIT_ERROR]", procedure, error);
    }
  })();
}
