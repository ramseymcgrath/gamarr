import { describe, expect, it } from "vitest";

import { DEBUT_WINDOW_SECONDS } from "@/features/catalog/debut-window";
import type {
  CatalogRepository,
  IgdbPort
} from "@/features/catalog/ports";
import { InFlightRefreshCoordinator } from "@/features/catalog/refresh-coordinator";
import { CatalogService } from "@/features/catalog/service";
import type {
  GameSearchResult,
  Platform
} from "@/features/catalog/models";
import { AppError } from "@/lib/errors";

class MemoryCatalogRepository implements CatalogRepository {
  platforms = new Map<number, Platform & { visible: boolean; aliases: string[] }>();
  games = new Map<number, GameSearchResult>();
  popular = new Map<number, { gameIds: number[]; fetchedAt: number }>();

  listPlatforms() {
    return [...this.platforms.values()];
  }

  getPlatform(id: number) {
    return this.platforms.get(id) ?? null;
  }

  upsertPlatforms(values: Platform[]) {
    for (const platform of values) {
      const existing = this.platforms.get(platform.id);
      this.platforms.set(platform.id, {
        ...platform,
        visible: existing?.visible ?? false,
        aliases: existing?.aliases ?? []
      });
    }
  }

  setPlatformVisibility(id: number, visible: boolean, aliases: string[]) {
    const platform = this.platforms.get(id);
    if (platform) this.platforms.set(id, { ...platform, visible, aliases });
  }

  upsertGames(values: GameSearchResult[]) {
    for (const game of values) this.games.set(game.id, game);
  }

  getGame(id: number) {
    return this.games.get(id) ?? null;
  }

  getPopular(platformId: number) {
    const entry = this.popular.get(platformId);
    if (!entry) return null;
    return {
      fetchedAt: entry.fetchedAt,
      games: entry.gameIds
        .map((id) => this.games.get(id))
        .filter((game): game is GameSearchResult => game !== undefined)
    };
  }

  replacePopular(platformId: number, gameIds: number[], now: number) {
    this.popular.set(platformId, { gameIds, fetchedAt: now });
  }
}

const provider: IgdbPort = {
  testConnection: async () => undefined,
  listPlatforms: async () => [
    { id: 130, name: "Nintendo Switch", abbreviation: "Switch" }
  ],
  searchGames: async () => [
    {
      id: 7346,
      name: "Metroid Prime 4: Beyond",
      slug: "metroid-prime-4-beyond",
      summary: null,
      coverUrl: null,
      releaseYear: 2025,
      genres: ["Adventure"],
      alternativeNames: ["Metroid Prime 4"],
      platformIds: [130]
    }
  ],
  popularGames: async () => [
    {
      id: 7346,
      name: "Metroid Prime 4: Beyond",
      slug: "metroid-prime-4-beyond",
      summary: null,
      coverUrl: null,
      releaseYear: 2025,
      genres: ["Adventure"],
      alternativeNames: ["Metroid Prime 4"],
      platformIds: [130],
      firstReleaseDate: null,
      platformReleaseDate: null
    }
  ]
};

const WEEK = 7 * 24 * 60 * 60 * 1000;

function visiblePlatform(repository: MemoryCatalogRepository) {
  repository.platforms.set(130, {
    id: 130,
    name: "Nintendo Switch",
    abbreviation: "Switch",
    visible: true,
    aliases: []
  });
}

function countingProvider(games = provider.popularGames) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    port: {
      ...provider,
      popularGames: async (platformId: number, limit: number) => {
        calls += 1;
        return games(platformId, limit);
      }
    } satisfies IgdbPort
  };
}

function candidate(
  id: number,
  overrides: Partial<{
    firstReleaseDate: number | null;
    platformReleaseDate: number | null;
  }> = {}
) {
  return {
    id,
    name: `Game ${id}`,
    slug: `game-${id}`,
    summary: null,
    coverUrl: null,
    releaseYear: null,
    genres: [],
    alternativeNames: [],
    platformIds: [130],
    firstReleaseDate: 1_000_000_000,
    platformReleaseDate: 1_000_000_000,
    ...overrides
  };
}

describe("CatalogService", () => {
  it("preserves local platform visibility and aliases during provider sync", async () => {
    const repository = new MemoryCatalogRepository();
    repository.platforms.set(130, {
      id: 130,
      name: "Old name",
      abbreviation: "NSW",
      visible: true,
      aliases: ["switch", "nsw"]
    });
    const service = new CatalogService(repository, provider, () => 1_000);

    await service.syncPlatforms();

    expect(repository.getPlatform(130)).toMatchObject({
      name: "Nintendo Switch",
      visible: true,
      aliases: ["switch", "nsw"]
    });
  });

  it("requires a visible selected platform before catalog search", async () => {
    const repository = new MemoryCatalogRepository();
    repository.platforms.set(130, {
      id: 130,
      name: "Nintendo Switch",
      abbreviation: "Switch",
      visible: false,
      aliases: []
    });
    const service = new CatalogService(repository, provider);

    await expect(service.search({ query: "Metroid", platformId: 130 }))
      .rejects.toBeInstanceOf(AppError);

    repository.setPlatformVisibility(130, true, ["switch"]);
    await expect(service.search({ query: "Metroid", platformId: 130 }))
      .resolves.toEqual([expect.objectContaining({ id: 7346 })]);
  });

  it("initializes the provider lazily for provider-backed operations", async () => {
    const repository = new MemoryCatalogRepository();
    let providerInitializations = 0;
    const service = new CatalogService(repository, () => {
      providerInitializations += 1;
      throw new AppError("VALIDATION", 400, "IGDB credentials are not configured");
    });

    expect(service.listPlatforms()).toEqual([]);
    expect(providerInitializations).toBe(0);
    await expect(service.syncPlatforms()).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400
    });
    expect(providerInitializations).toBe(1);
  });

  it("requires a visible platform before listing popular games", async () => {
    const repository = new MemoryCatalogRepository();
    repository.platforms.set(130, {
      id: 130,
      name: "Nintendo Switch",
      abbreviation: "Switch",
      visible: false,
      aliases: []
    });
    const service = new CatalogService(repository, provider);

    await expect(service.popular(130)).rejects.toBeInstanceOf(AppError);
    await expect(service.popular(999)).rejects.toBeInstanceOf(AppError);
  });

  it("fetches, caches and upserts popular games on a cold platform", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const counting = countingProvider();
    const service = new CatalogService(repository, counting.port, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 7346 })
    ]);

    expect(counting.calls).toBe(1);
    // The detail page reads games from the local table, so a popular card
    // whose game was never upserted would be a dead link.
    expect(repository.getGame(7346)).toMatchObject({ id: 7346 });
    expect(repository.popular.get(130)).toEqual({
      gameIds: [7346],
      fetchedAt: 1_000
    });
  });

  it("serves a fresh cache without calling the provider", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const counting = countingProvider();
    const service = new CatalogService(repository, counting.port, () => 1_000);

    await service.popular(130);
    await service.popular(130);

    expect(counting.calls).toBe(1);
  });

  it("drops popular games that are not on the requested platform", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => [{
        id: 42,
        name: "Wrong platform",
        slug: "wrong-platform",
        summary: null,
        coverUrl: null,
        releaseYear: null,
        genres: [],
        alternativeNames: [],
        platformIds: [8],
        firstReleaseDate: null,
        platformReleaseDate: null
      }]
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([]);
  });

  it("serves a stale cache immediately and refreshes once behind it", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    repository.games.set(1, {
      id: 1, name: "Stale", slug: "stale", summary: null, coverUrl: null,
      releaseYear: null, genres: [], alternativeNames: [], platformIds: [130]
    });
    repository.popular.set(130, { gameIds: [1], fetchedAt: 0 });

    const counting = countingProvider();
    const refreshes: Promise<void>[] = [];
    const inner = new InFlightRefreshCoordinator();
    const service = new CatalogService(
      repository,
      counting.port,
      () => WEEK + 1,
      {
        run: (key, task) => {
          const promise = inner.run(key, task);
          refreshes.push(promise);
          return promise;
        }
      }
    );

    const [first, second] = await Promise.all([
      service.popular(130),
      service.popular(130)
    ]);

    expect(first).toEqual([expect.objectContaining({ id: 1, name: "Stale" })]);
    expect(second).toEqual(first);

    await Promise.allSettled(refreshes);

    expect(counting.calls).toBe(1);
    expect(repository.popular.get(130)).toEqual({
      gameIds: [7346],
      fetchedAt: WEEK + 1
    });
  });

  it("keeps serving a stale cache when the refresh fails", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    repository.games.set(1, {
      id: 1, name: "Stale", slug: "stale", summary: null, coverUrl: null,
      releaseYear: null, genres: [], alternativeNames: [], platformIds: [130]
    });
    repository.popular.set(130, { gameIds: [1], fetchedAt: 0 });

    const refreshes: Promise<void>[] = [];
    const inner = new InFlightRefreshCoordinator();
    const service = new CatalogService(
      repository,
      {
        ...provider,
        popularGames: async () => {
          throw new AppError("UNAVAILABLE", 502, "IGDB request failed");
        }
      },
      () => WEEK + 1,
      {
        run: (key, task) => {
          const promise = inner.run(key, task);
          refreshes.push(promise);
          return promise;
        }
      }
    );

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 1 })
    ]);

    // Settled, not awaited bare: the service swallows this rejection so a
    // background failure never becomes an unhandled rejection.
    const [outcome] = await Promise.allSettled(refreshes);
    expect(outcome!.status).toBe("rejected");
    expect(repository.popular.get(130)).toEqual({ gameIds: [1], fetchedAt: 0 });
  });

  it("propagates a provider failure when there is no cache to fall back on", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => {
        throw new AppError("UNAVAILABLE", 502, "IGDB request failed");
      }
    }, () => 1_000);

    await expect(service.popular(130)).rejects.toMatchObject({ status: 502 });
  });

  it("serves an empty cached list without re-asking the provider", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    repository.popular.set(130, { gameIds: [], fetchedAt: 1_000 });
    const counting = countingProvider();
    const service = new CatalogService(repository, counting.port, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([]);
    expect(counting.calls).toBe(0);
  });

  it("drops a late port and keeps a console debut", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => [
        candidate(1),
        candidate(2, {
          platformReleaseDate: 1_000_000_000 + DEBUT_WINDOW_SECONDS + 1
        }),
        candidate(3, {
          platformReleaseDate: 1_000_000_000 + DEBUT_WINDOW_SECONDS
        })
      ]
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 3 })
    ]);
  });

  it("keeps a candidate whose dates IGDB omitted", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => [
        candidate(1, { firstReleaseDate: null }),
        candidate(2, { platformReleaseDate: null })
      ]
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 2 })
    ]);
  });

  it("caches every survivor with no count cap and keeps provider order", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const many = Array.from({ length: 90 }, (_, index) => candidate(index + 1));
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => many
    }, () => 1_000);

    await service.popular(130);

    expect(repository.popular.get(130)?.gameIds).toHaveLength(90);
    expect(repository.popular.get(130)?.gameIds.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("asks the provider for 250 candidates", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const limits: number[] = [];
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async (_platformId: number, limit: number) => {
        limits.push(limit);
        return [candidate(1)];
      }
    }, () => 1_000);

    await service.popular(130);

    expect(limits).toEqual([250]);
  });

  it("caches an empty list when every candidate is a late port", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    let calls = 0;
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => {
        calls += 1;
        return [candidate(1, {
          platformReleaseDate: 1_000_000_000 + DEBUT_WINDOW_SECONDS + 1
        })];
      }
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([]);
    // The empty result is cached, so a second visit must not re-ask IGDB.
    await expect(service.popular(130)).resolves.toEqual([]);
    expect(calls).toBe(1);
  });
});
