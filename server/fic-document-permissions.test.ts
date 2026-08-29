import { describe, expect, it } from "vitest";
import { checkFicIssuedDocumentsPermission } from "./fic-integration";

describe("FiC document permission probe", () => {
  it("esegue una GET filtrata per proforma senza emettere documenti", async () => {
    const calls: Array<{ url: string; config: any }> = [];
    const result = await checkFicIssuedDocumentsPermission(
      "secret-token",
      "12345",
      "proforma",
      async (url, config) => {
        calls.push({ url, config });
        return { status: 200, data: { data: [] } };
      },
    );

    expect(result).toEqual({ status: "ok", httpStatus: 200, message: "Accesso consentito" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api-v2.fattureincloud.it/c/12345/issued_documents",
      config: {
        headers: { Authorization: "Bearer secret-token" },
        params: { q: "type = 'proforma'", per_page: 1, page: 1 },
      },
    });
  });

  it("segnala il DDT negato senza riprovare né creare documenti", async () => {
    const result = await checkFicIssuedDocumentsPermission(
      "secret-token",
      "12345",
      "delivery_note",
      async () => ({ status: 403, data: { error: { message: "Forbidden" } } }),
    );

    expect(result).toEqual({
      status: "denied",
      httpStatus: 403,
      message: "Permesso negato da Fatture in Cloud",
    });
  });
});
