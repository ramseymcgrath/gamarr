import { describe, expect, it } from "vitest";

import {
  handleCatalogPopular,
  handleCatalogSearch,
  handleGetGame,
  handleSyncPlatforms
} from "@/app/api/catalog/handlers";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const service = {
  search: async ({ query, platformId }: { query: string; platformId: number }) => [
    { id: 1, name: query, platformIds: [platformId] }
  ],
  popular: async (platformId: number) => [
    { id: 2, name: "Popular", platformIds: [platformId] }
  ],
  getGame: (id: number) => id === 1 ? { id: 1, name: "Game" } : null,
  syncPlatforms: async () => [{ id: 130, name: "Switch" }]
};

describe("catalog HTTP handlers", () => {
  it("parses a platform-scoped catalog search", async () => {
    const response = await handleCatalogSearch(
      new Request("http://gamarr.local/api/catalog/search?query=Metroid&platformId=130"),
      { service }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 1, name: "Metroid", platformIds: [130] }
    ]);
  });

  it("returns the popular list for a platform", async () => {
    const response = await handleCatalogPopular(
      new Request("http://gamarr.local/api/catalog/popular?platformId=130"),
      { service }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual([
      { id: 2, name: "Popular", platformIds: [130] }
    ]);
  });

  it("rejects a popular request without a usable platform", async () => {
    for (const search of ["", "?platformId=0", "?platformId=abc", "?platformId=1.5"]) {
      const response = await handleCatalogPopular(
        new Request(`http://gamarr.local/api/catalog/popular${search}`),
        { service }
      );
      expect(response.status).toBe(400);
    }
  });

  it("returns not found for an unknown cached game", async () => {
    const response = await handleGetGame(999, { service });
    expect(response.status).toBe(404);
  });

  it("guards platform synchronization as a mutation", async () => {
    const response = await handleSyncPlatforms(
      new Request("http://gamarr.local/api/platforms/sync", {
        method: "POST",
        headers: {
          host: "gamarr.local",
          origin: "http://attacker.test",
          "content-type": "application/json"
        }
      }),
      {
        service,
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );

    expect(response.status).toBe(403);
  });
});
