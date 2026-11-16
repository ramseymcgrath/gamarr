/**
 * Internet Archive is searched directly (archive.org stalls Prowlarr's
 * User-Agent), so its results carry this pseudo-indexer id in place of a
 * Prowlarr indexer id. Prowlarr ids are numeric strings, so it cannot collide.
 */
export const INTERNET_ARCHIVE_INDEXER_ID = "internet-archive";
export const INTERNET_ARCHIVE_INDEXER_NAME = "Internet Archive";
export const COLLECTION_INDEXER_PREFIX = "collection:";

export function collectionIndexerId(hash: string): string {
  return `${COLLECTION_INDEXER_PREFIX}${hash}`;
}

export type QueryReason =
  | "canonical"
  | "canonical-platform"
  | "alternate-platform"
  | "serial";

export interface PlannedQuery {
  term: string;
  categories: string[];
  reason: QueryReason;
}

export interface Release {
  guid: string;
  title: string;
  protocol: "usenet" | "torrent";
  indexerId: string;
  indexerName: string;
  downloadUrl: string;
  magnetUrl: string | null;
  seeders: number | null;
  peers: number | null;
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
