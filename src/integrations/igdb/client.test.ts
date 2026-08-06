import { describe, expect, it } from "vitest";

import {
  IgdbClient,
  IgdbUpstreamError,
  type IgdbExecutor,
  type IgdbRequest
} from "@/integrations/igdb/client";
import type { TokenPort } from "@/integrations/igdb/token-manager";

class FixedToken implements TokenPort {
  invalidations = 0;
  async getAccessToken() {
    return this.invalidations === 0 ? "old-token" : "new-token";
  }
  invalidate() {
    this.invalidations += 1;
  }
}

describe("IgdbClient", () => {
  it("filters searches by platform membership, not platform exclusivity", async () => {
    const requests: IgdbRequest[] = [];
    const executor: IgdbExecutor = {
      execute: async (_token, request) => {
        requests.push(request);
        return [];
      }
    };

    await new IgdbClient(new FixedToken(), executor).searchGames("Burnout 3", 8);

    // Apicalypse `{...}` is an EXACT array match — `platforms = {8}` is IGDB's
    // documented query for "PlayStation 2 exclusives" and hides every
    // multiplatform game. `(...)` is array inclusion, which is what we mean.
    expect(requests[0]!.where).toBe("platforms = (8)");
    expect(requests[0]!.where).not.toContain("{");
  });

  it("paginates platforms beyond one provider page", async () => {
    const requests: IgdbRequest[] = [];
    const executor: IgdbExecutor = {
      execute: async (_token, request) => {
        requests.push(request);
        return request.offset === 0
          ? Array.from({ length: 500 }, (_, id) => ({ id: id + 1, name: `Platform ${id + 1}` }))
          : [{ id: 501, name: "Platform 501", abbreviation: "P501" }];
      }
    };
    const client = new IgdbClient(new FixedToken(), executor);

    const platforms = await client.listPlatforms();

    expect(platforms).toHaveLength(501);
    expect(requests.map((request) => request.offset)).toEqual([0, 500]);
  });

  it("invalidates and retries once after an authentication failure", async () => {
    const token = new FixedToken();
    const seenTokens: string[] = [];
    const executor: IgdbExecutor = {
      execute: async (accessToken) => {
        seenTokens.push(accessToken);
        if (accessToken === "old-token") {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        }
        return [{
          id: 7346,
          name: "Metroid Prime 4: Beyond",
          slug: "metroid-prime-4-beyond",
          platforms: [130],
          genres: [{ name: "Adventure" }],
          alternative_names: [{ name: "Metroid Prime 4" }],
          release_dates: [{ platform: 130, y: 2025 }],
          cover: { image_id: "co123" }
        }];
      }
    };
    const client = new IgdbClient(token, executor);

    const games = await client.searchGames("Metroid", 130);

    expect(seenTokens).toEqual(["old-token", "new-token"]);
    expect(games).toEqual([
      expect.objectContaining({
        id: 7346,
        name: "Metroid Prime 4: Beyond",
        platformIds: [130],
        genres: ["Adventure"],
        alternativeNames: ["Metroid Prime 4"],
        releaseYear: 2025
      })
    ]);
  });

  it("retries a rate limit at most twice using provider delay", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const executor: IgdbExecutor = {
      execute: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("rate limited"), {
            status: 429,
            retryAfterMs: 25
          });
        }
        return [{ id: 1, name: "Platform" }];
      }
    };
    const client = new IgdbClient(new FixedToken(), executor, {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      }
    });

    await expect(client.listPlatforms()).resolves.toHaveLength(1);
    expect(attempts).toBe(3);
    expect(delays).toEqual([25, 25]);
  });

  it("retries an exhausted rate limit then reports it as 502", async () => {
    let attempts = 0;
    const executor: IgdbExecutor = {
      execute: async () => {
        attempts += 1;
        throw new IgdbUpstreamError(429, new Error("rate limited"));
      }
    };
    const client = new IgdbClient(new FixedToken(), executor, {
      sleep: async () => undefined
    });

    await expect(client.listPlatforms()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 502,
      upstreamStatus: 429
    });
    expect(attempts).toBe(3);
  });

  it("ranks popular games by rating count without a relevance search", async () => {
    const requests: IgdbRequest[] = [];
    const executor: IgdbExecutor = {
      execute: async (_token, request) => {
        requests.push(request);
        return [];
      }
    };

    await new IgdbClient(new FixedToken(), executor).popularGames(8, 24);

    expect(requests[0]!.sort).toEqual({
      field: "total_rating_count",
      direction: "desc"
    });
    // IGDB `search` imposes its own relevance ordering and cannot be
    // combined with an explicit sort.
    expect(requests[0]!.search).toBeUndefined();
    expect(requests[0]!.where).toBe(
      "platforms = (8) & total_rating_count != null"
    );
    expect(requests[0]!.where).not.toContain("{");
    expect(requests[0]!.limit).toBe(24);
  });

  it("maps popular games with the same shape as search results", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 7346,
        name: "Metroid Prime 4: Beyond",
        slug: "metroid-prime-4-beyond",
        platforms: [130],
        genres: [{ name: "Adventure" }],
        alternative_names: [{ name: "Metroid Prime 4" }],
        release_dates: [{ platform: 130, y: 2025 }],
        cover: { image_id: "co123" }
      }]
    };

    const games = await new IgdbClient(new FixedToken(), executor)
      .popularGames(130, 24);

    expect(games).toEqual([
      expect.objectContaining({
        id: 7346,
        name: "Metroid Prime 4: Beyond",
        platformIds: [130],
        genres: ["Adventure"],
        alternativeNames: ["Metroid Prime 4"],
        releaseYear: 2025,
        coverUrl:
          "https://images.igdb.com/igdb/image/upload/t_cover_big/co123.jpg"
      })
    ]);
  });
});
