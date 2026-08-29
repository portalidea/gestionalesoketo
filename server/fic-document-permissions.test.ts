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

    expect(result).toEqual({
      status: "ok",
      httpStatus: 200,
      message: "Accesso consentito",
      requestUrl: "https://api-v2.fattureincloud.it/c/12345/issued_documents?q=type+%3D+%27proforma%27&per_page=1&page=1",
      responsePayload: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api-v2.fattureincloud.it/c/12345/issued_documents?q=type+%3D+%27proforma%27&per_page=1&page=1",
      config: {
        headers: { Authorization: "Bearer secret-token" },
      },
    });
  });

  it("segnala il DDT negato senza riprovare né creare documenti", async () => {
    const result = await checkFicIssuedDocumentsPermission(
      "secret-token",
      "12345",
      "delivery_note",
      async () => ({ status: 422, data: { error: { message: "Filtro non valido", field: "q" } } }),
    );

    expect(result).toEqual({
      status: "error",
      httpStatus: 422,
      message: "Risposta FiC non prevista (422)",
      requestUrl: "https://api-v2.fattureincloud.it/c/12345/issued_documents?q=type+%3D+%27delivery_note%27&per_page=1&page=1",
      responsePayload: { error: { message: "Filtro non valido", field: "q" } },
    });
  });
});
