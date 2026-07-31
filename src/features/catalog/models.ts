export interface Platform {
  id: number;
  name: string;
  abbreviation?: string;
  generation?: number;
  checksum?: string;
}

export interface PlatformView extends Platform {
  visible: boolean;
  aliases: string[];
  categoryIds?: string[];
  lastSyncedAt?: number;
}

export interface GameSearchResult {
  id: number;
  name: string;
  slug: string;
  summary: string | null;
  coverUrl: string | null;
  releaseYear: number | null;
  genres: string[];
  alternativeNames: string[];
  platformIds: number[];
}

export interface CatalogSearchInput {
  query: string;
  platformId: number;
}
