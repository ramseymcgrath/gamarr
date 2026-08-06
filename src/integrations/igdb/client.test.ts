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

  it("shows the earliest regional year for the platform, not the first listed", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 1,
        name: "Grand Theft Auto III",
        slug: "grand-theft-auto-iii",
        platforms: [8],
        // IGDB returns one entry per region in no guaranteed order. Taking the
        // first match reported GTA III as 2002 and Breath of the Wild as 2022
        // on the live shelf; the console's debut is the earliest of them.
        release_dates: [
          { platform: 8, y: 2003 },
          { platform: 6, y: 2000 },
          { platform: 8, y: 2001 },
          { platform: 8, y: 2002 }
        ]
      }]
    };

    const searched = await new IgdbClient(new FixedToken(), executor)
      .searchGames("Grand Theft Auto III", 8);
    const popular = await new IgdbClient(new FixedToken(), executor)
      .popularGames(8, 250);

    expect(searched[0]!.releaseYear).toBe(2001);
    // Both mappers share toGameSearchResult, so the shelf and search agree.
    expect(popular[0]!.releaseYear).toBe(2001);
  });

  it("reports no year when the platform has no dated entry", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 2,
        name: "Resident Evil 4",
        slug: "resident-evil-4",
        platforms: [8],
        release_dates: [{ platform: 6, y: 2007 }]
      }]
    };

    const games = await new IgdbClient(new FixedToken(), executor)
      .searchGames("Resident Evil 4", 8);

    expect(games[0]!.releaseYear).toBeNull();
  });

  it("requests the dates the debut rule needs", async () => {
    const requests: IgdbRequest[] = [];
    const executor: IgdbExecutor = {
      execute: async (_token, request) => {
        requests.push(request);
        return [];
      }
    };

    await new IgdbClient(new FixedToken(), executor).popularGames(8, 100);

    expect(requests[0]!.fields).toContain("first_release_date");
    expect(requests[0]!.fields).toContain("release_dates.date");
    expect(requests[0]!.limit).toBe(100);
  });

  it("reports the earliest dated platform release across regions", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 1,
        name: "Regional",
        slug: "regional",
        platforms: [8],
        first_release_date: 1_000_000_000,
        release_dates: [
          // Deliberately out of order, and one entry belongs to another
          // platform. A later regional release must not make a game look
          // like a port of itself.
          { platform: 8, y: 2002, date: 1_030_000_000 },
          { platform: 6, y: 2001, date: 1_000_000_000 },
          { platform: 8, y: 2001, date: 1_010_000_000 }
        ]
      }]
    };

    const games = await new IgdbClient(new FixedToken(), executor)
      .popularGames(8, 100);

    expect(games[0]).toMatchObject({
      firstReleaseDate: 1_000_000_000,
      platformReleaseDate: 1_010_000_000
    });
  });

  it("reports null dates when IGDB omits them", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 2,
        name: "Undated",
        slug: "undated",
        platforms: [8],
        // No first_release_date, and the platform entry carries no date —
        // the shape live IGDB returned for Resident Evil 4 on PS2.
        release_dates: [{ platform: 8, y: 2005 }]
      }]
    };

    const games = await new IgdbClient(new FixedToken(), executor)
      .popularGames(8, 100);

    expect(games[0]).toMatchObject({
      firstReleaseDate: null,
      platformReleaseDate: null
    });
  });
});
