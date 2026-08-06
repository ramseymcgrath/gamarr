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

/**
 * A popular-shelf candidate before the debut rule has been applied. The two
 * timestamps exist only to decide whether the game debuted on the selected
 * platform; they are never persisted and never reach the browser.
 */
export interface PopularCandidate extends GameSearchResult {
  firstReleaseDate: number | null;
  platformReleaseDate: number | null;
}

export interface CatalogSearchInput {
  query: string;
  platformId: number;
}
