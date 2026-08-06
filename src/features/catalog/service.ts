import type {
  CatalogGameView,
  CatalogSearchInput,
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";
import { debutedOnPlatform } from "@/features/catalog/debut-window";
import type {
  CatalogRepository,
  IgdbPort,
  LibraryMembershipPort
} from "@/features/catalog/ports";
import {
  InFlightRefreshCoordinator,
  type RefreshCoordinator
} from "@/features/catalog/refresh-coordinator";
import { validationError } from "@/lib/errors";

const POPULAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Candidates requested per refresh. Filtering happens after ranking, so this
 * is a ceiling rather than the shelf length — every survivor is kept.
 *
 * Raised from 100 after live validation: PlayStation 2 returned 96 survivors
 * from 100, so the ceiling was binding and titles below the global top 100 —
 * Okami and Katamari Damacy among them — were never fetched rather than being
 * filtered out. IGDB's own per-request maximum is 500.
 */
const POPULAR_FETCH_LIMIT = 250;

export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly provider: IgdbPort | (() => IgdbPort),
    private readonly now: () => number = Date.now,
    private readonly coordinator: RefreshCoordinator =
      new InFlightRefreshCoordinator(),
    private readonly library?: LibraryMembershipPort
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

  async search(input: CatalogSearchInput): Promise<CatalogGameView[]> {
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
    return this.withLibraryMembership(games, input.platformId);
  }

  async popular(platformId: number): Promise<CatalogGameView[]> {
    const platform = this.repository.getPlatform(platformId);
    if (!platform?.visible) {
      throw validationError("Select a visible platform before searching");
    }

    const cached = this.repository.getPopular(platformId);
    if (cached) {
      if (this.now() - cached.fetchedAt < POPULAR_TTL_MS) {
        return this.withLibraryMembership(cached.games, platformId);
      }
      // Stale: serve what we have and refresh behind it. The rejection is
      // dropped deliberately — the caller already has a usable list, and an
      // unhandled rejection here would surface in the server logs as a crash.
      this.coordinator
        .run(platformId, () => this.refreshPopular(platformId))
        .catch(() => undefined);
      return this.withLibraryMembership(cached.games, platformId);
    }

    // Cold: nothing to show, so a provider failure must reach the caller.
    await this.coordinator.run(
      platformId,
      () => this.refreshPopular(platformId)
    );
    return this.withLibraryMembership(
      this.repository.getPopular(platformId)?.games ?? [],
      platformId
    );
  }

  /**
   * Library membership is resolved on every read rather than stored with the
   * cached shelf. The shelf has a seven day TTL, so a cached flag would leave
   * a game unbadged for up to a week after it was added.
   */
  private withLibraryMembership(
    games: GameSearchResult[],
    platformId: number
  ): CatalogGameView[] {
    const owned = new Set(this.library?.gameIdsOnPlatform(platformId) ?? []);
    return games.map((game) => ({ ...game, inLibrary: owned.has(game.id) }));
  }

  private async refreshPopular(platformId: number): Promise<void> {
    const games = (
      await this.getProvider().popularGames(platformId, POPULAR_FETCH_LIMIT)
    )
      .filter((game) => game.platformIds.includes(platformId))
      // IGDB has no per-platform popularity metric, so total_rating_count is
      // a global count: without this, a late port of a PC hit outranks the
      // console's own defining titles. Verified against live IGDB, the PS2
      // shelf led with Max Payne, Mafia and Age of Empires II.
      .filter((game) => debutedOnPlatform(game));
    // Everything past this point is synchronous better-sqlite3 work; the only
    // await in this method is the network call above.
    //
    // `games` is PopularCandidate[], which is assignable to GameSearchResult[].
    // The repository writes an explicit column list, so the two timestamps are
    // dropped on the way to SQLite and never reach the browser.
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
