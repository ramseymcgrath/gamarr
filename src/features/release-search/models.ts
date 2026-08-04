export type QueryReason =
  | "canonical"
  | "canonical-platform"
  | "alternate-platform";

export interface PlannedQuery {
  term: string;
  categories: string[];
  reason: QueryReason;
}

export type ReleaseSourceType = "newznab" | "internet-archive";

export const INTERNET_ARCHIVE_INDEXER_ID = "internet-archive";
export const INTERNET_ARCHIVE_INDEXER_NAME = "Internet Archive";

export interface Release {
  guid: string;
  title: string;
  source: ReleaseSourceType;
  indexerId: string;
  indexerName: string;
  downloadUrl: string;
  size: number | null;
  category: string | null;
  /** `null` when the source published no usable date — never a 0 sentinel. */
  publishedAt: number | null;
}

export type MatchClass = "Strong" | "Possible" | "Conflicting";

export interface RankedRelease extends Release {
  match: MatchClass;
  score: number;
  supportingReasons: string[];
  conflictingReasons: string[];
  sources: Release[];
}

export interface NewznabSearchResult {
  releases: Release[];
  warnings: string[];
}

export interface InternetArchiveItem {
  identifier: string;
  title: string;
  detailsUrl: string;
  publishedAt: number | null;
  size: number | null;
  downloads: number;
}

export interface InternetArchiveFile {
  name: string;
  size: number | null;
  format: string | null;
  source: string | null;
}

/** The whole-item torrent Internet Archive derives for most items. */
export interface ItemTorrent {
  name: string;
  size: number | null;
}

export interface InternetArchiveSearchResult {
  items: InternetArchiveItem[];
  warnings: string[];
}
