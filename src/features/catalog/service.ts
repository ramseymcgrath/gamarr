import type {
  CatalogSearchInput,
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";
import type {
  CatalogRepository,
  IgdbPort
} from "@/features/catalog/ports";
import {
  InFlightRefreshCoordinator,
  type RefreshCoordinator
} from "@/features/catalog/refresh-coordinator";
import { validationError } from "@/lib/errors";

const POPULAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POPULAR_LIMIT = 24;

export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly provider: IgdbPort | (() => IgdbPort),
    private readonly now: () => number = Date.now,
    private readonly coordinator: RefreshCoordinator =
      new InFlightRefreshCoordinator()
  ) {}

  async testConnection(): Promise<void> {
    await this.getProvider().testConnection();
  }

  async syncPlatforms(): Promise<PlatformView[]> {
    const platforms = await this.getProvider().listPlatforms();
    this.repository.upsertPlatforms(platforms, this.now());
    return this.repository.listPlatforms();
  }

  listPlatforms(): PlatformView[] {
    return this.repository.listPlatforms();
  }

  setPlatformVisibility(
    id: number,
    visible: boolean,
    aliases: string[]
  ): void {
    if (!this.repository.getPlatform(id)) {
      throw validationError("Platform does not exist");
    }
    this.repository.setPlatformVisibility(
      id,
      visible,
      [...new Set(aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean))]
    );
  }

  async search(input: CatalogSearchInput): Promise<GameSearchResult[]> {
    const query = input.query.trim();
    if (query.length < 2 || query.length > 200) {
      throw validationError("Search query must be between 2 and 200 characters");
    }
    const platform = this.repository.getPlatform(input.platformId);
    if (!platform?.visible) {
      throw validationError("Select a visible platform before searching");
    }

    const games = (await this.getProvider().searchGames(query, input.platformId))
      .filter((game) => game.platformIds.includes(input.platformId));
    this.repository.upsertGames(games, this.now());
    return games;
  }

  async popular(platformId: number): Promise<GameSearchResult[]> {
    const platform = this.repository.getPlatform(platformId);
    if (!platform?.visible) {
      throw validationError("Select a visible platform before searching");
    }

    const cached = this.repository.getPopular(platformId);
    if (cached) {
      if (this.now() - cached.fetchedAt < POPULAR_TTL_MS) return cached.games;
      // Stale: serve what we have and refresh behind it. The rejection is
      // dropped deliberately — the caller already has a usable list, and an
      // unhandled rejection here would surface in the server logs as a crash.
      this.coordinator
        .run(platformId, () => this.refreshPopular(platformId))
        .catch(() => undefined);
      return cached.games;
    }

    // Cold: nothing to show, so a provider failure must reach the caller.
    await this.coordinator.run(
      platformId,
      () => this.refreshPopular(platformId)
    );
    return this.repository.getPopular(platformId)?.games ?? [];
  }

  private async refreshPopular(platformId: number): Promise<void> {
    const games = (
      await this.getProvider().popularGames(platformId, POPULAR_LIMIT)
    ).filter((game) => game.platformIds.includes(platformId));
    // Everything past this point is synchronous better-sqlite3 work; the only
    // await in this method is the network call above.
    const now = this.now();
    this.repository.upsertGames(games, now);
    this.repository.replacePopular(
      platformId,
      games.map((game) => game.id),
      now
    );
  }

  getGame(id: number): GameSearchResult | null {
    return this.repository.getGame(id);
  }

  private getProvider(): IgdbPort {
    return typeof this.provider === "function"
      ? this.provider()
      : this.provider;
  }
}
