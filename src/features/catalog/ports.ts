import type {
  GameSearchResult,
  Platform,
  PlatformView
} from "@/features/catalog/models";

export interface IgdbPort {
  testConnection(): Promise<void>;
  listPlatforms(): Promise<Platform[]>;
  searchGames(query: string, platformId: number): Promise<GameSearchResult[]>;
  popularGames(platformId: number, limit: number): Promise<GameSearchResult[]>;
}

export interface PopularGamesCache {
  games: GameSearchResult[];
  fetchedAt: number;
}

export interface CatalogRepository {
  listPlatforms(): PlatformView[];
  getPlatform(id: number): PlatformView | null;
  upsertPlatforms(values: Platform[], now: number): void;
  setPlatformVisibility(id: number, visible: boolean, aliases: string[]): void;
  upsertGames(values: GameSearchResult[], now: number): void;
  getGame(id: number): GameSearchResult | null;
  getPopular(platformId: number): PopularGamesCache | null;
  replacePopular(platformId: number, gameIds: number[], now: number): void;
}
