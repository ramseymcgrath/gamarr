import type {
  CatalogSearchInput,
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";
import type {
  CatalogRepository,
  IgdbPort
} from "@/features/catalog/ports";
import { validationError } from "@/lib/errors";

export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly provider: IgdbPort,
    private readonly now: () => number = Date.now
  ) {}

  async testConnection(): Promise<void> {
    await this.provider.testConnection();
  }

  async syncPlatforms(): Promise<PlatformView[]> {
    const platforms = await this.provider.listPlatforms();
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

    const games = (await this.provider.searchGames(query, input.platformId))
      .filter((game) => game.platformIds.includes(input.platformId));
    this.repository.upsertGames(games, this.now());
    return games;
  }

  getGame(id: number): GameSearchResult | null {
    return this.repository.getGame(id);
  }
}
