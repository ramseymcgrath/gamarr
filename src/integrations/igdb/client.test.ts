import { describe, expect, it } from "vitest";

import {
  IgdbClient,
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
});
