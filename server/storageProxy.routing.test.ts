import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const vercelConfig = JSON.parse(readFileSync(`${root}vercel.json`, "utf8")) as { rewrites: Array<{ source: string; destination: string }> };
const handlerSource = readFileSync(`${root}vercel-handler/index.ts`, "utf8");

describe("storage proxy routing", () => {
  it("instrada gli asset persistenti alla function Vercel prima del fallback SPA", () => {
    expect(vercelConfig.rewrites).toContainEqual({ source: "/manus-storage/:path*", destination: "/api" });
    expect(handlerSource).toContain("storageProxyMod.registerStorageProxy(app)");
  });
});
