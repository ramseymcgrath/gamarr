export type QueryReason =
  | "canonical"
  | "canonical-platform"
  | "alternate-platform";

export interface PlannedQuery {
  term: string;
  categories: string[];
  reason: QueryReason;
}

export interface Release {
  guid: string;
  title: string;
  indexerId: string;
  indexerName: string;
  downloadUrl: string;
  size: number | null;
  category: string | null;
  publishedAt: number;
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
