import { describe, expect, it } from "vitest";
import { getFicAuthorizationUrlForCompany } from "./fic-integration";

describe("FiC OAuth scopes", () => {
  it("richiede i permessi esistenti e quello di scrittura DDT", () => {
    const previousClientId = process.env.FATTUREINCLOUD_CLIENT_ID_EKETO_FOOD;
    const previousClientSecret = process.env.FATTUREINCLOUD_CLIENT_SECRET_EKETO_FOOD;
    const previousRedirectUri = process.env.FATTUREINCLOUD_REDIRECT_URI;

    process.env.FATTUREINCLOUD_CLIENT_ID_EKETO_FOOD = "test-client-id";
    process.env.FATTUREINCLOUD_CLIENT_SECRET_EKETO_FOOD = "test-client-secret";
    process.env.FATTUREINCLOUD_REDIRECT_URI = "https://example.test/api/oauth/fattureincloud/callback";

    try {
      const authorizationUrl = getFicAuthorizationUrlForCompany(
        "00000000-0000-0000-0000-000000000001",
      );
      const scopes = new URL(authorizationUrl).searchParams.get("scope")?.split(" ").sort();

      expect(scopes).toEqual([
        "entity.clients:a",
        "entity.clients:r",
        "issued_documents.delivery_notes:a",
        "issued_documents.proformas:a",
        "settings:r",
      ]);
    } finally {
      if (previousClientId === undefined) delete process.env.FATTUREINCLOUD_CLIENT_ID_EKETO_FOOD;
      else process.env.FATTUREINCLOUD_CLIENT_ID_EKETO_FOOD = previousClientId;
      if (previousClientSecret === undefined) delete process.env.FATTUREINCLOUD_CLIENT_SECRET_EKETO_FOOD;
      else process.env.FATTUREINCLOUD_CLIENT_SECRET_EKETO_FOOD = previousClientSecret;
      if (previousRedirectUri === undefined) delete process.env.FATTUREINCLOUD_REDIRECT_URI;
      else process.env.FATTUREINCLOUD_REDIRECT_URI = previousRedirectUri;
    }
  });
});
