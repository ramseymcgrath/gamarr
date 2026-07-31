import { describe, expect, it, vi } from "vitest";

import { handleReleaseSearch } from "@/app/api/releases/handlers";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const policy = parseOriginPolicy("http://gamarr.local");

describe("release search HTTP handler", () => {
  it("parses a platform-scoped search and returns opaque source references", async () => {
    const search = vi.fn(async () => ({
      releases: [{
        title: "Game.NSW-GROUP",
        sources: [{ candidateId: "candidate", indexerName: "Indexer" }]
      }],
      warnings: []
    }));
    const response = await handleReleaseSearch(
      new Request("http://gamarr.local/api/releases/search", {
        method: "POST",
        headers: {
          host: "gamarr.local",
          origin: "http://gamarr.local",
          "content-type": "application/json"
        },
        body: JSON.stringify({ gameId: 1, platformId: 130 })
      }),
      { service: { search }, policy }
    );

    expect(search).toHaveBeenCalledWith({ gameId: 1, platformId: 130 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      releases: [{
        title: "Game.NSW-GROUP",
        sources: [{ candidateId: "candidate", indexerName: "Indexer" }]
      }],
      warnings: []
    });
  });

  it("rejects malformed identifiers and untrusted origins", async () => {
    const service = { search: vi.fn() };
    const malformed = await handleReleaseSearch(
      new Request("http://gamarr.local/api/releases/search", {
        method: "POST",
        headers: {
          host: "gamarr.local",
          origin: "http://gamarr.local",
          "content-type": "application/json"
        },
        body: JSON.stringify({ gameId: "one", platformId: 130 })
      }),
      { service, policy }
    );
    const hostile = await handleReleaseSearch(
      new Request("http://gamarr.local/api/releases/search", {
        method: "POST",
        headers: {
          host: "gamarr.local",
          origin: "http://attacker.test",
          "content-type": "application/json"
        },
        body: JSON.stringify({ gameId: 1, platformId: 130 })
      }),
      { service, policy }
    );

    expect(malformed.status).toBe(400);
    expect(hostile.status).toBe(403);
    expect(service.search).not.toHaveBeenCalled();
  });
});
