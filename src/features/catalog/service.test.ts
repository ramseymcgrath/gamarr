import { describe, expect, it } from "vitest";

import type {
  CatalogRepository,
  IgdbPort
} from "@/features/catalog/ports";
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
      platformIds: [130]
    }
  ]
};

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
});
